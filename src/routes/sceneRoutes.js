// 場景控制 REST API 路由

const express = require("express");

/**
 * @param {SceneManager} sceneManager
 */
function createSceneRoutes(sceneManager) {
  const router = express.Router();

  // 取得所有場景列表
  router.get("/scenes", (req, res) => {
    res.json({ scenes: sceneManager.listScenes() });
  });

  // 觸發指定場景（立即回應，背景執行）
  router.post("/scenes/:name/trigger", (req, res) => {
    const sceneName = req.params.name;
    const scene = sceneManager.scenes.get(sceneName);
    if (!scene) {
      return res.status(404).json({ status: "error", error: `場景 "${sceneName}" 不存在` });
    }

    if (sceneManager._activeScene && scene.exclusive !== false) {
      return res.json({ status: "busy", activeScene: sceneManager._activeScene });
    }

    // 立即回應 ESP32，場景在背景執行
    res.json({ status: "ok", scene: sceneName });

    sceneManager.triggerScene(sceneName).catch((err) => {
      console.error(`[SceneRoutes] 場景 "${sceneName}" 背景執行失敗:`, err.message);
    });
  });

  // 重新載入場景設定
  router.post("/scenes/reload", (req, res) => {
    try {
      const configPath = req.app.get("scenesConfigPath");
      sceneManager.reloadConfig(configPath);
      res.json({ status: "ok", count: sceneManager.scenes.size });
    } catch (err) {
      res.status(500).json({ status: "error", error: err.message });
    }
  });

  return router;
}

module.exports = createSceneRoutes;
