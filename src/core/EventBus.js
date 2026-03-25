// 中央事件匯流排 — 所有裝置與場景之間的通訊橋梁
// 基於 Node.js EventEmitter，提供日誌記錄與 WebSocket 廣播能力

const { EventEmitter } = require("events");

class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
    // 儲存最近事件供 Dashboard 查詢
    this._history = [];
    this._maxHistory = 200;
    // 連線中的 WebSocket Dashboard 客戶端
    this._wsClients = new Set();
  }

  /**
   * 發送事件到匯流排，同時記錄歷史並廣播給 Dashboard
   * @param {string} event  事件名稱，慣例格式 "deviceId:action"
   * @param {object} data   事件附帶資料
   */
  publish(event, data = {}) {
    const entry = {
      event,
      data,
      timestamp: Date.now(),
    };

    this._history.push(entry);
    if (this._history.length > this._maxHistory) {
      this._history.shift();
    }

    console.log(`[EventBus] ${event}`, JSON.stringify(data).substring(0, 120));

    // 通知所有本地監聽者
    this.emit(event, data);

    // 廣播給 Dashboard WebSocket 客戶端
    this._broadcastToWS(entry);
  }

  /**
   * 註冊 Dashboard WebSocket 連線
   */
  registerWSClient(ws) {
    this._wsClients.add(ws);
    ws.on("close", () => this._wsClients.delete(ws));
  }

  /**
   * 取得最近事件歷史
   */
  getHistory(limit = 50) {
    return this._history.slice(-limit);
  }

  _broadcastToWS(entry) {
    const msg = JSON.stringify({ type: "event", payload: entry });
    for (const ws of this._wsClients) {
      if (ws.readyState === 1) {
        ws.send(msg);
      }
    }
  }
}

module.exports = EventBus;
