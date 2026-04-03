// 裝置管理器 — 展演強固版
// 支援自動重連機制，確保展覽期間裝置斷線能自動恢復

const fs = require("fs");
const path = require("path");
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
   * 讀取 config/wizlights.json 設定檔
   * @returns {Array|null} lights 陣列，檔案不存在或 MAC 未設定回傳 null
   */
  _loadWizConfig() {
    const configPath = path.resolve(__dirname, "../../config/wizlights.json");
    try {
      const raw = fs.readFileSync(configPath, "utf-8");
      const config = JSON.parse(raw);
      // 如果所有 MAC 都還是 TODO，視為未設定
      if (!config.lights || config.lights.every((l) => l.mac === "TODO")) return null;
      return config.lights;
    } catch {
      return null;
    }
  }

  /**
   * 自動掃描區域網路上的 Wiz 燈泡
   * 若 config/wizlights.json 存在且 MAC 已填入，依設定固定身份註冊
   * 否則 fallback 舊邏輯（依 MAC 排序）
   */
  async _discoverWizLights() {
    console.log("[DeviceManager] 🔍 掃描 Wiz 燈泡...");

    // 多輪掃描取聯集
    let allFound = new Map(); // MAC → { ip, mac, state }
    let prevCount = -1;

    for (let round = 0; round < 3; round++) {
      const lights = await WizLightDevice.discover(3000);
      for (const light of lights) {
        allFound.set(light.mac, light);
      }
      console.log(`[DeviceManager] 掃描第 ${round + 1} 輪：本輪 ${lights.length} 顆，累計 ${allFound.size} 顆`);
      if (allFound.size === prevCount && allFound.size > 0) break;
      prevCount = allFound.size;
    }

    const mergedLights = [...allFound.values()];

    if (mergedLights.length === 0) {
      console.log("[DeviceManager] 未發現 Wiz 燈泡");
      return;
    }

    // 移除已註冊的 WizLightDevice
    for (const [id, device] of this.devices) {
      if (device instanceof WizLightDevice) {
        await device.destroy();
        this.devices.delete(id);
      }
    }

    const wizConfig = this._loadWizConfig();

    if (wizConfig) {
      // === 固定身份模式 ===
      const foundByMac = new Map(mergedLights.map((l) => [l.mac, l]));
      let unknownIdx = 0;

      // 註冊 config 裡的燈
      for (const entry of wizConfig) {
        const light = foundByMac.get(entry.mac);
        if (light) {
          console.log(`[DeviceManager] 💡 ${entry.id} (${entry.label || entry.id}) → ${light.ip} (MAC: ${entry.mac}, group: ${entry.group})`);
          await this.register(entry.id, "WizLightDevice", {
            ip: light.ip, port: 38899, timeout: 2000,
            mac: entry.mac, group: entry.group, label: entry.label, canChangeColor: entry.canChangeColor,
          });
          foundByMac.delete(entry.mac);
        } else {
          console.warn(`[DeviceManager] ⚠️ config 中的 ${entry.id} (MAC: ${entry.mac}) 未掃到`);
        }
      }

      // 掃到但不在 config 裡的燈 → fallback
      for (const [mac, light] of foundByMac) {
        unknownIdx++;
        const id = `wizlight_unknown_${unknownIdx}`;
        console.warn(`[DeviceManager] ⚠️ 未知燈泡: ${id} → ${light.ip} (MAC: ${mac})`);
        await this.register(id, "WizLightDevice", {
          ip: light.ip, port: 38899, timeout: 2000, mac,
        });
      }
    } else {
      // === Fallback：舊邏輯，依 MAC 排序 ===
      mergedLights.sort((a, b) => a.mac.localeCompare(b.mac));
      for (let i = 0; i < mergedLights.length; i++) {
        const { ip, mac } = mergedLights[i];
        const id = `wizlight_${i + 1}`;
        console.log(`[DeviceManager] 💡 發現 Wiz: ${id} → ${ip} (MAC: ${mac})`);
        await this.register(id, "WizLightDevice", { ip, port: 38899, timeout: 2000, mac });
      }
    }

    this.eventBus.publish("wiz:discovered", { count: mergedLights.length, lights: mergedLights });
  }

  // 💡 絕對穩定關鍵：背景重連機制
  _startHealthCheck() {
    if (this._reconnectTimer) return;

    this._reconnectTimer = setInterval(async () => {
      // 如果有 Wiz 燈泡離線或完全沒有，重新掃描補齊
      const wizDevices = [...this.devices.values()].filter((d) => d instanceof WizLightDevice);
      const allOnline = wizDevices.every((d) => d.getStatus().status === "online");
      if (wizDevices.length === 0 || !allOnline) {
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
    // WiZ 群組指令
    const wizGroupMap = {
      wizlight_all: null,
      wizlight_spotlights: "spotlights",
      wizlight_bulbs: "bulbs",
    };

    if (deviceId in wizGroupMap) {
      return this._executeOnWizGroup(wizGroupMap[deviceId], action, params);
    }

    const device = this.devices.get(deviceId);
    if (!device) throw new Error(`裝置 "${deviceId}" 不存在`);

    // 💡 穩定性檢查：如果裝置目前斷線，執行前先噴警告
    if (device.getStatus().status !== "online") {
      console.warn(`[DeviceManager] ⚠️ 嘗試對離線裝置 ${deviceId} 執行動作，可能會失敗`);
    }

    return device.execute(action, params);
  }

  /**
   * 對指定群組的 Wiz 燈泡執行動作
   * @param {string|null} group - 群組名稱，null 表示全部
   */
  async _executeOnWizGroup(group, action, params) {
    const wizDevices = [...this.devices.entries()]
      .filter(([, d]) => d instanceof WizLightDevice)
      .filter(([, d]) => group === null || d.group === group);

    const label = group ? `wizlight_${group}` : "wizlight_all";

    if (wizDevices.length === 0) {
      console.warn(`[DeviceManager] ⚠️ 群組 ${label} 沒有已連線的 Wiz 燈泡`);
      return [];
    }

    console.log(`[DeviceManager] 💡 ${label} → ${action} (${wizDevices.length} 顆燈)`);
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