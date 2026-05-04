"""
視覺模組 — C230 RTSP 串流 + 訪客頭部位置偵測

事件：
  publish('gaze', { x: 0..1, y: 0..1, distance?: number })
  publish('gesture', { type: 'wave' | 'approach' | ... })

判斷模式：
  有設 C230_RTSP_URL → real 模式（cv2 + mediapipe pose）  ← TODO 硬體到位後實作
  沒設                → mock 模式（每 5s 發左右搖擺的假 gaze）
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

        print("[vision] mock mode — 每 5 秒發假 gaze（左右搖擺）")
        await self._mock_loop()

    # =========================================
    #  Mock：固定節奏發左右搖擺的 gaze 給 Node 端，方便驗證 setLookAt 端到端 wiring
    # =========================================
    async def _mock_loop(self) -> None:
        t = 0
        while True:
            x = 0.5 + 0.3 * math.sin(t * 0.5)  # 0.2..0.8
            y = 0.5
            await self.server.publish("gaze", {"x": x, "y": y, "mock": True})
            t += 1
            await asyncio.sleep(5)

    # =========================================
    #  Real：cv2 + mediapipe — TODO 硬體到位後實作
    # =========================================
    async def _real_loop(self) -> None:
        # 預期實作：
        #   import cv2
        #   import mediapipe as mp
        #   cap = cv2.VideoCapture(self.rtsp_url)
        #   pose = mp.solutions.pose.Pose()
        #   每 1/fps 秒：
        #     ok, frame = cap.read()
        #     若 ok：results = pose.process(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB))
        #     若 results.pose_landmarks：
        #       nose = results.pose_landmarks.landmark[mp.solutions.pose.PoseLandmark.NOSE]
        #       await self.server.publish('gaze', {'x': nose.x, 'y': nose.y})
        #
        # 也可以在這裡加揮手偵測 → publish('gesture', {'type': 'wave'})
        raise NotImplementedError("real vision mode 尚未實作 — 需要 cv2 + mediapipe + RTSP 連線")

    async def on_command(self, command: str, params: dict) -> None:
        # 視覺模組目前不接收指令
        return
