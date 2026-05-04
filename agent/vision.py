"""
視覺模組 — C230 RTSP 串流 + 訪客頭部位置 + 揮手偵測

事件：
  publish('gaze', { x: 0..1, y: 0..1 })
  publish('gesture', { type: 'wave', x?, y?, side: 'left'|'right' })

判斷模式：
  有設 C230_RTSP_URL → real 模式（cv2 + mediapipe pose）  ← TODO 硬體到位後實作
  沒設                → mock 模式（gaze 左右搖擺，每 30s 模擬一次 wave）
"""

import asyncio
import math
import os


class VisionModule:
    def __init__(self, server) -> None:
        self.server = server
        self.rtsp_url = os.environ.get("C230_RTSP_URL")
        self.fps = float(os.environ.get("VISION_FPS", "5"))

    async def start(self) -> None:
        if self.rtsp_url:
            print(f"[vision] real mode — RTSP: {self.rtsp_url}")
            try:
                await self._real_loop()
                return
            except Exception as exc:
                print(f"[vision] real mode 失敗，退回 mock: {exc}")

        print("[vision] mock mode — gaze 每 5s、wave 每 30s")
        await self._mock_loop()

    # =========================================
    #  Mock：發 gaze 流動 + 偶爾模擬 wave，驗證端到端 wiring
    # =========================================
    async def _mock_loop(self) -> None:
        asyncio.create_task(self._mock_wave_loop())
        t = 0
        while True:
            x = 0.5 + 0.3 * math.sin(t * 0.5)  # 0.2..0.8
            y = 0.5
            await self.server.publish("gaze", {"x": x, "y": y, "mock": True})
            t += 1
            await asyncio.sleep(5)

    async def _mock_wave_loop(self) -> None:
        # Node 端 AgentController 在 Wiz 燈泡掃描後才初始化（~15s），太早發 gesture 沒人訂閱
        await asyncio.sleep(20)
        while True:
            await self.server.publish("gesture", {
                "type": "wave",
                "x": 0.6,
                "y": 0.3,
                "side": "right",
                "mock": True,
            })
            await asyncio.sleep(30)

    # =========================================
    #  Real：cv2 + mediapipe — TODO 硬體到位後實作
    # =========================================
    async def _real_loop(self) -> None:
        # 預期實作要點：
        #   import cv2, mediapipe as mp
        #   cap = cv2.VideoCapture(self.rtsp_url)
        #   pose = mp.solutions.pose.Pose(min_detection_confidence=0.6)
        #
        #   每 1/fps 秒：
        #     ok, frame = cap.read()
        #     results = pose.process(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
        #     if results.pose_landmarks:
        #         lm = results.pose_landmarks.landmark
        #         # gaze：nose 位置
        #         nose = lm[mp.solutions.pose.PoseLandmark.NOSE]
        #         await self.server.publish('gaze', {'x': nose.x, 'y': nose.y})
        #
        #         # wave detection：手腕高於肩 + 1 秒內水平往復 ≥ 2 次反向
        #         #   self._wrist_history.append((time, lm[16].x, lm[16].y))  # right_wrist
        #         #   過濾 1 秒內樣本
        #         #   若 wrist.y < shoulder.y AND 水平方向反轉次數 ≥ 2:
        #         #       publish('gesture', {'type': 'wave', 'x': wrist.x, 'y': wrist.y, 'side': 'right'})
        #         #       cooldown 5 秒避免連發
        raise NotImplementedError(
            "real vision 尚未實作 — 需安裝 cv2 + mediapipe，並補完 wave detection（見上方註解）"
        )

    async def on_command(self, command: str, params: dict) -> None:
        # 視覺模組目前不接收指令
        return
