// AI Agent 控制器 — 第四階段語音對話 + 三步驟眼神追隨的中央調度器
//
// 模式：
//   passive（預設、三步驟期間）— Python agent 已連線時做眼神追隨，不啟用 STT
//   active（第四階段、visitor:ready_to_chat 後）— 啟用 STT，speech 事件觸發 Claude tool use
//
// VTS 白名單：當 SceneManager._vtsLockMode === 'restricted' 時，
// 對 vtubestudio 只允許 setLookAt / clearLookAt，其餘動作被拒絕並 publish agent:action_rejected

const ALLOWED_VTS_ACTIONS_RESTRICTED = new Set(["setLookAt", "clearLookAt"]);

// scene 執行中允許的 hotkey 名單（白名單內的 triggerHotkey 才放行）
// 揮手 + Ver7 短動畫（< 3s 不會干擾 scene 內部邏輯）
// 注意：「待機」hotkey 在當前 VTS 模型對映到「不吃_嘴巴講話」motion，已從白名單移除
const ALLOWED_HOTKEYS_RESTRICTED = new Set([
  "揮手",
  "前傾", "點頭動畫", "指向上方", "歪頭好奇",
]);

const MODE = {
  PASSIVE: "passive",
  ACTIVE: "active",
};

// 對話歷史最多保留多少 turns（每 turn = 1 user + 1 assistant）— 超過裁切舊的
const MAX_HISTORY_TURNS = 12;

// Claude tool use schema — 給 LLM 的工具定義
const TOOL_SCHEMAS = [
  {
    name: "look_at_visitor",
    description:
      "讓 VTuber 看向某個方向，用於眼神接觸。x 是水平角度（負=左，正=右），y 是垂直角度（負=下，正=上）。在三步驟期間（場景執行中）此工具仍可用 — 它是場景鎖定下唯一允許的 VTS 動作。",
    input_schema: {
      type: "object",
      properties: {
        x: { type: "number", description: "水平 -30 到 30 度" },
        y: { type: "number", description: "垂直 -30 到 30 度" },
        headTilt: { type: "number", description: "可選：頭部側傾 -10 到 10 度" },
      },
      required: ["x", "y"],
    },
  },
  {
    name: "express_emotion",
    description:
      "讓 VTuber 顯示情緒表情。在三步驟期間（場景執行中）此工具會被拒絕，因為場景已經在控制 VTuber 表情。",
    input_schema: {
      type: "object",
      properties: {
        emotion: {
          type: "string",
          enum: ["happy", "sad", "surprised", "angry", "neutral"],
          description: "情緒類別",
        },
      },
      required: ["emotion"],
    },
  },
  {
    name: "say",
    description:
      "VTuber 用「蘇菲」的口吻說一句話回應訪客。繁體中文，70 字內，自然口語。注意宗教（穆斯林）與文化禁忌。Phase 6 暫不接 TTS，目前只發出 agent:say 事件供 OBS 字幕顯示。",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "要說的話" },
      },
      required: ["text"],
    },
  },
];

