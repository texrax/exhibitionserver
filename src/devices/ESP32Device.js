// ESP32Device.js - 展覽絕對穩定版
const axios = require("axios");
const BaseDevice = require("./BaseDevice");

class ESP32Device extends BaseDevice {
  constructor(id, config, eventBus) {
    super(id, config, eventBus);
    this.baseUrl = `http://${config.ip || "172.20.10.2"}`;
    // 💡 暴力鎖定超時為 5 秒，無視任何外部設定
    this.timeout = 5000; 
  }

  async execute(action, params = {}) {
    // 展覽模式下，我們只用 setMode，不使用會塞車的 setColor
    if (action === "setMode" || action === "off") {
      return this._sendMode(params.mode || "standby", params.color);
    }
    if (action === "flashEffect") {
      // 這裡改為送出指令讓 ESP32 自己閃，不再由電腦控制頻率
      return this._sendMode("blink", params.color);
    }
  }

  async _sendMode(mode, color = null) {
    try {
      const payload = { mode };
      if (color) payload.color = color;

      console.log(`[${this.id}] 🚀 發送指令: ${mode}`);
      
      await axios.post(`${this.baseUrl}/light/mode`, payload, { 
        timeout: this.timeout, // 使用 5000ms
        headers: { 'Content-Type': 'application/json' }
      });
      
      this._setStatus("online");
    } catch (err) {
      this._setStatus("error", err.message);
      console.error(`[${this.id}] ❌ 通訊失敗: ${err.message}`);
    }
  }

  // 刪除原本的 _startFlashEffect 和 _setColor，因為它們是當機元兇
}
module.exports = ESP32Device;