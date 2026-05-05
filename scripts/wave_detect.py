"""
揮手偵測 - 使用 MediaPipe Pose
偵測邏輯：手腕高於肩膀 + 手腕左右擺動 = 揮手
按 Q 離開
"""

import cv2
import mediapipe as mp
import time

mp_pose = mp.solutions.pose
mp_draw = mp.solutions.drawing_utils

cap = cv2.VideoCapture(0)
if not cap.isOpened():
    print("無法開啟攝影機")
    exit(1)

pose = mp_pose.Pose(min_detection_confidence=0.7, min_tracking_confidence=0.5)

# 揮手偵測狀態
wrist_history = []  # 記錄手腕 x 座標歷史
wave_detected = False
wave_cooldown = 0

print("攝影機已開啟，對著鏡頭揮手試試！按 Q 離開。")

while cap.isOpened():
    ret, frame = cap.read()
    if not ret:
        break

    frame = cv2.flip(frame, 1)  # 鏡像
    rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
    results = pose.process(rgb)

    status_text = ""

    if results.pose_landmarks:
        landmarks = results.pose_landmarks.landmark

        # 取得右手腕和右肩膀
        r_wrist = landmarks[mp_pose.PoseLandmark.RIGHT_WRIST]
        r_shoulder = landmarks[mp_pose.PoseLandmark.RIGHT_SHOULDER]
        # 左手也偵測
        l_wrist = landmarks[mp_pose.PoseLandmark.LEFT_WRIST]
        l_shoulder = landmarks[mp_pose.PoseLandmark.LEFT_SHOULDER]

        # 判斷哪隻手舉起來了（手腕高於肩膀）
        hand_raised = False
        active_wrist_x = None

        if r_wrist.y < r_shoulder.y and r_wrist.visibility > 0.5:
            hand_raised = True
            active_wrist_x = r_wrist.x
        elif l_wrist.y < l_shoulder.y and l_wrist.visibility > 0.5:
            hand_raised = True
            active_wrist_x = l_wrist.x

        if hand_raised and active_wrist_x is not None:
            wrist_history.append(active_wrist_x)
            # 只保留最近 15 個 frame
            if len(wrist_history) > 15:
                wrist_history.pop(0)

            # 偵測擺動：計算方向改變次數
            if len(wrist_history) >= 8:
                direction_changes = 0
                for i in range(2, len(wrist_history)):
                    prev_dir = wrist_history[i-1] - wrist_history[i-2]
                    curr_dir = wrist_history[i] - wrist_history[i-1]
                    if prev_dir * curr_dir < 0 and abs(curr_dir) > 0.01:
                        direction_changes += 1

                if direction_changes >= 3:
                    wave_detected = True
                    wave_cooldown = time.time()
                    wrist_history.clear()
        else:
            wrist_history.clear()

        # 畫骨架
        mp_draw.draw_landmarks(frame, results.pose_landmarks, mp_pose.POSE_CONNECTIONS)

    # 顯示揮手狀態
    if wave_detected and time.time() - wave_cooldown < 2:
        status_text = "WAVE DETECTED!"
        cv2.putText(frame, status_text, (50, 80),
                    cv2.FONT_HERSHEY_SIMPLEX, 2, (0, 255, 0), 4)
    else:
        wave_detected = False
        cv2.putText(frame, "Wave your hand!", (50, 50),
                    cv2.FONT_HERSHEY_SIMPLEX, 1, (255, 255, 255), 2)

    cv2.imshow("Wave Detection", frame)

    if cv2.waitKey(1) & 0xFF == ord('q'):
        break

cap.release()
cv2.destroyAllWindows()
