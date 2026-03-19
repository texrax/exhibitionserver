// VTube Studio 裝置 — 透過 WebSocket 連接 VTS API
// 支援認證、快捷鍵觸發、表情切換、模型移動、ArtMesh 染色、參數注入

const WebSocket = require("ws");
const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");
const BaseDevice = require("./BaseDevice");

class VTubeStudioDevice extends BaseDevice {
  constructor(id, config, eventBus) {
    super(id, config, eventBus);
    this.host = config.host || "localhost";
    this.port = config.port || 8001;
    this.pluginName = config.pluginName || "ExhibitionServer";
    this.pluginDeveloper = config.pluginDeveloper || "Exhibition";
    // Token 快取檔路徑
    this.tokenPath = path.resolve(config.tokenPath || "./config/vts_token.txt");

    this._ws = null;
    this._authenticated = false;
    this._token = null;
    this._pendingRequests = new Map(); // requestID → { resolve, reject, timer }
    this._reconnectTimer = null;
    this._requestTimeout = config.requestTimeout || 10000;
    this._activeExpressions = new Set(); // 追蹤目前啟用的表情檔案名稱
  }

  async init() {
    this._loadToken();
    await this._connect();
  }

  async execute(action, params = {}) {
    if (!this._authenticated && action !== "getStatus") {
      throw new Error(`[${this.id}] 尚未通過 VTS 認證`);
    }

    switch (action) {
      case "triggerHotkey":
        return this._triggerHotkey(params.hotkeyID || params.name);
      case "moveModel":
        return this._moveModel(params);
      case "setExpression":
        return this._setExpression(params.file, params.active !== false, params.fadeTime);
      case "tintArtMesh":
        return this._tintArtMesh(params);
      case "loadModel":
        return this._loadModel(params.modelID);
      case "injectParameter":
        return this._injectParameter(params.parameterValues, params.faceFound, params.mode);
      case "removeAllExpressions":
        return this._removeAllExpressions(params.fadeTime);
      case "getModelInfo":
        return this._getCurrentModel();
      case "getHotkeys":
        return this._getHotkeys(params.modelID);
      case "getExpressions":
        return this._getExpressions();
      case "getArtMeshes":
        return this._getArtMeshes();
      case "getTrackingParams":
        return this._getTrackingParams();
      case "createParameter":
        return this._createParameter(params);
      case "deleteParameter":
        return this._deleteParameter(params.parameterName);
      default:
        throw new Error(`[${this.id}] 不支援的動作: ${action}`);
    }
  }

  getSupportedActions() {
    return [
      { action: "triggerHotkey", params: { name: "string" }, description: "觸發快捷鍵（名稱或 ID）" },
      { action: "moveModel", params: { timeInSeconds: "number", positionX: "number", positionY: "number", rotation: "number", size: "number" }, description: "移動模型" },
      { action: "setExpression", params: { file: "string", active: "boolean", fadeTime: "number" }, description: "啟用/停用表情" },
      { action: "tintArtMesh", params: { colorTint: "object", artMeshMatcher: "object" }, description: "ArtMesh 染色" },
      { action: "removeAllExpressions", params: { fadeTime: "number" }, description: "移除所有活躍表情" },
      { action: "loadModel", params: { modelID: "string" }, description: "載入模型" },
      { action: "injectParameter", params: { parameterValues: "array" }, description: "注入追蹤參數" },
      { action: "getModelInfo", params: {}, description: "取得目前模型資訊" },
      { action: "getHotkeys", params: {}, description: "取得快捷鍵列表" },
      { action: "getExpressions", params: {}, description: "取得表情列表" },
      { action: "getArtMeshes", params: {}, description: "取得 ArtMesh 列表" },
      { action: "getTrackingParams", params: {}, description: "取得追蹤參數列表" },
      { action: "createParameter", params: { parameterName: "string", min: "number", max: "number", defaultValue: "number" }, description: "建立自訂參數" },
      { action: "deleteParameter", params: { parameterName: "string" }, description: "刪除自訂參數" },
    ];
  }

  getStatus() {
    return {
      ...super.getStatus(),
      authenticated: this._authenticated,
      wsConnected: this._ws?.readyState === WebSocket.OPEN,
      activeExpressions: [...this._activeExpressions],
    };
  }

  async destroy() {
    if (this._reconnectTimer) clearTimeout(this._reconnectTimer);
    if (this._ws) {
      this._ws.close();
      this._ws = null;
    }
    this._authenticated = false;
    await super.destroy();
  }

  // ==================================================
  //  WebSocket 連線與認證
  // ==================================================

