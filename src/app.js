// 展場中控系統 — 主程式入口
// 支援兩種運作模式：
//   本地模式（預設）：直接載入裝置，單機運行
//   雲端模式（CLOUD=1）：等待展場 Bridge 連線，透過 WebSocket 遠端代理裝置

const express = require("express");
const path = require("path");
const http = require("http");
const { WebSocketServer } = require("ws");

const EventBus = require("./core/EventBus");
const DeviceManager = require("./core/DeviceManager");
const SceneManager = require("./core/SceneManager");
const BridgeManager = require("./core/BridgeManager");
const VisitorSession = require("./core/VisitorSession");
const ClaudeClient = require("./core/ClaudeClient");
const ChatManager = require("./core/ChatManager");
const createApiRoutes = require("./routes/apiRoutes");
const createSceneRoutes = require("./routes/sceneRoutes");
const createChatRoutes = require("./routes/chatRoutes");

const PORT = process.env.PORT || 3000;
const IS_CLOUD = process.env.CLOUD === "1" || process.argv.includes("--cloud");
const BRIDGE_SECRET = process.env.BRIDGE_SECRET || "exhibition2026";
const DEVICES_CONFIG = path.resolve(__dirname, "../config/devices.json");
const SCENES_CONFIG = path.resolve(__dirname, "../config/scenes.json");

