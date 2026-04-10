// OBS Studio 裝置 — 透過 OBS WebSocket v5 協議控制 OBS
// 支援場景切換、媒體播放、來源顯示/隱藏、濾鏡控制
// 監聽 OBS 事件（如影片播完）並發布到 EventBus

const WebSocket = require("ws");
const crypto = require("crypto");
const { v4: uuidv4 } = require("uuid");
const BaseDevice = require("./BaseDevice");

// OBS WebSocket v5 Opcodes
const OP = {
  Hello: 0,
  Identify: 1,
  Identified: 2,
  Reidentify: 3,
  Event: 5,
  Request: 6,
  RequestResponse: 7,
};

// Event subscription categories (bitmask)
const EVENT_SUBS = {
  General: 1 << 0,       // 1
  Scenes: 1 << 2,        // 4
  MediaInputs: 1 << 8,   // 256
};

class OBSDevice extends BaseDevice {
  constructor(id, config, eventBus) {
    super(id, config, eventBus);
    this.host = config.host || "localhost";
    this.port = config.port || 4455;
    this.password = config.password || null;

    this._ws = null;
    this._identified = false;
    this._pendingRequests = new Map(); // requestId → { resolve, reject, timer }
    this._reconnectTimer = null;
    this._requestTimeout = config.requestTimeout || 10000;
    this._eventSubscriptions =
      EVENT_SUBS.General | EVENT_SUBS.Scenes | EVENT_SUBS.MediaInputs; // 261
  }

  async init() {
    // 防止重複連線
    if (this._ws && this._ws.readyState === WebSocket.OPEN) return;
    await this._connect();
  }

  async execute(action, params = {}) {
    if (!this._identified && action !== "getStatus") {
      throw new Error(`[${this.id}] OBS 尚未連線認證`);
    }

    switch (action) {
      case "switchScene":
        return this._sendRequest("SetCurrentProgramScene", {
          sceneName: params.sceneName,
        });

      case "setSourceVisibility":
        return this._sendRequest("SetSceneItemEnabled", {
          sceneName: params.sceneName,
          sceneItemId: params.sceneItemId,
          sceneItemEnabled: params.enabled,
        });

      case "triggerMediaInput":
        return this._sendRequest("TriggerMediaInputAction", {
          inputName: params.inputName,
          mediaAction:
            params.mediaAction ||
            "OBS_WEBSOCKET_MEDIA_INPUT_ACTION_RESTART",
        });

      case "setInputSettings":
        return this._sendRequest("SetInputSettings", {
          inputName: params.inputName,
          inputSettings: params.settings,
        });

      case "getSceneList":
        return this._sendRequest("GetSceneList");

      case "getSourceScreenshot":
        return this._sendRequest("GetSourceScreenshot", {
          sourceName: params.sourceName,
          imageFormat: params.format || "png",
        });

      case "setSourceFilterVisibility":
        return this._sendRequest("SetSourceFilterEnabled", {
          sourceName: params.sourceName,
          filterName: params.filterName,
          filterEnabled: params.enabled,
        });

      default:
        throw new Error(`[${this.id}] 不支援的動作: ${action}`);
    }
  }

  getSupportedActions() {
    return [
      { action: "switchScene", params: { sceneName: "string" }, description: "切換 OBS 場景" },
      { action: "setSourceVisibility", params: { sceneName: "string", sceneItemId: "number", enabled: "boolean" }, description: "顯示/隱藏來源" },
      { action: "triggerMediaInput", params: { inputName: "string", mediaAction: "string" }, description: "控制媒體播放" },
      { action: "setInputSettings", params: { inputName: "string", settings: "object" }, description: "修改來源設定" },
      { action: "getSceneList", params: {}, description: "取得場景清單" },
      { action: "getSourceScreenshot", params: { sourceName: "string", format: "string" }, description: "截取來源畫面" },
      { action: "setSourceFilterVisibility", params: { sourceName: "string", filterName: "string", enabled: "boolean" }, description: "啟用/停用濾鏡" },
    ];
  }

  getStatus() {
    return {
      ...super.getStatus(),
      identified: this._identified,
      wsConnected: this._ws?.readyState === WebSocket.OPEN,
    };
  }

