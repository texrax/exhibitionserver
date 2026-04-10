// 聊天 Debug API — 查看狀態、手動重置、模擬互動完成

const express = require("express");

/**
 * @param {ChatManager} chatManager
 * @param {VisitorSession} visitorSession
 */
function createChatRoutes(chatManager, visitorSession) {
  const router = express.Router();

  // 查看聊天 + session 狀態
  router.get("/chat/status", (req, res) => {
    res.json({
      session: visitorSession.getStatus(),
      chat: chatManager.getStatus(),
    });
  });

  // 強制重置
  router.post("/chat/reset", (req, res) => {
    chatManager.forceReset();
    res.json({ status: "ok", message: "已重置" });
  });

  // 模擬互動完成（測試用）
  router.post("/chat/simulate-ready", (req, res) => {
    const { day = 3, food = "vegetable" } = req.body || {};

    // 透過 EventBus 模擬場景完成事件
    visitorSession.eventBus.publish("scene:finished", { scene: `play_day_${day}` });
    visitorSession.eventBus.publish("scene:finished", { scene: `yolo_deliver_${food}` });

    res.json({
      status: "ok",
      message: "已模擬互動完成",
      session: visitorSession.getStatus(),
    });
  });

  return router;
}

module.exports = createChatRoutes;