class AgentController {
  /**
   * @param {object} deps
   * @param {EventBus} deps.eventBus
   * @param {DeviceManager} deps.deviceManager
   * @param {SceneManager} deps.sceneManager
   * @param {VisitorSession} deps.visitorSession
   * @param {ChatManager} deps.chatManager
   * @param {ClaudeAgentClient|null} [deps.claudeAgentClient]  Phase 6 注入；null 時對話迴圈停用
   * @param {object} [deps.chatConfig]  config/chat.json 內容（角色設定）
   * @param {object} [deps.config]  config/agent.json 內容
   */
  constructor({
    eventBus,
    deviceManager,
    sceneManager,
    visitorSession,
    chatManager,
    claudeAgentClient = null,
    chatConfig = {},
    config = {},
  }) {
    this.eventBus = eventBus;
    this.deviceManager = deviceManager;
    this.sceneManager = sceneManager;
    this.visitorSession = visitorSession;
    this.chatManager = chatManager;
    this.claudeAgentClient = claudeAgentClient;
    this.chatConfig = chatConfig;

    this.agentDeviceId = config.agentDeviceId || "ai_agent";
    this._gazeMinIntervalMs = config.gazeMinIntervalMs || 200;
    this._speechMinConfidence = config.speechMinConfidence ?? 0.6;
    this._maxTokens = config.llm?.maxTokens || 400;
    this._temperature = config.llm?.temperature ?? 0.8;

    // emotion → VTS 動作的映射（可由 agent.json 覆寫；預設用既有 hotkey 名稱）
    // Ver7 新增：shy / proud / pouty / deadpan / wink
    this.emotionMap = config.emotionMap || {
      happy: { type: "expression", file: "開心(睜眼).exp3.json" },
      happy_closed: { type: "expression", file: "開心(閉眼).exp3.json" },
      sad: { type: "expression", file: "哀傷.exp3.json" },
      surprised: { type: "hotkey", name: "驚訝" },
      angry: { type: "hotkey", name: "生氣" },
      shy: { type: "expression", file: "shy.exp3.json" },
      proud: { type: "expression", file: "proud.exp3.json" },
      pouty: { type: "expression", file: "pouty.exp3.json" },
      deadpan: { type: "expression", file: "deadpan.exp3.json" },
      wink: { type: "expression", file: "wink-left.exp3.json" },
      neutral: { type: "removeAll" },
    };

    // ---- 手勢 cooldown（gesture type → { lastAt, ms }）----
    const defaultCooldowns = {
      wave: 5000, bow: 5000, raise_hand: 4000, heart: 6000,
      approach: 8000, retreat: 8000, idle: 15000,
      thumbs_up: 4000, victory: 4000, thumbs_down: 4000,
      pointing_up: 4000, i_love_you: 5000,
      face_smile: 3000, face_surprise: 3000, face_frown: 4000, face_nod: 3000,
    };
    const customCooldowns = config.gestures?.cooldowns || {};
    this._gestureCooldowns = {};
    for (const [type, ms] of Object.entries({ ...defaultCooldowns, ...customCooldowns })) {
      this._gestureCooldowns[type] = { lastAt: 0, ms };
    }

    // 表情自動清除的 version counter（防止新舊清除衝突）
    this._expressionVersion = 0;

    // ---- 手勢 dispatch table（Ver7 升級版）----
    this._gestureHandlers = {
      wave:          (d) => this._handleWave(d),
      bow:           ()  => this._handleBow(),
      raise_hand:    (d) => this._handleRaiseHand(d),
      heart:         ()  => this._handleReflexEmotion("proud", 4000),
      approach:      ()  => this._handleReflexEmotion("shy", 3000),
      retreat:       ()  => this._handleReflexEmotion("sad", 3000),
      idle:          ()  => this._handleIdle(),
      thumbs_up:     ()  => this._handleReflexEmotion("proud", 4000),
      victory:       ()  => this._handleReflexEmotion("wink", 4000),
      thumbs_down:   ()  => this._handleReflexEmotion("pouty", 4000),
      pointing_up:   ()  => this._handlePointingUp(),
      i_love_you:    ()  => this._handleReflexEmotion("happy", 4000),
      face_smile:    ()  => this._handleReflexEmotion("happy", 3000),
      face_surprise: ()  => this._handleReflexEmotion("surprised", 3000),
      face_frown:    ()  => this._handleReflexEmotion("pouty", 3000),
      face_nod:      ()  => this._handleNod(),
    };

    this._mode = MODE.PASSIVE;
    this._vtsLockMode = sceneManager.getVtsLockMode();
    this._lastGazeAt = 0;
    this._lastGesture = null;

    // 第二環節（餐桌互動）期間靜音 vision 觸發的表情/手勢
    // 由 after_day_selection 開啟、end_interaction / start / all_off 解除
    this._visionMuted = false;

    // 對話歷史 — 與 ChatManager 的 APP 文字聊天分開
    this._history = [];
    this._turnInFlight = false;

    this._wireEvents();
    console.log(
      `[AgentController] 初始化完成 mode=${this._mode} vtsLock=${this._vtsLockMode} llmReady=${!!this.claudeAgentClient}`
    );
  }

