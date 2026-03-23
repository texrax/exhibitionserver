// YoloTD 視覺辨識裝置 — 輪詢 YoloTD 伺服器的 /status 端點，
// 偵測餐桌互動事件（夾菜、送達、掉落、中止）並發射 EventBus 事件

const axios = require("axios");
const BaseDevice = require("./BaseDevice");

class YoloDetectorDevice extends BaseDevice {
  constructor(id, config, eventBus) {
    super(id, config, eventBus);
    this.url = config.url || "http://localhost:8000";
    this.pollIntervalMs = config.pollIntervalMs || 500;
    this.cooldownMs = config.cooldownMs || 3000;
    this.timeout = config.timeout || 3000;

    this._pollTimer = null;
    this._lastEventId = null;
    this._lastEventType = null;
    this._lastEventTime = 0;
    this._consecutiveErrors = 0;
    this._isPolling = false;
  }

  async init() {
    try {
      await axios.get(`${this.url}/status`, { timeout: this.timeout });
      this._setStatus("online");
      console.log(`[${this.id}] YoloTD 已連線: ${this.url}`);
    } catch (err) {
      this._setStatus("offline", `YoloTD 無法連線: ${err.message}`);
      console.warn(`[${this.id}] YoloTD 離線，等待 health check 重試`);
    }
    this._startPolling();
  }

  async execute(action, params = {}) {
    switch (action) {
      case "start":
        this._startPolling();
        return { polling: true };
      case "stop":
        this._stopPolling();
        return { polling: false };
      case "getLatestEvent":
        return {
          eventId: this._lastEventId,
          eventType: this._lastEventType,
          timestamp: this._lastEventTime,
        };
      default:
        throw new Error(`[${this.id}] 不支援的動作: ${action}`);
    }
  }

  getSupportedActions() {
    return [
      { action: "start", description: "開始輪詢 YoloTD" },
      { action: "stop", description: "停止輪詢 YoloTD" },
      { action: "getLatestEvent", description: "取得最新偵測事件" },
    ];
  }

  getStatus() {
    return {
      ...super.getStatus(),
      polling: this._pollTimer !== null,
      lastEventId: this._lastEventId,
      lastEventType: this._lastEventType,
      consecutiveErrors: this._consecutiveErrors,
      yoloUrl: this.url,
    };
  }

  async destroy() {
    this._stopPolling();
    await super.destroy();
  }

  // ---- 內部方法 ----

  _startPolling() {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(() => this._poll(), this.pollIntervalMs);
    console.log(`[${this.id}] 開始輪詢 (間隔 ${this.pollIntervalMs}ms)`);
  }

  _stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
      console.log(`[${this.id}] 停止輪詢`);
    }
  }

  async _poll() {
    if (this._isPolling) return;
    this._isPolling = true;

    try {
      const res = await axios.get(`${this.url}/status`, { timeout: this.timeout });
      this._consecutiveErrors = 0;

      // 離線恢復
      if (this.status !== "online") {
        this._setStatus("online");
        console.log(`[${this.id}] YoloTD 已恢復連線`);
      }

      const { analysis } = res.data;
      if (!analysis || !analysis.dining_events || analysis.dining_events.length === 0) {
        return;
      }

      this._processEvent(analysis.dining_events[0]);
    } catch (err) {
      this._consecutiveErrors++;
      if (this._consecutiveErrors >= 3 && this.status === "online") {
        this._setStatus("offline", `YoloTD 無回應: ${err.message}`);
        console.warn(`[${this.id}] YoloTD 連續 ${this._consecutiveErrors} 次失敗，標記離線`);
      }
    } finally {
      this._isPolling = false;
    }
  }

  _processEvent(event) {
    const { event_id, event_type, carried_food, completed, state, source_side, target_side } = event;

    const isTerminal = event_type === "deliver" || event_type === "drop" || event_type === "abort";

    // 過濾：只處理 pickup 和終態事件（deliver/drop/abort）
    if (isTerminal) {
      if (!completed) return;
    } else if (event_type === "pickup") {
      // pickup 只在全新 event_id 時觸發一次
      if (event_id === this._lastEventId) return;
    } else {
      // none 或其他狀態不處理
      return;
    }

    // 去重：同一個 event_id + event_type 不重複觸發
    if (event_id === this._lastEventId && event_type === this._lastEventType) {
      return;
    }

    // 冷卻檢查：防止動畫被連續覆蓋
    const now = Date.now();
    if (now - this._lastEventTime < this.cooldownMs) {
      // 只有終態事件（deliver/drop/abort）允許突破冷卻
      if (!isTerminal) return;
    }

    // 更新追蹤狀態
    this._lastEventId = event_id;
    this._lastEventType = event_type;
    this._lastEventTime = now;

    // 發射事件
    const data = {
      eventType: event_type,
      food: carried_food,
      event_id,
      state,
      source_side,
      target_side,
      completed: !!completed,
    };

    // 具體事件名稱（供場景 trigger 精確匹配）
    this.eventBus.publish(`${this.id}:${event_type}`, data);
    console.log(`[${this.id}] 事件: ${event_type} | 食物: ${carried_food || "無"} | 來源: ${source_side || "?"} → ${target_side || "?"}`);
  }
}

module.exports = YoloDetectorDevice;
