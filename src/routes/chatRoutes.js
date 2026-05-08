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

  // 模擬互動完成（測試用 / 控制台「結束互動」也走這個）
  router.post("/chat/simulate-ready", (req, res) => {
    const { day = 3, food = "vegetable" } = req.body || {};

    // 直接推進狀態到 READY_TO_CHAT，不 fire visitor:day_completed（避免再次觸發 after_day_selection）
    visitorSession.forceReadyToChat({ day, food });

    // 不論 state 如何都強制重發通知，避免被 READY_TO_CHAT 卡住
    chatManager.forceNotify();

    res.json({
      status: "ok",
      message: "已強制進入 ready_to_chat + notify",
      session: visitorSession.getStatus(),
      chat: chatManager.getStatus(),
    });
  });

  // 救援：立即重送 interactions_complete 給 App（不依賴 session 狀態）
  router.post("/chat/notify-now", (req, res) => {
    chatManager.forceNotify();
    res.json({
      status: "ok",
      message: "已嘗試推送 interactions_complete",
      chat: chatManager.getStatus(),
      session: visitorSession.getStatus(),
    });
  });

  return router;
}

module.exports = createChatRoutes;