  _connect() {
    return new Promise((resolve) => {
      const url = `ws://${this.host}:${this.port}`;
      console.log(`[${this.id}] 連線至 VTube Studio: ${url}`);
      this._setStatus("connecting");

      this._ws = new WebSocket(url);

      this._ws.on("open", async () => {
        console.log(`[${this.id}] WebSocket 已連線`);
        try {
          await this._authenticate();
          this._setStatus("online");
          resolve();
        } catch (err) {
          console.error(`[${this.id}] 認證失敗:`, err.message);
          this._setStatus("error", err.message);
          resolve();
        }
      });

      this._ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          this._handleResponse(msg);
        } catch (err) {
          console.error(`[${this.id}] WebSocket 訊息解析失敗:`, err.message);
        }
      });

      this._ws.on("close", () => {
        console.log(`[${this.id}] WebSocket 已斷線`);
        this._authenticated = false;
        this._activeExpressions.clear();
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

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      console.log(`[${this.id}] 嘗試重新連線...`);
      this._connect();
    }, 5000);
  }

  async _authenticate() {
    // 先嘗試用已儲存的 token 認證
    if (this._token) {
      const authResult = await this._sendRequest("AuthenticationRequest", {
        pluginName: this.pluginName,
        pluginDeveloper: this.pluginDeveloper,
        authenticationToken: this._token,
      });
      if (authResult.data?.authenticated) {
        this._authenticated = true;
        console.log(`[${this.id}] 使用快取 Token 認證成功`);
        this.eventBus.publish(`${this.id}:authenticated`, {});
        return;
      }
    }

    // Token 無效或不存在，需要向使用者請求新 Token
    console.log(`[${this.id}] 向 VTube Studio 請求新 Token（請在 VTS 中確認允許）...`);
    const tokenResult = await this._sendRequest("AuthenticationTokenRequest", {
      pluginName: this.pluginName,
      pluginDeveloper: this.pluginDeveloper,
    });

    this._token = tokenResult.data.authenticationToken;
    this._saveToken();

    // 用新 Token 認證
    const authResult = await this._sendRequest("AuthenticationRequest", {
      pluginName: this.pluginName,
      pluginDeveloper: this.pluginDeveloper,
      authenticationToken: this._token,
    });

    if (!authResult.data?.authenticated) {
      throw new Error("認證失敗: " + (authResult.data?.reason || "未知原因"));
    }

    this._authenticated = true;
    console.log(`[${this.id}] 新 Token 認證成功`);
    this.eventBus.publish(`${this.id}:authenticated`, {});
  }

  // ==================================================
  //  VTS API 操作方法
  // ==================================================

  async _triggerHotkey(hotkeyID) {
    const result = await this._sendRequest("HotkeyTriggerRequest", { hotkeyID });
    this.eventBus.publish(`${this.id}:hotkeyTriggered`, { hotkeyID });
    return result.data;
  }

  async _moveModel(params) {
    const data = {
      timeInSeconds: params.timeInSeconds ?? 0,
      valuesAreRelativeToModel: params.relative ?? false,
    };
    if (params.positionX !== undefined) data.positionX = params.positionX;
    if (params.positionY !== undefined) data.positionY = params.positionY;
    if (params.rotation !== undefined) data.rotation = params.rotation;
    if (params.size !== undefined) data.size = params.size;

    const result = await this._sendRequest("MoveModelRequest", data);
    this.eventBus.publish(`${this.id}:modelMoved`, params);
    return result.data;
  }

  async _setExpression(expressionFile, active = true, fadeTime = 0.25) {
    // 啟用新表情前，先關閉所有已啟用的表情（自動互斥）
    if (active && this._activeExpressions.size > 0) {
      const deactivations = [...this._activeExpressions].map((file) =>
        this._sendRequest("ExpressionActivationRequest", {
          expressionFile: file,
          active: false,
          fadeTime,
        }).catch((err) => {
          console.error(`[${this.id}] 關閉表情 "${file}" 失敗:`, err.message);
        })
      );
      await Promise.allSettled(deactivations);
      this._activeExpressions.clear();
    }

    const result = await this._sendRequest("ExpressionActivationRequest", {
      expressionFile,
      active,
      fadeTime,
    });

    if (active) {
      this._activeExpressions.add(expressionFile);
    } else {
      this._activeExpressions.delete(expressionFile);
    }

    this.eventBus.publish(`${this.id}:expressionChanged`, {
      expressionFile,
      active,
      activeExpressions: [...this._activeExpressions],
    });
    return result.data;
  }

  async _removeAllExpressions(fadeTime = 0.25) {
    // 查詢 VTS 實際活躍的表情（不依賴本地追蹤）
    let expressionsToDeactivate = [];
    try {
      const stateResult = await this._sendRequest("ExpressionStateRequest", { details: true });
      const expressions = stateResult.data?.expressions || [];
      expressionsToDeactivate = expressions.filter((exp) => exp.active).map((exp) => exp.file);
    } catch (err) {
      console.error(`[${this.id}] 查詢表情狀態失敗，改用本地追蹤:`, err.message);
      expressionsToDeactivate = [...this._activeExpressions];
    }

    // 合併本地追蹤（以防查詢遺漏）
    const allToDeactivate = new Set([...expressionsToDeactivate, ...this._activeExpressions]);

    if (allToDeactivate.size === 0) {
      return { deactivated: [] };
    }

    const deactivations = [...allToDeactivate].map((file) =>
      this._sendRequest("ExpressionActivationRequest", {
        expressionFile: file,
        active: false,
        fadeTime,
      }).catch((err) => {
        console.error(`[${this.id}] 移除表情 "${file}" 失敗:`, err.message);
      })
    );
    await Promise.allSettled(deactivations);
    this._activeExpressions.clear();

    this.eventBus.publish(`${this.id}:allExpressionsRemoved`, { deactivated: [...allToDeactivate] });
    return { deactivated: [...allToDeactivate] };
  }

  async _tintArtMesh(params) {
    const result = await this._sendRequest("ColorTintRequest", {
      colorTint: params.colorTint,
      artMeshMatcher: params.artMeshMatcher,
    });
    return result.data;
  }

  async _loadModel(modelID) {
    const result = await this._sendRequest("ModelLoadRequest", { modelID: modelID || "" });
    this.eventBus.publish(`${this.id}:modelLoaded`, { modelID });
    return result.data;
  }

  async _injectParameter(parameterValues, faceFound, mode) {
    const data = { parameterValues };
    if (faceFound !== undefined) data.faceFound = faceFound;
    if (mode) data.mode = mode;
    const result = await this._sendRequest("InjectParameterDataRequest", data);
    return result.data;
  }

  async _getCurrentModel() {
    const result = await this._sendRequest("CurrentModelRequest");
    return result.data;
  }

  async _getHotkeys(modelID) {
    const data = {};
    if (modelID) data.modelID = modelID;
    const result = await this._sendRequest("HotkeysInCurrentModelRequest", data);
    return result.data;
  }

  async _getExpressions() {
    const result = await this._sendRequest("ExpressionStateRequest", { details: true });
    return result.data;
  }

  async _getArtMeshes() {
    const result = await this._sendRequest("ArtMeshListRequest");
    return result.data;
  }

  async _getTrackingParams() {
    const result = await this._sendRequest("InputParameterListRequest");
    return result.data;
  }

  async _createParameter(params) {
    const result = await this._sendRequest("ParameterCreationRequest", {
      parameterName: params.parameterName,
      explanation: params.explanation || "",
      min: params.min ?? -100,
      max: params.max ?? 100,
      defaultValue: params.defaultValue ?? 0,
    });
    return result.data;
  }

  async _deleteParameter(parameterName) {
    const result = await this._sendRequest("ParameterDeletionRequest", { parameterName });
    return result.data;
  }

  // ==================================================
  //  低階通訊層
  // ==================================================

  /**
   * 發送 VTS API 請求並等待回應
   * @returns {Promise<object>} VTS 回應物件
   */
  _sendRequest(messageType, data = {}) {
    return new Promise((resolve, reject) => {
      if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
        return reject(new Error("WebSocket 未連線"));
      }

      const requestID = uuidv4().replace(/-/g, "").substring(0, 32);
      const payload = {
        apiName: "VTubeStudioPublicAPI",
        apiVersion: "1.0",
        requestID,
        messageType,
        data,
      };

      const timer = setTimeout(() => {
        this._pendingRequests.delete(requestID);
        reject(new Error(`VTS 請求逾時: ${messageType}`));
      }, this._requestTimeout);

      this._pendingRequests.set(requestID, { resolve, reject, timer });
      this._ws.send(JSON.stringify(payload));
    });
  }

  _handleResponse(msg) {
    const pending = this._pendingRequests.get(msg.requestID);
    if (!pending) return;

    clearTimeout(pending.timer);
    this._pendingRequests.delete(msg.requestID);

    if (msg.messageType === "APIError") {
      pending.reject(new Error(`VTS API 錯誤 [${msg.data?.errorID}]: ${msg.data?.message}`));
    } else {
      pending.resolve(msg);
    }
  }

  _rejectAllPending(reason) {
    for (const [id, p] of this._pendingRequests) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this._pendingRequests.clear();
  }

  // ==================================================
  //  Token 持久化
  // ==================================================

  _loadToken() {
    try {
      if (fs.existsSync(this.tokenPath)) {
        this._token = fs.readFileSync(this.tokenPath, "utf-8").trim();
      }
    } catch (err) {
      console.error(`[${this.id}] Token 載入失敗:`, err.message);
    }
  }

  _saveToken() {
    try {
      fs.writeFileSync(this.tokenPath, this._token, "utf-8");
      console.log(`[${this.id}] Token 已儲存至 ${this.tokenPath}`);
    } catch (err) {
      console.error(`[${this.id}] Token 儲存失敗:`, err.message);
    }
  }
}

module.exports = VTubeStudioDevice;