  _wireEvents() {
    this.eventBus.on("visitor:ready_to_chat", () => this._setMode(MODE.ACTIVE));
    this.eventBus.on("visitor:session_reset", () => {
      this._history = [];
      this._setMode(MODE.PASSIVE);
    });

    this.eventBus.on("scene:vts_lock_changed", ({ mode }) => {
      this._vtsLockMode = mode;
    });

    // Vision 靜音控制：從第一環節（start）進入互動就靜音，
    // 直到 end_interaction 結束（進入第四階段聊天）才解除
    this.eventBus.on("scene:started", ({ scene }) => {
      if (scene === "start") {
        this._setVisionMuted(true, "phase1_start");
      } else if (scene === "after_day_selection") {
        this._setVisionMuted(true, "phase2_eating");
      } else if (scene === "all_off") {
        this._setVisionMuted(false, "all_off");
      }
    });
    this.eventBus.on("scene:finished", ({ scene }) => {
      if (scene === "end_interaction") {
        this._setVisionMuted(false, "end_interaction");
      }
    });

    this.eventBus.on("agent:speech", (data) => this._onSpeech(data));
    this.eventBus.on("agent:gesture", (data) => this._onGesture(data));
    this.eventBus.on("agent:gaze", (data) => this._onGaze(data));

    // Python agent 重新連線時自動同步當前 vision 狀態，避免重連後 pause 失效
    this.eventBus.on(`${this.agentDeviceId}:status`, ({ status }) => {
      if (status === "online") {
        this._syncVisionStateToPython("agent_reconnected");
      }
    });
  }

  _setVisionMuted(muted, reason = "") {
    const stateChanged = this._visionMuted !== muted;
    this._visionMuted = muted;
    if (stateChanged) {
      console.log(`[AgentController] vision muted: ${muted} (${reason})`);
      this.eventBus.publish("agent:vision_muted_changed", { muted, reason });
    }

    // 不論 state 有沒有變都重送命令 — 避免 Python agent 重連時狀態遺失
    this._syncVisionStateToPython(reason);
  }

  _syncVisionStateToPython(reason = "sync") {
    const cmd = this._visionMuted ? "pauseVision" : "resumeVision";
    this.deviceManager
      .executeOnDevice(this.agentDeviceId, cmd, {})
      .then(() => {
        console.log(`[AgentController] → Python agent ${cmd} (${reason})`);
      })
      .catch((err) => {
        console.log(`[AgentController] 通知 Python agent ${cmd} 失敗（可能未連線）: ${err.message}`);
      });
  }

  _setMode(newMode) {
    if (this._mode === newMode) return;
    const prev = this._mode;
    this._mode = newMode;
    console.log(`[AgentController] mode: ${prev} → ${newMode}`);
    this.eventBus.publish("agent:mode_changed", { mode: newMode, prev });

    const cmd = newMode === MODE.ACTIVE ? "startListening" : "stopListening";
    this.deviceManager
      .executeOnDevice(this.agentDeviceId, cmd, {})
      .catch((err) => {
        console.log(`[AgentController] 通知 Python agent ${cmd} 失敗（可能未連線）: ${err.message}`);
      });
  }

  // ==================================================
  //  事件處理
  // ==================================================

  _onGaze({ x, y } = {}) {
    if (this._visionMuted) return;
    if (typeof x !== "number" || typeof y !== "number") return;

    const now = Date.now();
    if (now - this._lastGazeAt < this._gazeMinIntervalMs) return;
    this._lastGazeAt = now;

    const lookX = (x - 0.5) * 60;
    const lookY = (0.5 - y) * 60;

    this.executeAgentAction({
      device: "vtubestudio",
      action: "setLookAt",
      params: { x: lookX, y: lookY, headTilt: 0 },
    }).catch(() => {});
  }

