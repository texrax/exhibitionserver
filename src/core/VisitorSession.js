// 訪客互動狀態追蹤 — 記錄單一訪客在展場的互動歷程
// 監聽 scene:finished 事件，追蹤選日子和夾菜兩個互動

const DAY_NAMES = {
  1: "星期一",
  2: "星期二",
  3: "星期三",
  4: "星期四",
  5: "星期五",
  6: "星期六",
  7: "星期日",
};

// 狀態機：IDLE → INTERACTING → READY_TO_CHAT → CHATTING → IDLE
const STATE = {
  IDLE: "idle",
  INTERACTING: "interacting",
  READY_TO_CHAT: "ready_to_chat",
  CHATTING: "chatting",
};

class VisitorSession {
  /**
   * @param {EventBus} eventBus
   */
  constructor(eventBus) {
    this.eventBus = eventBus;
    this.state = STATE.IDLE;

    // 選日子互動追蹤
    this.dayHistory = []; // 每次嘗試的天數 [3, 1, 5, 3]
    this.dayAttempts = 0;
    this.lastDay = null;

    // 夾菜互動追蹤
    this.foodsDelivered = []; // ["vegetable", "beef"]

    // 監聽場景完成事件
    this._onSceneFinished = this._onSceneFinished.bind(this);
    this.eventBus.on("scene:finished", this._onSceneFinished);

    console.log("[VisitorSession] 初始化完成，等待訪客互動...");
  }

  /**
   * 處理場景完成事件
   */
  _onSceneFinished(data) {
    const sceneName = data.scene;
    if (!sceneName) return;

    // 已經準備好聊天或正在聊天中，不再追蹤
    if (this.state === STATE.READY_TO_CHAT || this.state === STATE.CHATTING) {
      return;
    }

    // 選日子場景：play_day_1 ~ play_day_7
    const dayMatch = sceneName.match(/^play_day_(\d)$/);
    if (dayMatch) {
      const dayNum = parseInt(dayMatch[1], 10);
      this.dayHistory.push(dayNum);
      this.dayAttempts++;
      this.lastDay = dayNum;

      if (this.state === STATE.IDLE) {
        this.state = STATE.INTERACTING;
      }

      console.log(
        `[VisitorSession] 選日子: ${DAY_NAMES[dayNum]} (第 ${this.dayAttempts} 次嘗試)`
      );

      this._checkCompletion();
      return;
    }

    // 夾菜場景：yolo_deliver_vegetable / yolo_deliver_beef
    const foodMatch = sceneName.match(/^yolo_deliver_(.+)$/);
    if (foodMatch) {
      const food = foodMatch[1];
      if (!this.foodsDelivered.includes(food)) {
        this.foodsDelivered.push(food);
      }

      if (this.state === STATE.IDLE) {
        this.state = STATE.INTERACTING;
      }

      console.log(`[VisitorSession] 夾菜: ${food}`);

      this._checkCompletion();
    }
  }

  /**
   * 檢查是否兩個互動都完成了
   */
  _checkCompletion() {
    if (this.dayHistory.length > 0 && this.foodsDelivered.length > 0) {
      this.state = STATE.READY_TO_CHAT;
      console.log("[VisitorSession] ✅ 兩個互動已完成，準備進入聊天");
      this.eventBus.publish("visitor:ready_to_chat", this.getInteractionSummary());
    }
  }

  /**
   * 取得互動摘要（供 ChatManager 組裝 prompt）
   */
  getInteractionSummary() {
    return {
      dayChosen: this.lastDay,
      dayChosenName: DAY_NAMES[this.lastDay] || `第${this.lastDay}天`,
      dayAttempts: this.dayAttempts,
      dayHistory: this.dayHistory.map((d) => DAY_NAMES[d] || `第${d}天`),
      // 星期三是正確答案
      foundCorrectDay: this.lastDay === 3,
      triedWrongDays: this.dayHistory.filter((d) => d !== 3).length,
      foodsDelivered: this.foodsDelivered,
    };
  }

  /**
   * 標記進入聊天狀態
   */
  startChatting() {
    this.state = STATE.CHATTING;
    console.log("[VisitorSession] 進入聊天狀態");
  }

  /**
   * 重置 session，準備接待下一位訪客
   */
  reset() {
    this.state = STATE.IDLE;
    this.dayHistory = [];
    this.dayAttempts = 0;
    this.lastDay = null;
    this.foodsDelivered = [];
    console.log("[VisitorSession] 🔄 Session 已重置，等待下一位訪客");
    this.eventBus.publish("visitor:session_reset", {});
  }

  /**
   * 取得當前狀態（供 API 查詢）
   */
  getStatus() {
    return {
      state: this.state,
      ...this.getInteractionSummary(),
    };
  }
}

module.exports = VisitorSession;