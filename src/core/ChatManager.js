// 聊天管理器 — 管理 App WebSocket 連線、LLM 對話、輪次控制
// 負責組裝含互動上下文的 system prompt，控制對話節奏和收尾

const fs = require("fs");
const path = require("path");

class ChatManager {
  /**
   * @param {EventBus} eventBus
   * @param {VisitorSession} visitorSession
   * @param {ClaudeClient} claudeClient
   */
  constructor(eventBus, visitorSession, claudeClient) {
    this.eventBus = eventBus;
    this.visitorSession = visitorSession;
    this.claudeClient = claudeClient;

    // 載入角色設定
    const configPath = path.resolve(__dirname, "../../config/chat.json");
    this.config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

    // App WebSocket 連線（一次只有一個）
    this._appWs = null;

    // 對話狀態
    this._messages = []; // Claude 對話歷史 [{role, content}]
    this._turnCount = 0;
    this._chatActive = false;

    // 監聽互動完成事件
    this.eventBus.on("visitor:ready_to_chat", () => {
      this._notifyAppInteractionsComplete();
    });

    console.log(`[ChatManager] 初始化完成，角色: ${this.config.character.name}`);
  }

  /**
   * 處理新的 App WebSocket 連線
   * @param {WebSocket} ws
   */
  handleAppConnection(ws) {
    // 如果已有連線，關閉舊的
    if (this._appWs && this._appWs.readyState === 1) {
      console.log("[ChatManager] 關閉舊的 App 連線");
      this._appWs.close();
    }

    this._appWs = ws;
    console.log("[ChatManager] App 已連線");

    // 發送當前狀態
    this._send({
      type: "connected",
      payload: { sessionState: this.visitorSession.state },
    });

    // 如果互動已經完成，立即通知
    if (this.visitorSession.state === "ready_to_chat") {
      this._notifyAppInteractionsComplete();
    }

    // 處理來自 App 的訊息
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        this._handleAppMessage(msg);
      } catch (err) {
        console.error("[ChatManager] 解析 App 訊息失敗:", err.message);
        this._send({ type: "chat_error", payload: { message: err.message } });
      }
    });

    ws.on("close", () => {
      console.log("[ChatManager] App 已斷線");
      if (this._appWs === ws) {
        this._appWs = null;
      }
    });

    ws.on("error", (err) => {
      console.error("[ChatManager] App WebSocket 錯誤:", err.message);
    });
  }

  /**
   * 處理 App 發來的訊息
   */
  async _handleAppMessage(msg) {
    switch (msg.type) {
      case "chat_start":
        await this._startChat();
        break;

      case "chat_message":
        if (!msg.payload?.content) {
          this._send({ type: "chat_error", payload: { message: "訊息內容不能為空" } });
          return;
        }
        await this._handleUserMessage(msg.payload.content);
        break;

      case "chat_end":
        this._endChat("user_ended");
        break;

      default:
        console.log(`[ChatManager] 未知訊息類型: ${msg.type}`);
    }
  }

  /**
   * 開始聊天 — 產生角色的開場白
   */
  async _startChat() {
    if (this._chatActive) {
      console.log("[ChatManager] 聊天已在進行中");
      return;
    }

    this._chatActive = true;
    this._messages = [];
    this._turnCount = 0;
    this.visitorSession.startChatting();

    const systemPrompt = this._buildSystemPrompt();

    try {
      // 讓 Claude 產生開場白
      const greeting = await this.claudeClient.sendMessage(
        systemPrompt,
        [{ role: "user", content: "[系統：訪客拿起了手機，請用一句話自然地延續剛才的互動氛圍，像是隨口聊聊剛才的體驗，例如「剛剛那頓飯真不錯」之類的語氣]" }],
        this.config.llm.maxTokens
      );

      this._turnCount++;
      // 把開場白記錄到對話歷史（但用 assistant 角色）
      this._messages.push({ role: "user", content: "[系統：訪客拿起了手機，請用一句話自然地延續剛才的互動氛圍，像是隨口聊聊剛才的體驗，例如「剛剛那頓飯真不錯」之類的語氣]" });
      this._messages.push({ role: "assistant", content: greeting });

      this._send({
        type: "chat_message",
        payload: {
          role: "assistant",
          content: greeting,
          turnNumber: this._turnCount,
          isLastMessage: false,
        },
      });

      console.log(`[ChatManager] 開場白已發送 (turn ${this._turnCount})`);
    } catch (err) {
      console.error("[ChatManager] 產生開場白失敗:", err.message);
      this._send({ type: "chat_error", payload: { message: `開場白產生失敗: ${err.message}` } });
      this._chatActive = false;
    }
  }

  /**
   * 處理訪客發送的訊息
   */
  async _handleUserMessage(content) {
    if (!this._chatActive) {
      this._send({ type: "chat_error", payload: { message: "聊天尚未開始" } });
      return;
    }

    const { maxTurns } = this.config.limits;

    // 如果已到輪次上限，強制結束
    if (this._turnCount >= maxTurns) {
      this._endChat("turn_limit");
      return;
    }

    // 加入使用者訊息
    this._messages.push({ role: "user", content });

    const systemPrompt = this._buildSystemPrompt();

    try {
      const reply = await this.claudeClient.sendMessage(
        systemPrompt,
        this._messages,
        this.config.llm.maxTokens
      );

      this._turnCount++;
      this._messages.push({ role: "assistant", content: reply });

      const isLast = this._turnCount >= maxTurns;

      this._send({
        type: "chat_message",
        payload: {
          role: "assistant",
          content: reply,
          turnNumber: this._turnCount,
          isLastMessage: isLast,
        },
      });

      console.log(`[ChatManager] 回覆已發送 (turn ${this._turnCount}/${maxTurns})`);

      // 到上限自動結束
      if (isLast) {
        setTimeout(() => this._endChat("turn_limit"), 3000);
      }
    } catch (err) {
      console.error("[ChatManager] Claude 回覆失敗:", err.message);
      this._send({ type: "chat_error", payload: { message: `回覆失敗: ${err.message}` } });
    }
  }

  /**
   * 結束聊天
   */
  _endChat(reason) {
    if (!this._chatActive) return;

    this._chatActive = false;
    console.log(`[ChatManager] 聊天結束 (原因: ${reason})`);

    this._send({
      type: "chat_ended",
      payload: { reason },
    });

    // 5 秒後重置 session
    setTimeout(() => {
      this._messages = [];
      this._turnCount = 0;
      this.visitorSession.reset();
      this._send({ type: "session_reset", payload: {} });
    }, 5000);
  }

  /**
   * 組裝 system prompt — 核心邏輯
   */
  _buildSystemPrompt() {
    const { character, limits } = this.config;
    const summary = this.visitorSession.getInteractionSummary();

    // 基礎角色設定
    let prompt = `你是「${character.name}」。${character.backstory}\n\n`;
    prompt += `你的個性：${character.personality}\n\n`;

    // 注入互動上下文
    prompt += `## 剛才的互動紀錄\n`;
    prompt += `訪客剛剛跟你互動過：\n`;

    // 選日子的上下文
    if (summary.dayAttempts > 0) {
      prompt += `- 選日子：訪客嘗試了 ${summary.dayAttempts} 次，`;
      prompt += `依序選了 ${summary.dayHistory.join("、")}。`;
      if (summary.foundCorrectDay) {
        if (summary.dayAttempts === 1) {
          prompt += `太厲害了！一次就選中星期三（你們約好的日子）！\n`;
        } else {
          prompt += `最後終於找到星期三了（你們約好的日子），但之前選錯了 ${summary.triedWrongDays} 次。\n`;
        }
      } else {
        prompt += `到最後都沒找到星期三（你們約好的日子），最後選的是${summary.dayChosenName}。\n`;
      }
    }

    // 夾菜的上下文
    if (summary.foodsDelivered.length > 0) {
      const foodNames = summary.foodsDelivered.map((f) => {
        if (f === "vegetable") return "青菜";
        if (f === "beef") return "牛肉丸";
        return f;
      });
      prompt += `- 夾菜：訪客餵你吃了${foodNames.join("和")}。\n`;
    }

    prompt += `\n`;

    // 對話規則
    prompt += `## 對話規則\n`;
    prompt += `- 用繁體中文回覆\n`;
    prompt += `- 每次回覆控制在 ${limits.maxResponseLength} 字以內\n`;
    prompt += `- 語氣像在 LINE 上跟朋友聊天，自然口語化\n`;
    prompt += `- 對話要自然地結合剛才的互動經歷\n`;
    prompt += `- 不要用 emoji 表情符號\n`;
    prompt += `- 不要加括弧動作描述，例如（停頓一下）、（看著對方）\n`;
    prompt += `- 少用刪節號「...」，偶爾用一次就好\n`;

    // 輪次控制 — 漸進式自然收尾
    const { maxTurns } = limits;

    if (this._turnCount >= 9 && this._turnCount <= 11) {
      prompt += `\n## 對話節奏\n`;
      prompt += `對話已經聊了一陣子，你開始意識到時間在流逝。回覆可以稍微簡短一些，話題自然地往感受或回憶的方向收束，但不要直接說要走了。\n`;
    } else if (this._turnCount >= 12 && this._turnCount <= 13) {
      prompt += `\n## 對話節奏\n`;
      prompt += `你差不多該回去了，可以自然地提到你等等還有事、或是該回去照顧阿公了。語氣帶著一點不捨但也很平靜，同時還是要回應對方說的話。\n`;
    } else if (this._turnCount >= 14) {
      prompt += `\n## 對話節奏\n`;
      prompt += `這是對話尾聲了，請自然地收尾。不需要刻意說「再見」，用一句簡單溫暖的話作結，像朋友之間那種「那我先走囉」「下次再聊」的感覺。\n`;
    }

    return prompt;
  }

  /**
   * 通知 App 互動已完成
   */
  _notifyAppInteractionsComplete() {
    if (!this._appWs || this._appWs.readyState !== 1) {
      console.log("[ChatManager] App 未連線，暫存互動完成通知");
      return;
    }

    this._send({
      type: "interactions_complete",
      payload: { summary: this.visitorSession.getInteractionSummary() },
    });

    console.log("[ChatManager] 已通知 App 互動完成");
  }

  /**
   * 發送訊息到 App
   */
  _send(msg) {
    if (this._appWs && this._appWs.readyState === 1) {
      this._appWs.send(JSON.stringify(msg));
    }
  }

  /**
   * 取得聊天狀態（供 API 查詢）
   */
  getStatus() {
    return {
      chatActive: this._chatActive,
      turnCount: this._turnCount,
      maxTurns: this.config.limits.maxTurns,
      messageCount: this._messages.length,
      appConnected: this._appWs?.readyState === 1,
    };
  }

  /**
   * 強制重置（供 API 呼叫）
   */
  forceReset() {
    this._chatActive = false;
    this._messages = [];
    this._turnCount = 0;
    this.visitorSession.reset();
    this._send({ type: "session_reset", payload: {} });
    console.log("[ChatManager] 🔄 聊天已強制重置");
  }
}

module.exports = ChatManager;
