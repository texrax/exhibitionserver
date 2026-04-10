"""
準備訓練資料集：將圖片和標註複製到 YOLO 訓練目錄結構
80% train / 20% val 隨機分割
"""

import os
import shutil
import random

IMAGES_SRC = r"C:\Users\31493\OneDrive\桌面\新增資料夾"
LABELS_SRC = r"C:\Users\31493\Downloads\labels_my-project-name_2026-04-10-09-50-58"
DATASET_DIR = os.path.join(os.path.dirname(__file__), "dataset")
TRAIN_RATIO = 0.8
SEED = 42

def main():
    # 建立目錄結構
    for split in ("train", "val"):
        os.makedirs(os.path.join(DATASET_DIR, "images", split), exist_ok=True)
        os.makedirs(os.path.join(DATASET_DIR, "labels", split), exist_ok=True)

    # 列出所有圖片，找對應的標註
    images = sorted([f for f in os.listdir(IMAGES_SRC) if f.lower().endswith((".png", ".jpg", ".jpeg"))])
    pairs = []
    for img_name in images:
        stem = os.path.splitext(img_name)[0]
        label_name = stem + ".txt"
        label_path = os.path.join(LABELS_SRC, label_name)
        if os.path.exists(label_path):
            pairs.append((img_name, label_name))
        else:
            print(f"[WARN] 找不到標註: {label_name}，跳過")

    print(f"共 {len(pairs)} 組圖片+標註")

    # 隨機分割
    random.seed(SEED)
    random.shuffle(pairs)
    split_idx = int(len(pairs) * TRAIN_RATIO)
    train_pairs = pairs[:split_idx]
    val_pairs = pairs[split_idx:]

    # 複製檔案
    for split, split_pairs in [("train", train_pairs), ("val", val_pairs)]:
        for img_name, label_name in split_pairs:
            shutil.copy2(
                os.path.join(IMAGES_SRC, img_name),
                os.path.join(DATASET_DIR, "images", split, img_name),
            )
            shutil.copy2(
                os.path.join(LABELS_SRC, label_name),
                os.path.join(DATASET_DIR, "labels", split, label_name),
            )
        print(f"{split}: {len(split_pairs)} 張")

    print(f"資料集已建立: {DATASET_DIR}")

if __name__ == "__main__":
    main()