  async destroy() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    this._identified = false;
    this._rejectAllPending("OBS 裝置銷毀");
    await super.destroy();
  }

  // ==================================================
  //  WebSocket 連線與認證
  // ==================================================

  _connect() {
    return new Promise((resolve) => {
      const url = `ws://${this.host}:${this.port}`;
      console.log(`[${this.id}] 連線至 OBS Studio: ${url}`);
      this._setStatus("connecting");

      this._ws = new WebSocket(url);

      this._ws.on("open", () => {
        console.log(`[${this.id}] WebSocket 已連線，等待 OBS Hello...`);
      });

      this._ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          this._handleMessage(msg, resolve);
        } catch (err) {
          console.error(`[${this.id}] 訊息解析失敗:`, err.message);
        }
      });

      this._ws.on("close", () => {
        console.log(`[${this.id}] OBS WebSocket 已斷線`);
        this._identified = false;
        this._setStatus("offline");
        this._rejectAllPending("WebSocket 連線中斷");
        this._scheduleReconnect();
      });

      this._ws.on("error", (err) => {
        console.error(`[${this.id}] WebSocket 錯誤:`, err.message);
        this._setStatus("error", err.message);
        resolve();
      });
    });
  }

  _handleMessage(msg, connectResolve) {
    switch (msg.op) {
      case OP.Hello:
        this._identify(msg.d, connectResolve);
        break;

      case OP.Identified:
        console.log(`[${this.id}] OBS 認證成功`);
        this._identified = true;
        this._setStatus("online");
        if (connectResolve) connectResolve();
        break;

      case OP.Event:
        this._handleOBSEvent(msg.d);
        break;

      case OP.RequestResponse:
        this._handleRequestResponse(msg.d);
        break;

      default:
        break;
    }
  }

  _identify(helloData, connectResolve) {
    const identifyData = {
      rpcVersion: 1,
      eventSubscriptions: this._eventSubscriptions,
    };

    // 如果 OBS 要求認證
    if (helloData.authentication && this.password) {
      const { challenge, salt } = helloData.authentication;
      const secret = crypto
        .createHash("sha256")
        .update(this.password + salt)
        .digest("base64");
      const authString = crypto
        .createHash("sha256")
        .update(secret + challenge)
        .digest("base64");
      identifyData.authentication = authString;
    }

    const payload = JSON.stringify({ op: OP.Identify, d: identifyData });

    try {
      this._ws.send(payload);
    } catch (err) {
      console.error(`[${this.id}] 發送 Identify 失敗:`, err.message);
      this._setStatus("error", err.message);
      if (connectResolve) connectResolve();
    }
  }

  // ==================================================
  //  請求 / 回應
  // ==================================================

  _sendRequest(requestType, requestData = {}) {
    return new Promise((resolve, reject) => {
      if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
        return reject(new Error("OBS WebSocket 未連線"));
      }

      const requestId = uuidv4().replace(/-/g, "").substring(0, 32);

      const timer = setTimeout(() => {
        this._pendingRequests.delete(requestId);
        reject(new Error(`OBS 請求逾時: ${requestType}`));
      }, this._requestTimeout);

      this._pendingRequests.set(requestId, { resolve, reject, timer });

      const payload = JSON.stringify({
        op: OP.Request,
        d: { requestType, requestId, requestData },
      });

      this._ws.send(payload);
    });
  }

  _handleRequestResponse(data) {
    const { requestId, requestStatus, responseData } = data;
    const pending = this._pendingRequests.get(requestId);
    if (!pending) return;

    clearTimeout(pending.timer);
    this._pendingRequests.delete(requestId);

    if (requestStatus.result) {
      pending.resolve(responseData || {});
    } else {
      pending.reject(
        new Error(
          `OBS 請求失敗: ${requestStatus.code} — ${requestStatus.comment || ""}`
        )
      );
    }
  }

  // ==================================================
  //  OBS 事件處理
  // ==================================================

  _handleOBSEvent(data) {
    const { eventType, eventData } = data;

    switch (eventType) {
      case "MediaInputPlaybackEnded":
        console.log(
          `[${this.id}] 媒體播放結束: ${eventData?.inputName || "unknown"}`
        );
        this.eventBus.publish(`${this.id}:mediaEnded`, {
          inputName: eventData?.inputName,
        });
        break;

      case "CurrentProgramSceneChanged":
        console.log(
          `[${this.id}] OBS 場景已切換: ${eventData?.sceneName || "unknown"}`
        );
        this.eventBus.publish(`${this.id}:sceneChanged`, {
          sceneName: eventData?.sceneName,
        });
        break;

      case "MediaInputPlaybackStarted":
        this.eventBus.publish(`${this.id}:mediaStarted`, {
          inputName: eventData?.inputName,
        });
        break;

      default:
        // 其他事件用通用格式發布
        this.eventBus.publish(`${this.id}:obs:${eventType}`, eventData || {});
        break;
    }
  }

  // ==================================================
  //  重連與清理
  // ==================================================

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      console.log(`[${this.id}] 嘗試重新連線 OBS...`);
      this._connect();
    }, 5000);
  }

  _rejectAllPending(reason) {
    for (const [id, pending] of this._pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this._pendingRequests.clear();
  }
}

module.exports = OBSDevice;
