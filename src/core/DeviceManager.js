// 裝置管理器 — 展演強固版
// 支援自動重連機制，確保展覽期間裝置斷線能自動恢復

const fs = require("fs");
const deviceTypes = require("../devices");
const WizLightDevice = require("../devices/WizLightDevice");

class DeviceManager {
  constructor(eventBus) {
    this.eventBus = eventBus;
    this.devices = new Map();
    // 💡 展演強化：自動檢查計時器
    this._reconnectTimer = null;
  }

  async loadFromConfig(configPath) {
    const raw = fs.readFileSync(configPath, "utf-8");
    const { devices } = JSON.parse(raw);

    for (const entry of devices) {
      await this.register(entry.id, entry.type, entry.config);
    }

    // 自動掃描 Wiz 燈泡
    await this._discoverWizLights();

    // 💡 啟動背景監控：每 10 秒檢查一次有沒有裝置「掉線」
    this._startHealthCheck();
  }

  async register(id, typeName, config) {
    const DeviceClass = deviceTypes[typeName];
    if (!DeviceClass) {
      console.error(`[DeviceManager] ✗ 未知類型: ${typeName}`);
      return;
    }

    const device = new DeviceClass(id, config, this.eventBus);
    this.devices.set(id, device);

    try {
      await device.init();
      console.log(`[DeviceManager] ✓ ${id} 初始化成功`);
    } catch (err) {
      // 就算失敗也沒關係，背景監控之後會自動重試
      console.warn(`[DeviceManager] ⚠️ ${id} 暫時離線，背景監控將自動嘗試重連`);
    }
  }

  /**
   * 自動掃描區域網路上的 Wiz 燈泡，動態註冊尚未存在的燈泡
   * MAC 地址作為穩定 ID，不怕 IP 變動
   */
  async _discoverWizLights() {
    console.log("[DeviceManager] 🔍 掃描 Wiz 燈泡...");
    const lights = await WizLightDevice.discover(3000);

    if (lights.length === 0) {
      console.log("[DeviceManager] 未發現 Wiz 燈泡");
      return;
    }

    // 移除 config 裡寫死的 WizLightDevice（用自動掃描取代）
    for (const [id, device] of this.devices) {
      if (device instanceof WizLightDevice) {
        await device.destroy();
        this.devices.delete(id);
      }
    }

    // 依 MAC 排序後依序註冊 wizlight_1, wizlight_2, ...
    lights.sort((a, b) => a.mac.localeCompare(b.mac));
    for (let i = 0; i < lights.length; i++) {
      const { ip, mac } = lights[i];
      const id = `wizlight_${i + 1}`;
      console.log(`[DeviceManager] 💡 發現 Wiz: ${id} → ${ip} (MAC: ${mac})`);
      await this.register(id, "WizLightDevice", { ip, port: 38899, timeout: 2000 });
    }

    this.eventBus.publish("wiz:discovered", { count: lights.length, lights });
  }

  // 💡 絕對穩定關鍵：背景重連機制
  _startHealthCheck() {
    if (this._reconnectTimer) return;

    this._reconnectTimer = setInterval(async () => {
      // 如果沒有任何 Wiz 燈泡在線，重新掃描
      const hasWiz = [...this.devices.values()].some((d) => d instanceof WizLightDevice);
      if (!hasWiz) {
        await this._discoverWizLights();
      }

      for (const [id, device] of this.devices) {
        // 如果裝置狀態不是 online，就嘗試重新調用 init()
        const status = device.getStatus();
        if (status.status !== "online") {
          try {
            console.log(`[DeviceManager] 🔄 正在嘗試重新連線: ${id}...`);
            await device.init();
          } catch (e) {
            // 靜默失敗，等待下一個循環
          }
        }
      }
    }, 10000); // 每 10 秒巡檢一次
  }

  get(id) {
    return this.devices.get(id);
  }

  async executeOnDevice(deviceId, action, params = {}) {
    // WiZ 群組指令：廣播到所有已發現的 WiZ 燈泡
    if (deviceId === "wizlight_all") {
      return this._executeOnAllWiz(action, params);
    }

    const device = this.devices.get(deviceId);
    if (!device) throw new Error(`裝置 "${deviceId}" 不存在`);
    
    // 💡 穩定性檢查：如果裝置目前斷線，執行前先噴警告
    if (device.getStatus().status !== "online") {
      console.warn(`[DeviceManager] ⚠️ 嘗試對離線裝置 ${deviceId} 執行動作，可能會失敗`);
    }
    
    return device.execute(action, params);
  }

  async _executeOnAllWiz(action, params) {
    const wizDevices = [...this.devices.entries()]
      .filter(([, d]) => d instanceof WizLightDevice);

    if (wizDevices.length === 0) {
      console.warn("[DeviceManager] ⚠️ 沒有已連線的 Wiz 燈泡");
      return [];
    }

    console.log(`[DeviceManager] 💡 wizlight_all → ${action} (${wizDevices.length} 顆燈)`);
    const results = await Promise.allSettled(
      wizDevices.map(([, device]) => device.execute(action, params))
    );
    return results;
  }

  getAllStatus() {
    return Array.from(this.devices.values()).map(d => d.getStatus());
  }

  async destroyAll() {
    if (this._reconnectTimer) clearInterval(this._reconnectTimer);
    for (const [id, device] of this.devices) {
      await device.destroy();
    }
    this.devices.clear();
  }
}

module.exports = DeviceManager;