  _onGesture(data) {
    if (this._visionMuted) return;
    const type = data?.type;
    if (!type) return;

    // cooldown 檢查
    const cd = this._gestureCooldowns[type];
    if (cd) {
      const now = Date.now();
      if (now - cd.lastAt < cd.ms) return;
      cd.lastAt = now;
    }

    this._lastGesture = { ...data, _at: Date.now() };

    const handler = this._gestureHandlers[type];
    if (handler) {
      handler(data);
    } else {
      console.log(`[AgentController] 未知 gesture type: ${type}`);
    }
  }

  // ==================================================
  //  Gesture Handlers（reflex，不走 LLM）
  // ==================================================

  _handleWave(data) {
    // 朝揮手方向看 + 觸發揮手動畫
    if (typeof data.x === "number" && typeof data.y === "number") {
      const lookX = (data.x - 0.5) * 60;
      const lookY = (0.5 - data.y) * 60;
      this.executeAgentAction({
        device: "vtubestudio", action: "setLookAt",
        params: { x: lookX, y: lookY, headTilt: 0 },
      }).catch(() => {});
    }
    this.executeAgentAction({
      device: "vtubestudio", action: "triggerHotkey",
      params: { name: "揮手" },
    }).catch(() => {});
  }

  _handleBow() {
    // VTuber 前傾動畫（Ver7 新動作）
    this.executeAgentAction({
      device: "vtubestudio", action: "triggerHotkey",
      params: { name: "前傾" },
    }).catch(() => {});
  }

  _handleRaiseHand(data) {
    // 看向舉手方向 + 歪頭好奇動畫（Ver7 新動作）
    if (typeof data.x === "number") {
      const lookX = (data.x - 0.5) * 60;
      this.executeAgentAction({
        device: "vtubestudio", action: "setLookAt",
        params: { x: lookX, y: 15, headTilt: 0 },
      }).catch(() => {});
    }
    this.executeAgentAction({
      device: "vtubestudio", action: "triggerHotkey",
      params: { name: "歪頭好奇" },
    }).catch(() => {});
  }

  _handleReflexEmotion(emotion, clearAfterMs) {
    // 觸發表情，clearAfterMs 毫秒後自動清除
    const mapping = this.emotionMap[emotion];
    if (!mapping) return;

    const version = ++this._expressionVersion;

    if (mapping.type === "expression") {
      this.executeAgentAction({
        device: "vtubestudio", action: "setExpression",
        params: { file: mapping.file, active: true, fadeTime: 0.3 },
      }).catch(() => {});
    } else if (mapping.type === "hotkey") {
      this.executeAgentAction({
        device: "vtubestudio", action: "triggerHotkey",
        params: { name: mapping.name },
      }).catch(() => {});
    }

    if (clearAfterMs > 0) {
      setTimeout(() => {
        // 只有在 version 沒被更新時才清除（防止新表情被舊 timer 覆蓋）
        if (this._expressionVersion === version) {
          this.executeAgentAction({
            device: "vtubestudio", action: "removeAllExpressions",
            params: { fadeTime: 0.5 },
          }).catch(() => {});
        }
      }, clearAfterMs);
    }
  }

  _handleIdle() {
    // VTS 模型的「待機」hotkey 目前對映到「不吃_嘴巴講話」motion，
    // 觸發只會出現拒食動畫，因此 idle gesture 暫不觸發任何 hotkey。
  }

  _handlePointingUp() {
    // VTuber 指向上方動畫（Ver7 新動作）
    this.executeAgentAction({
      device: "vtubestudio", action: "triggerHotkey",
      params: { name: "指向上方" },
    }).catch(() => {});
  }

  _handleNod() {
    // VTuber 點頭動畫（Ver7 新動作）
    this.executeAgentAction({
      device: "vtubestudio", action: "triggerHotkey",
      params: { name: "點頭動畫" },
    }).catch(() => {});
  }

