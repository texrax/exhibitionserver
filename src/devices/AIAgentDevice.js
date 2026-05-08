// AI Agent 裝置 — Node.js 端的 WS 客戶端，連到外部 Python agent 服務
// Python 服務負責：C230 RTSP 視訊感知 + USB mic STT + VAD
// 接收 Python 端事件後重新 publish 到 EventBus（前綴 agent:），
// 並接收 Node.js 端命令轉發給 Python（startListening / stopListening / setMode）

const WebSocket = require("ws");
const BaseDevice = require("./BaseDevice");

class AIAgentDevice extends BaseDevice {
  constructor(id, config, eventBus) {
    super(id, config, eventBus);
    this.url = config.url || "ws://localhost:9000/agent";
    this.reconnectIntervalMs = config.reconnectIntervalMs || 5000;
    this._ws = null;
    this._reconnectTimer = null;
    this._lastEvents = {
      speech: null,
      gesture: null,
      gaze: null,
    };
  }

  async init() {
    this._connect();
  }

  async execute(action, params = {}) {
    switch (action) {
      case "startListening":
      case "stopListening":
      case "setMode":
      case "pauseVision":
      case "resumeVision":
        return this._sendCommand(action, params);
      case "getStatus":
        return this.getStatus();
      default:
        throw new Error(`[${this.id}] 不支援的動作: ${action}`);
    }
  }

  getSupportedActions() {
    return [
      { action: "startListening", params: {}, description: "啟用 USB mic STT 監聽（第四階段使用）" },
      { action: "stopListening", params: {}, description: "停止 STT 監聽" },
      { action: "setMode", params: { mode: "string" }, description: "切換 agent 模式: idle | passive | active" },
      { action: "pauseVision", params: {}, description: "暫停 C230 視覺偵測（不抓 frame / 不跑 mediapipe）" },
      { action: "resumeVision", params: {}, description: "恢復 C230 視覺偵測" },
    ];
  }

  getStatus() {
    return {
      ...super.getStatus(),
      wsConnected: this._ws?.readyState === WebSocket.OPEN,
      url: this.url,
      lastEvents: this._lastEvents,
    };
  }

  async destroy() {
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this._ws) {
      this._ws.removeAllListeners();
      this._ws.close();
      this._ws = null;
    }
    await super.destroy();
  }

  // ==================================================
  //  WebSocket 連線管理
  // ==================================================

  _connect() {
    this._setStatus("connecting");
    let ws;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      console.error(`[${this.id}] WebSocket 建立失敗: ${err.message}`);
      this._setStatus("error", err.message);
      this._scheduleReconnect();
      return;
    }
    this._ws = ws;

    ws.on("open", () => {
      console.log(`[${this.id}] 已連到 Python agent: ${this.url}`);
      this._setStatus("online");
    });

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        this._handleAgentEvent(msg);
      } catch (err) {
        console.error(`[${this.id}] 訊息解析失敗: ${err.message}`);
      }
    });

    ws.on("close", () => {
      if (this._ws === ws) {
        this._ws = null;
        this._setStatus("offline");
        this._scheduleReconnect();
      }
    });

    ws.on("error", (err) => {
      // 連不上時 ws 套件會同時 emit error + close，為避免雜訊降級為 debug
      console.log(`[${this.id}] Python agent 暫時無法連線: ${err.message}`);
    });
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, this.reconnectIntervalMs);
  }

  // ==================================================
  //  事件轉發
  // ==================================================

  /**
   * 把 Python 端的事件 publish 到 EventBus
   * Python 端 message 格式：{ type: "speech" | "gesture" | "gaze", data: {...} }
   */
  _handleAgentEvent(msg) {
    const { type, data } = msg;
    if (!type) return;

    if (type in this._lastEvents) {
      this._lastEvents[type] = { ...data, _at: Date.now() };
    }

    // 統一前綴 agent: 讓 AgentController 訂閱
    this.eventBus.publish(`agent:${type}`, data);
  }

  _sendCommand(command, params) {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      const err = `Python agent 未連線（${this.url}）`;
      this.eventBus.publish(`${this.id}:command_failed`, { command, error: err });
      throw new Error(err);
    }
    this._ws.send(JSON.stringify({ command, params }));
    return { sent: true, command };
  }
}

module.exports = AIAgentDevice;
