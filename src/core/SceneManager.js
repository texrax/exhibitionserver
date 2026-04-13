// 場景編排引擎 — 根據 config/scenes.json 定義，
// 監聽事件觸發條件並依序執行動作序列

const fs = require("fs");

class SceneManager {
  /**
   * @param {EventBus} eventBus
   * @param {DeviceManager} deviceManager
   */
  constructor(eventBus, deviceManager) {
    this.eventBus = eventBus;
    this.deviceManager = deviceManager;
    /** @type {Map<string, object>} sceneName → scene 定義 */
    this.scenes = new Map();
    // 場景鎖定（防止同時觸發多個場景造成衝突）
    this._activeScene = null;
    // 取消正在執行的場景用
    this._abortController = null;
    // 可以強制取消其他場景的場景名單
    this._forceScenes = new Set(["start", "all_off"]);
  }

  /**
   * 從設定檔載入場景定義
   * @param {string} configPath scenes.json 的路徑
   */
  loadFromConfig(configPath) {
    const raw = fs.readFileSync(configPath, "utf-8");
    const sceneDefs = JSON.parse(raw);

    for (const [name, def] of Object.entries(sceneDefs)) {
      this.scenes.set(name, def);

      // 如果場景有自動觸發條件，註冊事件監聽
      if (def.trigger?.event) {
        this._registerTrigger(name, def.trigger);
      }
    }

    console.log(`[SceneManager] 已載入 ${this.scenes.size} 個場景`);
  }

  /**
   * 手動觸發場景（由 API 或 Dashboard 呼叫）
   * @param {string} sceneName 場景名稱
   * @returns {object} 執行結果
   */
  async triggerScene(sceneName) {
    const scene = this.scenes.get(sceneName);
    if (!scene) {
      throw new Error(`場景 "${sceneName}" 不存在`);
    }

    if (this._activeScene && scene.exclusive !== false) {
      // start / all_off 可以強制取消正在執行的場景
      if (this._forceScenes.has(sceneName)) {
        console.log(`[SceneManager] 強制取消場景 "${this._activeScene}"，執行 "${sceneName}"`);
        this._cancelActiveScene();
      } else {
        console.log(`[SceneManager] 場景 "${this._activeScene}" 執行中，忽略 "${sceneName}"`);
        return { status: "busy", activeScene: this._activeScene };
      }
    }

    return this._executeScene(sceneName, scene);
  }

  /**
   * 取得所有場景清單（供 Dashboard 顯示）
   */
  listScenes() {
    const result = [];
    for (const [name, def] of this.scenes) {
      result.push({
        name,
        description: def.description || name,
        trigger: def.trigger || null,
        actionCount: def.actions?.length || 0,
        exclusive: def.exclusive !== false,
      });
    }
    return result;
  }

  /**
   * 重新載入場景設定（熱更新）
   */
  reloadConfig(configPath) {
    this.scenes.clear();
    // 移除所有舊的事件監聽需要更細緻的追蹤，此處簡化處理
    this.loadFromConfig(configPath);
  }

  // ---- 私有方法 ----

  _registerTrigger(sceneName, trigger) {
    this.eventBus.on(trigger.event, (data) => {
      // 檢查觸發條件
      if (trigger.condition && !this._checkCondition(trigger.condition, data)) {
        return;
      }
      console.log(`[SceneManager] 事件觸發場景: ${sceneName}`);
      this.triggerScene(sceneName).catch((err) => {
        console.error(`[SceneManager] 場景 "${sceneName}" 自動觸發失敗:`, err.message);
      });
    });
  }

  /**
   * 簡易條件判斷引擎
   * 支援格式：{ "field": ">0.8" } 或 { "field": "value" }
   */
  _checkCondition(condition, data) {
    for (const [key, expected] of Object.entries(condition)) {
      const actual = data[key];
      if (actual === undefined) return false;

      if (typeof expected === "string") {
        // 數值比較: ">0.8", "<10", ">=5"
        const match = expected.match(/^([><=!]+)(.+)$/);
        if (match) {
          const op = match[1];
          const val = parseFloat(match[2]);
          switch (op) {
            case ">":  if (!(actual > val)) return false; break;
            case ">=": if (!(actual >= val)) return false; break;
            case "<":  if (!(actual < val)) return false; break;
            case "<=": if (!(actual <= val)) return false; break;
            case "==": if (actual !== val) return false; break;
            case "!=": if (actual === val) return false; break;
            default: if (String(actual) !== expected) return false;
          }
        } else {
          if (String(actual) !== expected) return false;
        }
      } else {
        if (actual !== expected) return false;
      }
    }
    return true;
  }

