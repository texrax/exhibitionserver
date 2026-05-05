"""
視覺模組 — 攝影機串流 + 訪客頭部位置 + 揮手偵測

事件：
  publish('gaze', { x: 0..1, y: 0..1 })
  publish('gesture', { type: 'wave', x?, y?, side: 'left'|'right' })

判斷模式：
  有設 C230_RTSP_URL → real 模式（cv2 + mediapipe pose）
    - 值為 "0" 或數字 → 本機攝影機（筆電 webcam）
    - 值為 rtsp:// URL → RTSP 串流（C230 等外接攝影機）
  沒設                → mock 模式（gaze 左右搖擺，每 30s 模擬一次 wave）
"""

import asyncio
import math
import os
import time


class VisionModule:
    def __init__(self, server) -> None:
        self.server = server
        self.rtsp_url = os.environ.get("C230_RTSP_URL")
        self.fps = float(os.environ.get("VISION_FPS", "5"))
        # 揮手偵測狀態
        self._wrist_history: list = []  # [(timestamp, x, y)]
        self._last_wave_time: float = 0
        self._wave_cooldown: float = 5.0  # 秒
        # 是否顯示預覽視窗（env VISION_SHOW=1 開啟）
        self._show_preview = os.environ.get("VISION_SHOW", "1") == "1"

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
    #  Real：cv2 + mediapipe PoseLandmarker (v0.10.x tasks API)
    # =========================================
    async def _real_loop(self) -> None:
        import cv2
        import mediapipe as mp
        from mediapipe.tasks.python import BaseOptions
        from mediapipe.tasks.python.vision import (
            PoseLandmarker,
            PoseLandmarkerOptions,
            RunningMode,
        )

        # 模型檔路徑
        model_path = os.path.join(os.path.dirname(__file__), "pose_landmarker_lite.task")
        if not os.path.exists(model_path):
            raise RuntimeError(f"找不到模型檔: {model_path}")

        options = PoseLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=model_path),
            running_mode=RunningMode.VIDEO,
            num_poses=1,
            min_pose_detection_confidence=0.6,
            min_tracking_confidence=0.5,
        )
        landmarker = PoseLandmarker.create_from_options(options)

        # 決定攝影機來源：數字 → 本機 webcam，否則當 URL
        source = int(self.rtsp_url) if self.rtsp_url.isdigit() else self.rtsp_url
        print(f"[vision] 開啟攝影機: {source}")
        cap = cv2.VideoCapture(source)

        if not cap.isOpened():
            raise RuntimeError(f"無法開啟攝影機: {source}")

        print("[vision] 攝影機已開啟，開始偵測")
        if self._show_preview:
            print("[vision] 預覽視窗已開啟（按 Q 關閉預覽，偵測繼續）")
        interval = 1.0 / self.fps
        self._wave_display_until = 0
        frame_ts = 0

        # PoseLandmark 索引
        NOSE = 0
        LEFT_SHOULDER = 11
        RIGHT_SHOULDER = 12
        LEFT_WRIST = 15
        RIGHT_WRIST = 16

        try:
            while True:
                ok, frame = cap.read()
                if not ok:
                    print("[vision] 讀取幀失敗，重試...")
                    await asyncio.sleep(1)
                    continue

                frame = cv2.flip(frame, 1)  # 鏡像
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)

                # 轉成 mediapipe Image
                mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                frame_ts += int(interval * 1000)  # ms 遞增
                result = landmarker.detect_for_video(mp_image, frame_ts)

                if result.pose_landmarks and len(result.pose_landmarks) > 0:
                    lm = result.pose_landmarks[0]  # 第一個人

                    # --- gaze：用鼻子位置代表訪客頭部 ---
                    nose = lm[NOSE]
                    if nose.visibility > 0.5:
                        await self.server.publish("gaze", {"x": nose.x, "y": nose.y})

                    # --- 揮手偵測 ---
                    wave_detected = await self._detect_wave_tasks(
                        lm, LEFT_WRIST, LEFT_SHOULDER, RIGHT_WRIST, RIGHT_SHOULDER
                    )
                    if wave_detected:
                        self._wave_display_until = time.time() + 2

                    # --- 預覽視窗：畫骨架 ---
                    if self._show_preview:
                        h, w = frame.shape[:2]
                        for landmark in lm:
                            cx, cy = int(landmark.x * w), int(landmark.y * h)
                            cv2.circle(frame, (cx, cy), 4, (0, 255, 0), -1)

                # --- 預覽視窗 ---
                if self._show_preview:
                    if time.time() < self._wave_display_until:
                        cv2.putText(frame, "WAVE DETECTED!", (50, 80),
                                    cv2.FONT_HERSHEY_SIMPLEX, 2, (0, 255, 0), 4)
                    else:
                        cv2.putText(frame, "Wave your hand!", (50, 50),
                                    cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 255, 255), 2)

                    cv2.imshow("Vision - Wave Detection", frame)
                    if cv2.waitKey(1) & 0xFF == ord('q'):
                        print("[vision] 預覽視窗已關閉，偵測繼續")
                        self._show_preview = False
                        cv2.destroyAllWindows()

                await asyncio.sleep(interval)
        finally:
            cap.release()
            landmarker.close()
            if self._show_preview:
                cv2.destroyAllWindows()

    async def _detect_wave_tasks(self, lm, l_wrist_idx, l_shoulder_idx, r_wrist_idx, r_shoulder_idx) -> bool:
        """新版 tasks API 用的揮手偵測，回傳 True 代表偵測到揮手"""
        now = time.time()

        # cooldown 中不偵測
        if now - self._last_wave_time < self._wave_cooldown:
            return False

        # 檢查左右手哪隻舉起來了
        sides = [
            ("right", r_wrist_idx, r_shoulder_idx),
            ("left", l_wrist_idx, l_shoulder_idx),
        ]

        for side, wrist_idx, shoulder_idx in sides:
            wrist = lm[wrist_idx]
            shoulder = lm[shoulder_idx]

            if wrist.visibility < 0.5 or shoulder.visibility < 0.5:
                continue

            # 手腕必須高於肩膀（y 值越小越高）
            if wrist.y >= shoulder.y:
                continue

            # 記錄手腕位置
            self._wrist_history.append((now, wrist.x, wrist.y))

            # 只保留最近 1.5 秒的記錄
            self._wrist_history = [
                (t, x, y) for t, x, y in self._wrist_history if now - t < 1.5
            ]

            # 需要至少 5 個樣本
            if len(self._wrist_history) < 5:
                return False

            # 計算水平方向反轉次數
            direction_changes = 0
            for i in range(2, len(self._wrist_history)):
                prev_dx = self._wrist_history[i-1][1] - self._wrist_history[i-2][1]
                curr_dx = self._wrist_history[i][1] - self._wrist_history[i-1][1]
                if prev_dx * curr_dx < 0 and abs(curr_dx) > 0.005:
                    direction_changes += 1

            # 方向反轉 >= 2 次 = 揮手
            if direction_changes >= 2:
                print(f"[vision] 揮手偵測！ side={side}, x={wrist.x:.2f}, y={wrist.y:.2f}")
                await self.server.publish("gesture", {
                    "type": "wave",
                    "x": wrist.x,
                    "y": wrist.y,
                    "side": side,
                })
                self._last_wave_time = now
                self._wrist_history.clear()
                return True

        return False

    async def on_command(self, command: str, params: dict) -> None:
        # 視覺模組目前不接收指令
        return