  async _onSpeech({ text, confidence } = {}) {
    if (this._mode !== MODE.ACTIVE) {
      console.log(`[AgentController] 忽略 speech（mode=${this._mode}）: "${text}"`);
      return;
    }
    if (!text || (typeof confidence === "number" && confidence < this._speechMinConfidence)) {
      console.log(`[AgentController] 忽略低信心 speech: text="${text}" confidence=${confidence}`);
      return;
    }
    if (!this.claudeAgentClient) {
      console.warn(`[AgentController] 收到 speech 但無 LLM client（Ollama 不支援 tool use）: "${text}"`);
      this.eventBus.publish("agent:speech_dropped", { text, reason: "no_llm_client" });
      return;
    }
    if (this._turnInFlight) {
      console.log(`[AgentController] 上一輪 LLM 仍在處理，忽略 speech: "${text}"`);
      return;
    }

    console.log(`[AgentController] 收到訪客語音: "${text}"`);
    this.eventBus.publish("agent:speech_accepted", { text, confidence });

    this._turnInFlight = true;
    this._history.push({ role: "user", content: text });

    try {
      const result = await this.claudeAgentClient.runTurn({
        systemPrompt: this._buildAgentSystemPrompt(),
        messages: this._history,
        tools: TOOL_SCHEMAS,
        maxTokens: this._maxTokens,
        temperature: this._temperature,
      });

      // Anthropic API 規範：assistant turn 在 history 中要保留 content array（含 tool_use blocks）
      this._history.push({ role: "assistant", content: result.rawContent });

      this.eventBus.publish("agent:llm_turn", {
        text: result.text,
        toolCalls: result.toolCalls.map((c) => ({ name: c.name, input: c.input })),
        stopReason: result.stopReason,
      });

      // 依序執行 tool calls
      const toolResults = [];
      for (const call of result.toolCalls) {
        const r = await this._executeToolUse(call);
        toolResults.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: typeof r === "string" ? r : JSON.stringify(r),
          ...(r?.error ? { is_error: true } : {}),
        });
      }

      // 把 tool results 回送給 LLM 視為下一個 user turn（讓 LLM 看到結果可繼續）
      if (toolResults.length > 0) {
        this._history.push({ role: "user", content: toolResults });
      }

