"""
Webcam 預覽 + 截圖工具（用於收集訓練資料）

操作：
  空白鍵 — 截圖存檔到 captures/
  Q / ESC — 離開
"""

import os
import sys
import time

import cv2

CAMERA_SOURCE = int(os.environ.get("CAMERA_SOURCE", "1"))
SAVE_DIR = os.path.join(os.path.dirname(__file__), "captures")
os.makedirs(SAVE_DIR, exist_ok=True)

if sys.platform == "win32":
    # MSMF 有時無法開啟，自動 fallback 到 DSHOW
    cap = cv2.VideoCapture(CAMERA_SOURCE, cv2.CAP_MSMF)
    if not cap.isOpened():
        print(f"[Camera] MSMF 失敗，改用 DSHOW...")
        cap = cv2.VideoCapture(CAMERA_SOURCE, cv2.CAP_DSHOW)
    if not cap.isOpened():
        print(f"[Camera] DSHOW 也失敗，嘗試不指定 backend...")
        cap = cv2.VideoCapture(CAMERA_SOURCE)
elif sys.platform == "darwin":
    cap = cv2.VideoCapture(CAMERA_SOURCE, cv2.CAP_AVFOUNDATION)
else:
    cap = cv2.VideoCapture(CAMERA_SOURCE)

cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1920)
cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 1080)
cap.set(cv2.CAP_PROP_FPS, 30)

if not cap.isOpened():
    print(f"[ERROR] 無法開啟攝影機 {CAMERA_SOURCE}")
    sys.exit(1)

print(f"[Camera] 已開啟攝影機 {CAMERA_SOURCE} ({cap.getBackendName()})")
print(f"[Camera] 截圖存檔目錄: {SAVE_DIR}")
print(f"[操作] 空白鍵=截圖  Q/ESC=離開")

count = 0
while True:
    ret, frame = cap.read()
    if not ret:
        time.sleep(0.1)
        continue

    # 裁切：取中間正方形區域（去掉左右多餘地板）
    h, w = frame.shape[:2]
    crop_size = min(h, w)
    x_start = (w - crop_size) // 2
    frame = frame[:, x_start:x_start + crop_size]

    cv2.imshow("Webcam - Space:Capture  Q:Quit", frame)
    key = cv2.waitKey(1) & 0xFF

    if key == ord(" "):
        filename = time.strftime("%Y%m%d_%H%M%S") + f"_{count:03d}.jpg"
        filepath = os.path.join(SAVE_DIR, filename)
        cv2.imwrite(filepath, frame)
        count += 1
        print(f"[截圖] {filepath} ({count} 張)")
    elif key == ord("q") or key == 27:
        break

cap.release()
cv2.destroyAllWindows()
print(f"[結束] 共截圖 {count} 張")