async function main() {
  const eventBus = new EventBus();
  const deviceManager = new DeviceManager(eventBus);
  const sceneManager = new SceneManager(eventBus, deviceManager);
  const visitorSession = new VisitorSession(eventBus);
  const claudeClient = new ClaudeClient(process.env.ANTHROPIC_API_KEY);
  const chatManager = new ChatManager(eventBus, visitorSession, claudeClient);
  let bridgeManager = null;

  console.log(`=== 展場中控系統啟動中 (${IS_CLOUD ? "雲端模式" : "本地模式"}) ===`);

  if (IS_CLOUD) {
    // 雲端模式：不載入本地裝置，建立 BridgeManager 等展場連線
    bridgeManager = new BridgeManager(eventBus, deviceManager);
    console.log("[Init] 雲端模式 — 等待展場 Bridge 連線...");
    console.log(`[Init] Bridge 密鑰: ${BRIDGE_SECRET}`);
  } else {
    // 本地模式：直接載入裝置
    console.log("[Init] 載入裝置設定...");
    await deviceManager.loadFromConfig(DEVICES_CONFIG);
  }

  // 載入場景定義（兩種模式都需要）
  console.log("[Init] 載入場景設定...");
  sceneManager.loadFromConfig(SCENES_CONFIG);

  // Express 設定
  const app = express();
  app.use(express.json());
  // --- 💡 宇恆：在這裡加入自動報到路由 ---
  app.post("/api/devices/register", (req, res) => {
    const { id, ip } = req.body;
    
    // 從 deviceManager 的 devices Map 中找出你的 ESP32
    // 你的 ID 應該是 "esp32_main" (對應 scenes.json)
    const device = deviceManager.devices.get(id);

    if (device) {
      // 動態更新該裝置的 baseUrl
      device.baseUrl = `http://${ip}`;
      console.log(`📡 [Device] 設備報到成功: [${id}] 門牌更新為 -> ${ip}`);
      res.json({ status: "success", ip });
    } else {
      console.log(`⚠️ [Device] 報到失敗: 系統中沒有識別碼為 [${id}] 的裝置`);
      res.status(404).json({ status: "error", message: "Device ID not found" });
    }
  });
  // ----------------------------------------
  app.use(express.static(path.resolve(__dirname, "../public")));
  app.set("scenesConfigPath", SCENES_CONFIG);

  // API 路由
  app.use("/api", createApiRoutes(deviceManager, eventBus));
  app.use("/api", createSceneRoutes(sceneManager));
  app.use("/api", createChatRoutes(chatManager, visitorSession));

  
  // Bridge 狀態端點（雲端模式）
  if (IS_CLOUD) {
    app.get("/api/bridge", (req, res) => {
      res.json({
        connected: bridgeManager.isConnected,
        deviceCount: deviceManager.devices.size,
      });
    });
  }

  // 向下相容舊端點
  app.get("/play/audio/:day", (req, res) => {
    req.url = `/api${req.url}`;
    app.handle(req, res);
  });
  app.post("/esp32/touch", (req, res) => {
    req.url = "/api/esp32/touch";
    app.handle(req, res);
  });

  // YOLO 攝影機影像代理 — 把 YoloTD Python server 的 MJPEG 串流轉發給前端
  app.get("/api/camera/feed", (req, res) => {
    const yoloDevice = deviceManager.get("yolo_detector");
    const yoloUrl = (yoloDevice && yoloDevice.url) || "http://localhost:8000";

    const url = new URL("/video_feed", yoloUrl);
    const nativeHttp = url.protocol === "https:" ? require("https") : require("http");

    const proxyReq = nativeHttp.get(url.href, { timeout: 5000 }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, {
        "Content-Type": proxyRes.headers["content-type"] || "multipart/x-mixed-replace; boundary=frame",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      });
      proxyRes.pipe(res);
    });

    proxyReq.on("error", () => {
      if (!res.headersSent) {
        res.status(502).json({ error: "YOLO 攝影機無法連線" });
      }
    });

    req.on("close", () => proxyReq.destroy());
  });

  // YOLO 攝影機單張快照
  app.get("/api/camera/snapshot", async (req, res) => {
    const yoloDevice = deviceManager.get("yolo_detector");
    const yoloUrl = (yoloDevice && yoloDevice.url) || "http://localhost:8000";

    const url = new URL("/video_feed", yoloUrl);
    const nativeHttp = url.protocol === "https:" ? require("https") : require("http");

    const proxyReq = nativeHttp.get(url.href, { timeout: 5000 }, (proxyRes) => {
      const chunks = [];
      let headerParsed = false;
      let jpegStart = false;

      proxyRes.on("data", (chunk) => {
        if (!headerParsed) {
          const str = chunk.toString("binary");
          const idx = str.indexOf("\r\n\r\n");
          if (idx !== -1) {
            headerParsed = true;
            jpegStart = true;
            chunks.push(Buffer.from(str.substring(idx + 4), "binary"));
          }
        } else {
          const str = chunk.toString("binary");
          const boundary = str.indexOf("--frame");
          if (boundary !== -1) {
            chunks.push(Buffer.from(str.substring(0, boundary), "binary"));
            const jpeg = Buffer.concat(chunks);
            res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-cache" });
            res.end(jpeg);
            proxyReq.destroy();
          } else {
            chunks.push(chunk);
          }
        }
      });
    });

    proxyReq.on("error", () => {
      if (!res.headersSent) {
        res.status(502).json({ error: "YOLO 攝影機無法連線" });
      }
    });

    req.on("close", () => proxyReq.destroy());
  });

  app.get("/", (req, res) => {
    res.sendFile(path.resolve(__dirname, "../public/index.html"));
  });

  // HTTP + WebSocket Server
  const server = http.createServer(app);

  // Dashboard WebSocket（/ws）
  const wss = new WebSocketServer({ noServer: true });

  // App 聊天 WebSocket（/app）
  const wssApp = new WebSocketServer({ noServer: true });

  // Bridge WebSocket（/bridge）— 只在雲端模式啟用
  const wssBridge = IS_CLOUD ? new WebSocketServer({ noServer: true }) : null;

  // 根據 URL 路徑分流 WebSocket 升級請求
  server.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;

    if (pathname === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    } else if (pathname === "/app") {
      wssApp.handleUpgrade(req, socket, head, (ws) => wssApp.emit("connection", ws, req));
    } else if (pathname === "/bridge" && IS_CLOUD) {
      // 驗證 Bridge 密鑰
      const url = new URL(req.url, `http://${req.headers.host}`);
      const secret = url.searchParams.get("secret");
      if (secret !== BRIDGE_SECRET) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
      wssBridge.handleUpgrade(req, socket, head, (ws) => wssBridge.emit("connection", ws, req));
    } else {
      socket.destroy();
    }
  });

  // Dashboard WebSocket 連線處理
  wss.on("connection", (ws) => {
    console.log("[WS] Dashboard 客戶端已連線");
    eventBus.registerWSClient(ws);

    ws.send(JSON.stringify({
      type: "init",
      payload: {
        devices: deviceManager.getAllStatus(),
        scenes: sceneManager.listScenes(),
        events: eventBus.getHistory(30),
        cloudMode: IS_CLOUD,
        bridgeConnected: bridgeManager?.isConnected || false,
      },
    }));

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        handleWSMessage(msg, ws, deviceManager, sceneManager);
      } catch (err) {
        ws.send(JSON.stringify({ type: "error", payload: { message: err.message } }));
      }
    });
  });

  // App 聊天 WebSocket 連線處理
  wssApp.on("connection", (ws) => {
    chatManager.handleAppConnection(ws);
  });

  // Bridge WebSocket 連線處理（雲端模式）
  if (wssBridge) {
    wssBridge.on("connection", (ws) => {
      bridgeManager.handleConnection(ws);
    });
  }

  // 啟動伺服器
  server.listen(PORT, () => {
    console.log("=== 展場中控系統已就緒 ===");
    console.log(`  Dashboard: http://localhost:${PORT}`);
    console.log(`  App Chat:  ws://localhost:${PORT}/app`);
    if (IS_CLOUD) {
      console.log(`  Bridge:    ws://localhost:${PORT}/bridge?secret=${BRIDGE_SECRET}`);
      console.log(`  模式:      雲端（等待展場 Bridge 連線）`);
    } else {
      console.log(`  模式:      本地`);
      console.log(`  裝置數量:  ${deviceManager.devices.size}`);
    }
    console.log(`  場景數量:  ${sceneManager.scenes.size}`);
  });

  // 優雅關閉
  const shutdown = async () => {
    console.log("\n[Shutdown] 正在關閉系統...");
    await deviceManager.destroyAll();
    server.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function handleWSMessage(msg, ws, deviceManager, sceneManager) {
  switch (msg.type) {
    case "executeDevice": {
      const { deviceId, action, params } = msg.payload;
      deviceManager.executeOnDevice(deviceId, action, params || {})
        .then((result) => ws.send(JSON.stringify({ type: "result", requestId: msg.requestId, payload: result })))
        .catch((err) => ws.send(JSON.stringify({ type: "error", requestId: msg.requestId, payload: { message: err.message } })));
      break;
    }
    case "triggerScene": {
      const { sceneName } = msg.payload;
      sceneManager.triggerScene(sceneName)
        .then((result) => ws.send(JSON.stringify({ type: "result", requestId: msg.requestId, payload: result })))
        .catch((err) => ws.send(JSON.stringify({ type: "error", requestId: msg.requestId, payload: { message: err.message } })));
      break;
    }
    case "getStatus": {
      ws.send(JSON.stringify({
        type: "status",
        requestId: msg.requestId,
        payload: {
          devices: deviceManager.getAllStatus(),
          scenes: sceneManager.listScenes(),
        },
      }));
      break;
    }
  }
}

main().catch((err) => {
  console.error("啟動失敗:", err);
  process.exit(1);
});
