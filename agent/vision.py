"""
視覺模組 — 攝影機串流 + 多模態偵測（姿態 / 手勢 / 臉部表情）

事件：
  publish('gaze', { x: 0..1, y: 0..1 })
  publish('gesture', { type: '...', ... })

支援的 gesture type：
  Pose:  wave, bow, raise_hand, heart, approach, retreat, idle
  Hand:  thumbs_up, victory, thumbs_down, pointing_up, i_love_you
  Face:  face_smile, face_surprise, face_frown, face_nod

判斷模式：
  有設 C230_RTSP_URL → real 模式（cv2 + mediapipe）
    - 值為 "0" 或數字 → 本機攝影機（筆電 webcam）
    - 值為 rtsp:// URL → RTSP 串流
  沒設                → mock 模式
"""

import asyncio
import math
import os
import time


# PoseLandmark 索引
NOSE = 0
LEFT_SHOULDER = 11
RIGHT_SHOULDER = 12
LEFT_WRIST = 15
RIGHT_WRIST = 16
LEFT_HIP = 23
RIGHT_HIP = 25


class VisionModule:
    def __init__(self, server) -> None:
        self.server = server
        self.rtsp_url = os.environ.get("C230_RTSP_URL")
        self.fps = float(os.environ.get("VISION_FPS", "5"))
        self._show_preview = os.environ.get("VISION_SHOW", "1") == "1"

        # ---- 通用 cooldown（gesture type → last fire time）----
        self._last_gesture_time: dict = {}
        self._gesture_cooldowns: dict = {
            "wave": 5.0,
            "bow": 5.0,
            "raise_hand": 4.0,
            "heart": 6.0,
            "approach": 8.0,
            "retreat": 8.0,
            "idle": 15.0,
            "thumbs_up": 4.0,
            "victory": 4.0,
            "thumbs_down": 4.0,
            "pointing_up": 4.0,
            "i_love_you": 5.0,
            "face_smile": 3.0,
            "face_surprise": 3.0,
            "face_frown": 4.0,
            "face_nod": 3.0,
        }

        # ---- Pose 偵測狀態 ----
        self._wrist_history: list = []          # [(t, x, y)] 揮手用
        self._nose_y_history: list = []         # [(t, y)] 鞠躬 + 點頭用
        self._shoulder_width_history: list = [] # [(t, width)] 靠近/遠離用
        self._idle_landmarks_prev: list = []    # 上一幀的關鍵點，idle 偵測用
        self._idle_still_since: float = 0       # 開始靜止的時間

        # ---- 預覽用 ----
        self._display_gestures: dict = {}  # {type: expire_time}

    def _check_cooldown(self, gesture_type: str) -> bool:
        """回傳 True 代表冷卻中（不應觸發）"""
        cd = self._gesture_cooldowns.get(gesture_type, 3.0)
        last = self._last_gesture_time.get(gesture_type, 0)
        return (time.time() - last) < cd

    async def _fire_gesture(self, gesture_type: str, data: dict = None) -> bool:
        """發射手勢事件，自動處理 cooldown。回傳 True 代表已發射。"""
        if self._check_cooldown(gesture_type):
            return False
        self._last_gesture_time[gesture_type] = time.time()
        payload = {"type": gesture_type, **(data or {})}
        print(f"[vision] 偵測到: {gesture_type} {data or ''}")
        await self.server.publish("gesture", payload)
        self._display_gestures[gesture_type] = time.time() + 2
        return True

    # ==================================================
    #  啟動入口
    # ==================================================

    async def start(self) -> None:
        if self.rtsp_url:
            print(f"[vision] real mode — source: {self.rtsp_url}")
            try:
                await self._real_loop()
                return
            except Exception as exc:
                print(f"[vision] real mode 失敗，退回 mock: {exc}")
                import traceback; traceback.print_exc()

        print("[vision] mock mode — gaze 每 5s、wave 每 30s")
        await self._mock_loop()

    # ==================================================
    #  Mock
    # ==================================================

    async def _mock_loop(self) -> None:
        asyncio.create_task(self._mock_wave_loop())
        t = 0
        while True:
            x = 0.5 + 0.3 * math.sin(t * 0.5)
            await self.server.publish("gaze", {"x": x, "y": 0.5, "mock": True})
            t += 1
            await asyncio.sleep(5)

    async def _mock_wave_loop(self) -> None:
        await asyncio.sleep(20)
        while True:
            await self.server.publish("gesture", {
                "type": "wave", "x": 0.6, "y": 0.3, "side": "right", "mock": True,
            })
            await asyncio.sleep(30)

    # ==================================================
    #  Real：多模態偵測主迴圈
    # ==================================================

    async def _real_loop(self) -> None:
        import cv2
        import mediapipe as mp
        from mediapipe.tasks.python import BaseOptions
        from mediapipe.tasks.python.vision import (
            PoseLandmarker, PoseLandmarkerOptions,
            RunningMode,
        )

        agent_dir = os.path.dirname(__file__)

        # ---- 1. PoseLandmarker（必要）----
        pose_model = os.path.join(agent_dir, "pose_landmarker_lite.task")
        if not os.path.exists(pose_model):
            raise RuntimeError(f"找不到模型檔: {pose_model}")
        pose_landmarker = PoseLandmarker.create_from_options(PoseLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=pose_model),
            running_mode=RunningMode.VIDEO,
            num_poses=1,
            min_pose_detection_confidence=0.6,
            min_tracking_confidence=0.5,
        ))
        print("[vision] PoseLandmarker 載入成功")

        # ---- 2. GestureRecognizer（選用）----
        gesture_recognizer = None
        gesture_model = os.path.join(agent_dir, "gesture_recognizer.task")
        if os.path.exists(gesture_model):
            from mediapipe.tasks.python.vision import (
                GestureRecognizer, GestureRecognizerOptions,
            )
            gesture_recognizer = GestureRecognizer.create_from_options(GestureRecognizerOptions(
                base_options=BaseOptions(model_asset_path=gesture_model),
                running_mode=RunningMode.VIDEO,
                num_hands=2,
                min_hand_detection_confidence=0.5,
                min_tracking_confidence=0.5,
            ))
            print("[vision] GestureRecognizer 載入成功")
        else:
            print("[vision] gesture_recognizer.task 不存在，手勢辨識停用")

        # ---- 3. FaceLandmarker（選用）----
        face_landmarker = None
        face_model = os.path.join(agent_dir, "face_landmarker.task")
        if os.path.exists(face_model):
            from mediapipe.tasks.python.vision import (
                FaceLandmarker, FaceLandmarkerOptions,
            )
            face_landmarker = FaceLandmarker.create_from_options(FaceLandmarkerOptions(
                base_options=BaseOptions(model_asset_path=face_model),
                running_mode=RunningMode.VIDEO,
                num_faces=1,
                min_face_detection_confidence=0.5,
                min_tracking_confidence=0.5,
                output_face_blendshapes=True,
            ))
            print("[vision] FaceLandmarker 載入成功")
        else:
            print("[vision] face_landmarker.task 不存在，臉部表情停用")

        # ---- 攝影機 ----
        source = int(self.rtsp_url) if self.rtsp_url.isdigit() else self.rtsp_url
        print(f"[vision] 開啟攝影機: {source}")

        if isinstance(source, str) and source.startswith("rtsp"):
            # RTSP 低延遲：TCP 傳輸 + 最小緩衝
            os.environ["OPENCV_FFMPEG_CAPTURE_OPTIONS"] = (
                "rtsp_transport;tcp"
                "|fflags;nobuffer"
                "|flags;low_delay"
            )
            cap = cv2.VideoCapture(source, cv2.CAP_FFMPEG)
            cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        else:
            cap = cv2.VideoCapture(source)

        if not cap.isOpened():
            raise RuntimeError(f"無法開啟攝影機: {source}")

        print("[vision] 攝影機已開啟，開始多模態偵測")
        if self._show_preview:
            print("[vision] 預覽視窗已開啟（按 Q 關閉）")

        interval = 1.0 / self.fps
        frame_ts = 0
        frame_count = 0

        is_rtsp = isinstance(source, str) and source.startswith("rtsp")

        # RTSP：用獨立線程持續抓最新幀，主迴圈永遠拿到最新的
        if is_rtsp:
            import threading
            self._latest_frame = None
            self._frame_lock = threading.Lock()
            self._grab_running = True

            def _grab_loop():
                while self._grab_running:
                    ok, frame = cap.read()
                    if ok:
                        with self._frame_lock:
                            self._latest_frame = frame

            grab_thread = threading.Thread(target=_grab_loop, daemon=True)
            grab_thread.start()
            print("[vision] RTSP 獨立抓幀線程已啟動")

        try:
            while True:
                if is_rtsp:
                    with self._frame_lock:
                        frame = self._latest_frame
                    if frame is None:
                        await asyncio.sleep(0.05)
                        continue
                    ok = True
                else:
                    ok, frame = cap.read()
                if not ok:
                    print("[vision] 讀取幀失敗，重試...")
                    await asyncio.sleep(1)
                    continue

                frame = cv2.flip(frame, -1)  # 180度旋轉（上下+左右翻轉）
                rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)
                frame_ts += int(interval * 1000)
                frame_count += 1

                # ---- A. Pose（每幀）----
                pose_result = pose_landmarker.detect_for_video(mp_image, frame_ts)
                if pose_result.pose_landmarks and len(pose_result.pose_landmarks) > 0:
                    lm = pose_result.pose_landmarks[0]

                    # gaze
                    nose = lm[NOSE]
                    if nose.visibility > 0.5:
                        await self.server.publish("gaze", {"x": nose.x, "y": nose.y})

                    # pose gestures
                    await self._detect_wave(lm)
                    await self._detect_bow(lm)
                    await self._detect_raise_hand(lm)
                    await self._detect_heart(lm)
                    await self._detect_approach_retreat(lm)
                    await self._detect_idle(lm)

                    # 預覽：畫 pose 骨架點
                    if self._show_preview:
                        h, w = frame.shape[:2]
                        for landmark in lm:
                            cx, cy = int(landmark.x * w), int(landmark.y * h)
                            cv2.circle(frame, (cx, cy), 4, (0, 255, 0), -1)

                # ---- B. Hand（每 2 幀）----
                if gesture_recognizer and frame_count % 2 == 0:
                    gesture_result = gesture_recognizer.recognize_for_video(mp_image, frame_ts)
                    await self._process_hand_gestures(gesture_result)

                    # 預覽：畫手部關鍵點
                    if self._show_preview and gesture_result.hand_landmarks:
                        h, w = frame.shape[:2]
                        for hand_lm in gesture_result.hand_landmarks:
                            for pt in hand_lm:
                                cx, cy = int(pt.x * w), int(pt.y * h)
                                cv2.circle(frame, (cx, cy), 3, (255, 165, 0), -1)

                # ---- C. Face（每 3 幀）----
                if face_landmarker and frame_count % 3 == 0:
                    face_result = face_landmarker.detect_for_video(mp_image, frame_ts)
                    await self._process_face_expression(face_result)

                    # 預覽：畫臉部輪廓點（只畫部分避免太密）
                    if self._show_preview and face_result.face_landmarks:
                        h, w = frame.shape[:2]
                        for face_lm in face_result.face_landmarks:
                            for i, pt in enumerate(face_lm):
                                if i % 10 == 0:  # 每 10 個畫一個
                                    cx, cy = int(pt.x * w), int(pt.y * h)
                                    cv2.circle(frame, (cx, cy), 2, (255, 0, 255), -1)

                # ---- 預覽視窗 ----
                if self._show_preview:
                    self._draw_status_panel(frame)
                    cv2.imshow("Vision - Multi Detection", frame)
                    if cv2.waitKey(1) & 0xFF == ord('q'):
                        print("[vision] 預覽視窗已關閉，偵測繼續")
                        self._show_preview = False
                        cv2.destroyAllWindows()

                await asyncio.sleep(interval)
        finally:
            if is_rtsp:
                self._grab_running = False
            cap.release()
            pose_landmarker.close()
            if gesture_recognizer:
                gesture_recognizer.close()
            if face_landmarker:
                face_landmarker.close()
            if self._show_preview:
                cv2.destroyAllWindows()

    def _draw_status_panel(self, frame):
        """在預覽視窗左上角畫偵測狀態面板"""
        import cv2
        now = time.time()
        active = [g for g, t in self._display_gestures.items() if t > now]

        y_offset = 30
        if active:
            for gesture in active:
                label = gesture.upper().replace("_", " ")
                cv2.putText(frame, label, (15, y_offset),
                            cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 0), 2)
                y_offset += 30
        else:
            cv2.putText(frame, "Waiting for gesture...", (15, y_offset),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.7, (200, 200, 200), 2)

    # ==================================================
    #  A. Pose 偵測方法
    # ==================================================

    async def _detect_wave(self, lm) -> bool:
        if self._check_cooldown("wave"):
            return False

        now = time.time()
        sides = [
            ("right", RIGHT_WRIST, RIGHT_SHOULDER),
            ("left", LEFT_WRIST, LEFT_SHOULDER),
        ]

        for side, wrist_idx, shoulder_idx in sides:
            wrist = lm[wrist_idx]
            shoulder = lm[shoulder_idx]
            if wrist.visibility < 0.5 or shoulder.visibility < 0.5:
                continue
            if wrist.y >= shoulder.y:
                continue

            self._wrist_history.append((now, wrist.x, wrist.y))
            self._wrist_history = [(t, x, y) for t, x, y in self._wrist_history if now - t < 1.5]

            if len(self._wrist_history) < 5:
                return False

            direction_changes = 0
            for i in range(2, len(self._wrist_history)):
                prev_dx = self._wrist_history[i-1][1] - self._wrist_history[i-2][1]
                curr_dx = self._wrist_history[i][1] - self._wrist_history[i-1][1]
                if prev_dx * curr_dx < 0 and abs(curr_dx) > 0.005:
                    direction_changes += 1

            if direction_changes >= 2:
                self._wrist_history.clear()
                return await self._fire_gesture("wave", {"x": wrist.x, "y": wrist.y, "side": side})

        return False

    async def _detect_bow(self, lm) -> bool:
        """鼻子 Y 在 0.5s 內下降 > 0.15 → 鞠躬"""
        if self._check_cooldown("bow"):
            return False

        now = time.time()
        nose = lm[NOSE]
        if nose.visibility < 0.5:
            return False

        self._nose_y_history.append((now, nose.y))
        self._nose_y_history = [(t, y) for t, y in self._nose_y_history if now - t < 1.0]

        if len(self._nose_y_history) < 3:
            return False

        oldest_y = self._nose_y_history[0][1]
        current_y = nose.y
        # y 增加代表頭往下（鞠躬）
        if current_y - oldest_y > 0.15:
            self._nose_y_history.clear()
            return await self._fire_gesture("bow")

        return False

    async def _detect_raise_hand(self, lm) -> bool:
        """手腕高於頭頂 + 沒有左右擺動（排除揮手）"""
        if self._check_cooldown("raise_hand"):
            return False

        nose = lm[NOSE]
        if nose.visibility < 0.5:
            return False

        # 頭頂估算：鼻子 y 再往上一點
        head_top_y = nose.y - 0.1

        sides = [
            ("right", RIGHT_WRIST, RIGHT_SHOULDER),
            ("left", LEFT_WRIST, LEFT_SHOULDER),
        ]

        for side, wrist_idx, shoulder_idx in sides:
            wrist = lm[wrist_idx]
            if wrist.visibility < 0.5:
                continue
            # 手腕高於頭頂
            if wrist.y < head_top_y:
                # 排除揮手（如果 wrist_history 有方向變化就不算舉手）
                now = time.time()
                recent = [(t, x, y) for t, x, y in self._wrist_history if now - t < 1.0]
                dir_changes = 0
                for i in range(2, len(recent)):
                    prev_dx = recent[i-1][1] - recent[i-2][1]
                    curr_dx = recent[i][1] - recent[i-1][1]
                    if prev_dx * curr_dx < 0:
                        dir_changes += 1
                if dir_changes < 2:
                    return await self._fire_gesture("raise_hand", {"side": side, "x": wrist.x, "y": wrist.y})

        return False

    async def _detect_heart(self, lm) -> bool:
        """雙手腕都高於肩膀且 x 距離很近 → 比愛心"""
        if self._check_cooldown("heart"):
            return False

        lw = lm[LEFT_WRIST]
        rw = lm[RIGHT_WRIST]
        ls = lm[LEFT_SHOULDER]
        rs = lm[RIGHT_SHOULDER]

        if any(p.visibility < 0.5 for p in [lw, rw, ls, rs]):
            return False

        # 雙手腕都高於肩膀
        if lw.y >= ls.y or rw.y >= rs.y:
            return False

        # 雙手靠近（x 距離小）
        if abs(lw.x - rw.x) < 0.15:
            # 確認在頭部附近（高於肩膀中點一段距離）
            shoulder_mid_y = (ls.y + rs.y) / 2
            wrist_mid_y = (lw.y + rw.y) / 2
            if wrist_mid_y < shoulder_mid_y - 0.05:
                return await self._fire_gesture("heart")

        return False

    async def _detect_approach_retreat(self, lm) -> bool:
        """肩寬占比變化 > 30% → 靠近/遠離"""
        ls = lm[LEFT_SHOULDER]
        rs = lm[RIGHT_SHOULDER]
        if ls.visibility < 0.5 or rs.visibility < 0.5:
            return False

        now = time.time()
        width = abs(ls.x - rs.x)
        self._shoulder_width_history.append((now, width))
        self._shoulder_width_history = [(t, w) for t, w in self._shoulder_width_history if now - t < 2.0]

        if len(self._shoulder_width_history) < 5:
            return False

        oldest_w = self._shoulder_width_history[0][1]
        if oldest_w < 0.01:
            return False

        ratio = width / oldest_w

        if ratio > 1.3 and not self._check_cooldown("approach"):
            self._shoulder_width_history.clear()
            return await self._fire_gesture("approach", {"direction": "closer"})
        elif ratio < 0.7 and not self._check_cooldown("retreat"):
            self._shoulder_width_history.clear()
            return await self._fire_gesture("retreat", {"direction": "farther"})

        return False

    async def _detect_idle(self, lm) -> bool:
        """所有關鍵點 3 秒內移動量極小 → 站定不動"""
        if self._check_cooldown("idle"):
            return False

        # 取 5 個關鍵點
        key_indices = [NOSE, LEFT_SHOULDER, RIGHT_SHOULDER, LEFT_WRIST, RIGHT_WRIST]
        current = [(lm[i].x, lm[i].y) for i in key_indices if lm[i].visibility > 0.5]

        if len(current) < 3:
            self._idle_still_since = 0
            return False

        now = time.time()

        if self._idle_landmarks_prev and len(self._idle_landmarks_prev) == len(current):
            total_delta = sum(
                abs(c[0] - p[0]) + abs(c[1] - p[1])
                for c, p in zip(current, self._idle_landmarks_prev)
            )
            if total_delta < 0.02:  # 非常小的移動量
                if self._idle_still_since == 0:
                    self._idle_still_since = now
                elif now - self._idle_still_since >= 3.0:
                    self._idle_still_since = 0
                    self._idle_landmarks_prev = current
                    return await self._fire_gesture("idle")
            else:
                self._idle_still_since = 0
        else:
            self._idle_still_since = 0

        self._idle_landmarks_prev = current
        return False

    # ==================================================
    #  B. Hand 手勢辨識
    # ==================================================

    # MediaPipe GestureRecognizer 類別名 → 我們的 gesture type
    _HAND_GESTURE_MAP = {
        "Thumb_Up": "thumbs_up",
        "Victory": "victory",
        "Thumb_Down": "thumbs_down",
        "Pointing_Up": "pointing_up",
        "ILoveYou": "i_love_you",
    }

    async def _process_hand_gestures(self, result) -> None:
        if not result.gestures:
            return

        for hand_gestures in result.gestures:
            if not hand_gestures:
                continue
            top = hand_gestures[0]  # 最高信心度的手勢
            if top.score < 0.7:
                continue

            gesture_type = self._HAND_GESTURE_MAP.get(top.category_name)
            if gesture_type:
                await self._fire_gesture(gesture_type)

    # ==================================================
    #  C. Face 表情偵測
    # ==================================================

    async def _process_face_expression(self, result) -> None:
        if not result.face_blendshapes or len(result.face_blendshapes) == 0:
            return

        # 建立 blendshape name → score 的 map
        bs = {}
        for category in result.face_blendshapes[0]:
            bs[category.category_name] = category.score

        # 微笑
        smile_score = (bs.get("mouthSmileLeft", 0) + bs.get("mouthSmileRight", 0)) / 2
        if smile_score > 0.6:
            await self._fire_gesture("face_smile")
            return  # 同幀只發一個臉部表情

        # 驚訝（嘴巴張開 + 眼睛睜大）
        jaw_open = bs.get("jawOpen", 0)
        eye_wide = (bs.get("eyeWideLeft", 0) + bs.get("eyeWideRight", 0)) / 2
        if jaw_open > 0.5 and eye_wide > 0.4:
            await self._fire_gesture("face_surprise")
            return

        # 皺眉
        brow_down = (bs.get("browDownLeft", 0) + bs.get("browDownRight", 0)) / 2
        if brow_down > 0.5:
            await self._fire_gesture("face_frown")
            return

        # 點頭（用鼻子 Y 歷史偵測快速上下）
        await self._detect_nod()

    async def _detect_nod(self) -> bool:
        """用 nose_y_history 偵測點頭（1s 內 Y 方向反轉 >= 2 次）"""
        if self._check_cooldown("face_nod"):
            return False

        now = time.time()
        recent = [(t, y) for t, y in self._nose_y_history if now - t < 1.0]
        if len(recent) < 4:
            return False

        direction_changes = 0
        for i in range(2, len(recent)):
            prev_dy = recent[i-1][1] - recent[i-2][1]
            curr_dy = recent[i][1] - recent[i-1][1]
            if prev_dy * curr_dy < 0 and abs(curr_dy) > 0.008:
                direction_changes += 1

        if direction_changes >= 2:
            return await self._fire_gesture("face_nod")

        return False

    # ==================================================
    #  指令處理
    # ==================================================

    async def on_command(self, command: str, params: dict) -> None:
        return