  /**
   * 強制取消正在執行的場景
   */
  _cancelActiveScene() {
    if (this._abortController) {
      this._abortController.aborted = true;
    }
    this._activeScene = null;
  }

  async _executeScene(sceneName, scene) {
    const isExclusive = scene.exclusive !== false;
    if (isExclusive) {
      this._activeScene = sceneName;
    }
    const abort = { aborted: false };
    if (isExclusive) {
      this._abortController = abort;
    }
    this.eventBus.publish("scene:started", { scene: sceneName });
    console.log(`[SceneManager] ▶ 執行場景: ${sceneName}`);

    const results = [];

    try {
      for (const step of scene.actions || []) {
        // 檢查是否被取消
        if (abort.aborted) {
          console.log(`[SceneManager] 場景 "${sceneName}" 已被取消`);
          break;
        }

        try {
          // 支援 delay 步驟
          if (step.delay) {
            await this._delay(step.delay, abort);
            continue;
          }

          // 支援 waitForEvent 步驟 — 等待指定事件後才繼續
          if (step.waitForEvent) {
            await this._waitForEvent(
              step.waitForEvent,
              step.timeout || 60000,
              step.condition,
              abort
            );
            continue;
          }

          const result = await this.deviceManager.executeOnDevice(
            step.device,
            step.action,
            step.params || {}
          );
          results.push({ device: step.device, action: step.action, status: "ok", result });
        } catch (err) {
          console.error(`[SceneManager] 步驟失敗 [${step.device}.${step.action}]:`, err.message);
          results.push({ device: step.device, action: step.action, status: "error", error: err.message });
          // 繼續執行後續步驟，不中斷整個場景
        }
      }
    } finally {
      if (isExclusive) {
        if (this._abortController === abort) {
          this._abortController = null;
        }
        this._activeScene = null;
      }
      this.eventBus.publish("scene:finished", { scene: sceneName, results });
      console.log(`[SceneManager] ■ 場景完成: ${sceneName}`);
    }

    return { status: "ok", scene: sceneName, results };
  }

  _delay(ms, abort = null) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; clearTimeout(timer); clearInterval(check); resolve(); } };
      const timer = setTimeout(finish, ms);
      const check = abort ? setInterval(() => { if (abort.aborted) finish(); }, 100) : null;
    });
  }

  /**
   * 等待 EventBus 上的指定事件，可選條件過濾
   * 超時或被取消後自動 resolve（不中斷場景流程）
   */
  _waitForEvent(eventName, timeout = 60000, condition = null, abort = null) {
    return new Promise((resolve) => {
      console.log(`[SceneManager] 等待事件: ${eventName} (逾時 ${timeout}ms)`);

      const cleanup = () => {
        clearTimeout(timer);
        clearInterval(abortCheck);
        this.eventBus.removeListener(eventName, handler);
      };

      const timer = setTimeout(() => {
        cleanup();
        console.warn(`[SceneManager] waitForEvent "${eventName}" 逾時`);
        resolve();
      }, timeout);

      const handler = (data) => {
        if (condition && !this._checkCondition(condition, data)) return;
        cleanup();
        console.log(`[SceneManager] 收到事件: ${eventName}`);
        resolve();
      };

      // 定期檢查是否被取消
      const abortCheck = abort ? setInterval(() => {
        if (abort.aborted) {
          cleanup();
          console.log(`[SceneManager] waitForEvent "${eventName}" 已取消`);
          resolve();
        }
      }, 100) : null;

      this.eventBus.on(eventName, handler);
    });
  }
}

module.exports = SceneManager;