      this._trimHistory();
    } catch (err) {
      console.error(`[AgentController] LLM 對話迴圈失敗: ${err.message}`);
      this.eventBus.publish("agent:llm_error", { error: err.message });
      // 失敗時把這筆 user 訊息退出 history，下次重試
      this._history.pop();
    } finally {
      this._turnInFlight = false;
    }
  }

  _trimHistory() {
    const maxEntries = MAX_HISTORY_TURNS * 2;
    if (this._history.length > maxEntries) {
      this._history = this._history.slice(-maxEntries);
    }
  }

  // ==================================================
  //  Tool dispatch
  // ==================================================

  async _executeToolUse({ name, input }) {
    switch (name) {
      case "look_at_visitor": {
        return this.executeAgentAction({
          device: "vtubestudio",
          action: "setLookAt",
          params: { x: input.x, y: input.y, headTilt: input.headTilt || 0 },
        });
      }

      case "express_emotion": {
        const mapping = this.emotionMap[input.emotion];
        if (!mapping) return { error: `未知 emotion: ${input.emotion}` };
        if (mapping.type === "expression") {
          return this.executeAgentAction({
            device: "vtubestudio",
            action: "setExpression",
            params: { file: mapping.file, active: true, fadeTime: 0.3 },
          });
        }
        if (mapping.type === "hotkey") {
          return this.executeAgentAction({
            device: "vtubestudio",
            action: "triggerHotkey",
            params: { name: mapping.name },
          });
        }
        if (mapping.type === "removeAll") {
          return this.executeAgentAction({
            device: "vtubestudio",
            action: "removeAllExpressions",
            params: { fadeTime: 0.5 },
          });
        }
        return { error: `未知 emotion 類型: ${mapping.type}` };
      }

      case "say": {
        // Phase 6 暫不接 TTS — 只發事件，由 OBS 字幕或 Dashboard 顯示
        this.eventBus.publish("agent:say", { text: input.text });
        return { displayed: true };
      }

      default:
        return { error: `unknown tool: ${name}` };
    }
  }

  // ==================================================
  //  System prompt（agent 對話迴圈專用）
  // ==================================================

  _buildAgentSystemPrompt() {
    const c = this.chatConfig?.character || {};
    const summary = this.visitorSession?.getInteractionSummary?.() || {};

    let prompt = `你是「${c.name || "蘇菲"}」。${c.backstory || ""}\n\n`;
    if (c.personality) prompt += `個性：${c.personality}\n\n`;
    if (c.culture) prompt += `## 文化與宗教背景（必須嚴格遵守）\n${c.culture}\n\n`;

    prompt += `## 即時對話模式\n`;
    prompt += `你正在跟展場現場的訪客即時對話。訪客的話會由語音轉文字傳給你。你不是在打字聊天，是在跟眼前的真人講話。\n\n`;

    if (summary.dayAttempts > 0 || summary.foodsDelivered?.length > 0) {
      prompt += `## 剛才的互動紀錄\n`;
      if (summary.dayAttempts > 0) {
        prompt += `- 選日子：訪客嘗試了 ${summary.dayAttempts} 次，最後選的是${summary.dayChosenName}。`;
        prompt += summary.foundCorrectDay ? `（找到星期三了）\n` : `（沒找到星期三）\n`;
      }
      if (summary.foodsDelivered?.length > 0) {
        const foods = summary.foodsDelivered
          .map((f) => (f === "vegetable" ? "青菜" : f === "beef" ? "牛肉丸" : f))
          .join("、");
        prompt += `- 夾菜：訪客餵你吃了 ${foods}\n`;
      }
      prompt += `\n`;
    }

    prompt += `## 回應規則\n`;
    prompt += `- 用 **say** 工具用一句話回應訪客（70 字內、繁體中文、口語化、不用 emoji）\n`;
    prompt += `- 用 **look_at_visitor** 工具讓眼神跟著訪客，x: -30~30, y: -30~30\n`;
    prompt += `- 適時用 **express_emotion** 表達情緒（happy/sad/surprised/angry/neutral）\n`;
    prompt += `- 一輪通常用 1-2 個工具，不要每輪都用全部三個\n`;
    prompt += `- 如果訪客只是雜音或沒講有意義的話，可以只用 look_at_visitor 不必說話\n`;
    prompt += `- 表情要與情緒一致，不要矛盾（例如 say 開心的話卻 sad 表情）\n`;

    return prompt;
  }

  // ==================================================
  //  白名單統一入口 — agent 任何裝置動作都應走這裡
  // ==================================================

  async executeAgentAction({ device, action, params = {} }) {
    if (this._vtsLockMode === "restricted" && device === "vtubestudio") {
      const allowed =
        ALLOWED_VTS_ACTIONS_RESTRICTED.has(action) ||
        (action === "triggerHotkey" && ALLOWED_HOTKEYS_RESTRICTED.has(params?.name));
      if (!allowed) {
        const reason = "scene_lock_restricted";
        console.log(`[AgentController] 拒絕動作 (lock=restricted): ${device}.${action} ${params?.name || ""}`);
        this.eventBus.publish("agent:action_rejected", { device, action, params, reason });
        return { rejected: true, reason };
      }
    }
    try {
      const result = await this.deviceManager.executeOnDevice(device, action, params);
      this.eventBus.publish("agent:action_executed", { device, action, params });
      return result;
    } catch (err) {
      this.eventBus.publish("agent:action_failed", { device, action, error: err.message });
      throw err;
    }
  }

  getStatus() {
    return {
      mode: this._mode,
      vtsLockMode: this._vtsLockMode,
      visionMuted: this._visionMuted,
      llmReady: !!this.claudeAgentClient,
      historyTurns: Math.floor(this._history.length / 2),
      turnInFlight: this._turnInFlight,
      lastGesture: this._lastGesture,
      lastGazeAt: this._lastGazeAt ? new Date(this._lastGazeAt).toISOString() : null,
    };
  }
}

module.exports = AgentController;
module.exports.MODE = MODE;
module.exports.ALLOWED_VTS_ACTIONS_RESTRICTED = ALLOWED_VTS_ACTIONS_RESTRICTED;
module.exports.ALLOWED_HOTKEYS_RESTRICTED = ALLOWED_HOTKEYS_RESTRICTED;
module.exports.TOOL_SCHEMAS = TOOL_SCHEMAS;
