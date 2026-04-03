// REST API 路由 — 裝置控制、狀態查詢
// 同時保留與原 TouchLightServer 的向下相容端點

const express = require("express");
const WizLightDevice = require("../devices/WizLightDevice");

/**
 * @param {DeviceManager} deviceManager
 * @param {EventBus} eventBus
 */
function createApiRoutes(deviceManager, eventBus) {
  const router = express.Router();

  // ==============================================
  //  裝置管理 API
  // ==============================================

  // 取得所有裝置狀態
  router.get("/devices", (req, res) => {
    res.json({ devices: deviceManager.getAllStatus() });
  });

  // 取得單一裝置狀態
  router.get("/devices/:id", (req, res) => {
    const device = deviceManager.get(req.params.id);
    if (!device) return res.status(404).json({ error: `裝置 "${req.params.id}" 不存在` });
    res.json(device.getStatus());
  });

  // 取得裝置支援的動作列表
  router.get("/devices/:id/actions", (req, res) => {
    const device = deviceManager.get(req.params.id);
    if (!device) return res.status(404).json({ error: `裝置 "${req.params.id}" 不存在` });
    res.json({ actions: device.getSupportedActions() });
  });

  // 對裝置執行動作
  router.post("/devices/:id/execute", async (req, res) => {
    const { action, params } = req.body;
    if (!action) return res.status(400).json({ error: "缺少 action 參數" });

    try {
      const result = await deviceManager.executeOnDevice(req.params.id, action, params || {});
      res.json({ status: "ok", result });
    } catch (err) {
      res.status(500).json({ status: "error", error: err.message });
    }
  });

  // ==============================================
  //  Wiz 燈泡掃描 API
  // ==============================================

  router.get("/wiz/scan", async (req, res) => {
    try {
      const lights = await WizLightDevice.discover(4000, 3);
      res.json({ count: lights.length, lights });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==============================================
  //  事件歷史 API
  // ==============================================

  router.get("/events", (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    res.json({ events: eventBus.getHistory(limit) });
  });

  // ==============================================
  //  向下相容端點（原 TouchLightServer）
  // ==============================================

  // 莫蘭迪色系對應表（移植自原 server.js）
  const colorMap = {
    1: { r: 255, g: 130, b: 130 }, 2: { r: 255, g: 200, b: 120 },
    3: { r: 240, g: 240, b: 150 }, 4: { r: 150, g: 230, b: 180 },
    5: { r: 130, g: 190, b: 255 }, 6: { r: 180, g: 160, b: 255 },
    7: { r: 255, g: 180, b: 220 },
  };

  const audioMap = {
    1: "星期一.wav", 2: "星期二.wav", 3: "星期三.wav",
    4: "星期四.wav", 5: "星期五.wav", 6: "星期六日.wav", 7: "星期六日.wav",
  };

  // 相容原 /play/audio/:day 端點
  router.get("/play/audio/:day", async (req, res) => {
    const day = parseInt(req.params.day);
    const audio = deviceManager.get("audio");
    if (audio?.isPlaying) {
      return res.status(423).json({ status: "busy", message: "音樂播放中" });
    }

    const esp = deviceManager.get("esp32_main");
    const color = colorMap[day];

    // 觸發對應燈效
    if (esp && color) {
      if (day <= 2) esp.execute("setMode", { mode: "random_blocks", color });
      else if (day <= 4) esp.execute("setMode", { mode: "block_wave", color });
      else if (day <= 6) esp.execute("flashEffect", { color });
      else esp.execute("setMode", { mode: "ripple", color });
    }

    // 播放音檔
    if (audio && audioMap[day]) {
      audio.execute("play", { file: audioMap[day] }).then(() => {
        if (esp) esp.execute("off");
      });
    }

    res.json({ status: "ok", audioFile: audioMap[day] });
  });

  // 相容原 /esp32/touch 端點
  router.post("/esp32/touch", async (req, res) => {
    const audio = deviceManager.get("audio");
    if (audio?.isPlaying) {
      return res.json({ status: "busy", message: "Ignored because music is playing" });
    }

    const dayMap = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
    const day = req.body.index !== undefined ? req.body.index + 1 : dayMap[req.body.day];

    if (!day || day < 1 || day > 7) {
      return res.status(400).json({ status: "error", message: "無效的 day 參數" });
    }

    const esp = deviceManager.get("esp32_main");
    const color = colorMap[day];

    if (esp && color) {
      if (day <= 2) esp.execute("setMode", { mode: "random_blocks", color });
      else if (day <= 4) esp.execute("setMode", { mode: "block_wave", color });
      else if (day <= 6) esp.execute("flashEffect", { color });
      else esp.execute("setMode", { mode: "ripple", color });
    }

    if (audio && audioMap[day]) {
      audio.execute("play", { file: audioMap[day] }).then(() => {
        if (esp) esp.execute("off");
      });
    }

    res.json({ status: "ok" });
  });

  return router;
}

module.exports = createApiRoutes;
