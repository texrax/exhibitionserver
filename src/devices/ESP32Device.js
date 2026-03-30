// ESP32 WiFi 燈光控制裝置 - 展演強固版
// 優化了 Timeout 處理與網路容錯機制

const axios = require("axios");
const BaseDevice = require("./BaseDevice");

class ESP32Device extends BaseDevice {
  constructor(id, config, eventBus) {
    super(id, config, eventBus);
    this.baseUrl = `http://${config.ip || "192.168.4.1"}`;

    // 💡 修正 1：將預設 Timeout 從 200ms 提高到 3000ms (3秒)
    // 展場環境 WiFi 較不穩，給予足夠時間讓指令送達
    this.timeout = config.timeout || 3000;

    this._lastSentTime = 0;
    this._throttleMs = config.throttleMs || 150; // 稍微放寬節流時間
    this._animationInterval = null;

    // 紀錄連續失敗次數，避免刷爆 Log
    this._failCount = 0;
  }

  async init() {
    try {
      // 初始化時嘗試握手，確認設備在線
      await axios.get(`${this.baseUrl}/`, { timeout: 2000 });
      this._setStatus("online");
      console.log(`[${this.id}] ✅ ESP32 連線成功 (${this.baseUrl})`);
    } catch (err) {
      this._setStatus("offline");
      console.warn(`[${this.id}] ⚠️ ESP32 目前離線，待觸發時自動重連`);
    }
  }

  async execute(action, params = {}) {
    // 每次執行動作前檢查 IP 是否存在
    if (!this.baseUrl) throw new Error("設備 IP 未設定");

    switch (action) {
      case "setMode":
        return this._setMode(params.mode, params.color);
      case "setColor":
        return this._setColor(params.r, params.g, params.b);
      case "off":
        return this._setMode("off", { r: 0, g: 0, b: 0 });
      case "flashEffect":
        return this._startFlashEffect(params.color);
      case "stopEffect":
        return this._stopEffect();
      default:
        throw new Error(`[${this.id}] 不支援的動作: ${action}`);
    }
  }

  // ---- 私有方法 ----

  async _setMode(mode, color = null) {
    try {
      const payload = { mode };
      if (color) payload.color = color;

      // 💡 修正 2：加入 POST 請求的完整處理
      const response = await axios.post(`${this.baseUrl}/light/mode`, payload, {
        timeout: this.timeout,
        headers: { 'Content-Type': 'application/json' }
      });

      if (response.status === 200) {
        this._setStatus("online");
        this._failCount = 0;
        this.eventBus.publish(`${this.id}:modeChanged`, { mode, color });
      }
    } catch (err) {
      this._failCount++;
      // 只有連續失敗多次才標記為 Error
      if (this._failCount > 3) {
        this._setStatus("error", `連線超時: ${err.message}`);
      }
      console.error(`[${this.id}] ❌ 指令傳送失敗 (${mode}): ${err.message}`);
    }
  }

  async _setColor(r, g, b) {
    const now = Date.now();
    if (now - this._lastSentTime < this._throttleMs) return;
    this._lastSentTime = now;

    try {
      // 💡 修正 3：確保目標路由與 ESP32 程式碼一致
      // 如果你的 ESP32 只有 /light/mode，我們統一改用那個
      await axios.post(
        `${this.baseUrl}/light/mode`,
        { mode: "solid", color: { r, g, b } },
        { timeout: this.timeout }
      );
      this._setStatus("online");
    } catch (err) {
      // 節流模式下的錯誤通常較不重要，不干擾主邏輯
      this._setStatus("error", "Color update failed");
    }
  }

  _startFlashEffect(color) {
    this._stopEffect();
    // 初始清空
    this._setMode("blink", color);

    // 💡 修正 4：flashEffect 的頻率不要太高，150ms 較為保險
    this._animationInterval = setInterval(() => {
      const loudness = 0.4 + Math.random() * 0.6;
      const r = Math.min(255, Math.floor(color.r * loudness));
      const g = Math.min(255, Math.floor(color.g * loudness));
      const b = Math.min(255, Math.floor(color.b * loudness));
      this._setColor(r, g, b);
    }, 150);
  }

  _stopEffect() {
    if (this._animationInterval) {
      clearInterval(this._animationInterval);
      this._animationInterval = null;
    }
  }

  getSupportedActions() {
    return [
      { action: "setMode", params: { mode: "string", color: "{ r, g, b }" }, description: "設定燈光模式" },
      { action: "setColor", params: { r: "number", g: "number", b: "number" }, description: "直接設定 RGB" },
      { action: "off", params: {}, description: "關閉燈光" },
      { action: "flashEffect", params: { color: "{ r, g, b }" }, description: "閃爍特效" },
      { action: "stopEffect", params: {}, description: "停止特效動畫" },
    ];
  }
}

module.exports = ESP32Device;
