// YoloTD 視覺辨識裝置 — 自動啟動 YoloTD Python 伺服器作為子程序，
// 輪詢 /status 端點偵測餐桌互動事件，發射 EventBus 事件觸發 VTuber 動畫

const { spawn } = require("child_process");
const path = require("path");
const axios = require("axios");
const BaseDevice = require("./BaseDevice");

class YoloDetectorDevice extends BaseDevice {
  constructor(id, config, eventBus) {
    super(id, config, eventBus);
    this.projectPath = path.resolve(config.projectPath || "./yolo");
    this.pythonPath = config.pythonPath || path.join(this.projectPath, "venv", "bin", "python");
    this.serverEnv = config.env || { YOLO_PROFILE: "y11" };
    this.url = config.url || "http://localhost:8000";
    this.pollIntervalMs = config.pollIntervalMs || 500;
    this.cooldownMs = config.cooldownMs || 3000;
    this.timeout = config.timeout || 3000;
    this.startupTimeoutMs = config.startupTimeoutMs || 15000;

    this._process = null;
    this._pollTimer = null;
    this._lastEventId = null;
    this._lastEventType = null;
    this._lastEventTime = 0;
    this._consecutiveErrors = 0;
    this._isPolling = false;
    this._intentionalKill = false;
  }

  async init() {
    if (!this.projectPath) {
      this._setStatus("error", "config.projectPath 未設定");
      return;
    }
    await this._spawnServer();
  }

  async execute(action, params = {}) {
    switch (action) {
      case "start":
        this._startPolling();
        return { polling: true };
      case "stop":
        this._stopPolling();
        return { polling: false };
      case "restart":
        await this._killServer();
        await this._spawnServer();
        return { status: "restarted" };
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
      { action: "restart", description: "重啟 YoloTD 伺服器" },
      { action: "getLatestEvent", description: "取得最新偵測事件" },
    ];
  }

  getStatus() {
    return {
      ...super.getStatus(),
      processRunning: this._process !== null,
      polling: this._pollTimer !== null,
      lastEventId: this._lastEventId,
      lastEventType: this._lastEventType,
      consecutiveErrors: this._consecutiveErrors,
      yoloUrl: this.url,
    };
  }

  async destroy() {
    this._stopPolling();
    await this._killServer();
    await super.destroy();
  }

  // ---- 子程序管理 ----

  async _spawnServer() {
    if (this._process) return;

    const cwd = path.join(this.projectPath, "src");
    const env = { ...process.env, ...this.serverEnv };

    console.log(`[${this.id}] 啟動 YoloTD: ${this.pythonPath} server.py`);
    console.log(`[${this.id}] cwd: ${cwd} | CAMERA_SOURCE=${env.CAMERA_SOURCE}`);

    this._intentionalKill = false;
    this._process = spawn(this.pythonPath, ["server.py"], { cwd, env });

    // stdout — 印出 YoloTD log
    this._process.stdout.on("data", (data) => {
      const lines = data.toString().trim().split("\n");
      for (const line of lines) {
        if (line) console.log(`[${this.id}:py] ${line}`);
      }
    });

    // stderr — uvicorn 的 log 走 stderr
    this._process.stderr.on("data", (data) => {
      const lines = data.toString().trim().split("\n");
      for (const line of lines) {
        if (line) console.log(`[${this.id}:py] ${line}`);
      }
    });

    // 子程序退出 — 非預期時自動重啟
    this._process.on("close", (code) => {
      console.log(`[${this.id}] YoloTD 子程序已結束 (code: ${code})`);
      this._process = null;
      if (!this._intentionalKill) {
        console.warn(`[${this.id}] 非預期退出，5 秒後自動重啟...`);
        this._setStatus("offline", `子程序退出 (code: ${code})`);
        setTimeout(() => {
          if (!this._intentionalKill) {
            this._spawnServer().catch((err) => {
              console.error(`[${this.id}] 重啟失敗:`, err.message);
            });
          }
        }, 5000);
      }
    });

    // 等待伺服器就緒
    const ready = await this._waitForReady();
    if (ready) {
      this._setStatus("online");
      console.log(`[${this.id}] YoloTD 伺服器就緒: ${this.url}`);
      this._startPolling();
    } else {
      this._setStatus("offline", "伺服器啟動逾時");
      console.warn(`[${this.id}] YoloTD 啟動逾時 (${this.startupTimeoutMs}ms)，輪詢仍會持續嘗試`);
      this._startPolling();
    }
  }

  async _waitForReady() {
    const start = Date.now();
    while (Date.now() - start < this.startupTimeoutMs) {
      try {
        await axios.get(`${this.url}/status`, { timeout: 2000 });
        return true;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    return false;
  }

  async _killServer() {
    this._intentionalKill = true;
    if (this._process) {
      console.log(`[${this.id}] 終止 YoloTD 子程序`);
      this._process.kill();
      this._process = null;
    }
  }

  // ---- 輪詢邏輯 ----

  _startPolling() {
    if (this._pollTimer) return;
    this._pollTimer = setInterval(() => this._poll(), this.pollIntervalMs);
  }

  _stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  async _poll() {
    if (this._isPolling) return;
    this._isPolling = true;

    try {
      const res = await axios.get(`${this.url}/status`, { timeout: this.timeout });
      this._consecutiveErrors = 0;

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

    if (isTerminal) {
      if (!completed) return;
    } else if (event_type === "pickup") {
      if (event_id === this._lastEventId) return;
    } else {
      return;
    }

    if (event_id === this._lastEventId && event_type === this._lastEventType) {
      return;
    }

    const now = Date.now();
    if (now - this._lastEventTime < this.cooldownMs) {
      if (!isTerminal) return;
    }

    this._lastEventId = event_id;
    this._lastEventType = event_type;
    this._lastEventTime = now;

    const data = {
      eventType: event_type,
      food: carried_food,
      event_id,
      state,
      source_side,
      target_side,
      completed: !!completed,
    };

    this.eventBus.publish(`${this.id}:${event_type}`, data);
    console.log(`[${this.id}] 事件: ${event_type} | 食物: ${carried_food || "無"} | 來源: ${source_side || "?"} → ${target_side || "?"}`);
  }
}

module.exports = YoloDetectorDevice;
