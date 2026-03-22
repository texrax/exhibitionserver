// 裝置管理器 — 展演強固版
// 支援自動重連機制，確保展覽期間裝置斷線能自動恢復

const fs = require("fs");
const deviceTypes = require("../devices");

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

  // 💡 絕對穩定關鍵：背景重連機制
  _startHealthCheck() {
    if (this._reconnectTimer) return;

    this._reconnectTimer = setInterval(async () => {
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
    const device = this.devices.get(deviceId);
    if (!device) throw new Error(`裝置 "${deviceId}" 不存在`);
    
    // 💡 穩定性檢查：如果裝置目前斷線，執行前先噴警告
    if (device.getStatus().status !== "online") {
      console.warn(`[DeviceManager] ⚠️ 嘗試對離線裝置 ${deviceId} 執行動作，可能會失敗`);
    }
    
    return device.execute(action, params);
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