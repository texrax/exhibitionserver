"""
Fine-tune 現有食物模型
基於 models/food.pt 繼續訓練，產生新的 best.pt
"""

import os
from ultralytics import YOLO

BASE_MODEL = os.path.join(os.path.dirname(__file__), "..", "models", "food.pt")
DATASET_YAML = os.path.join(os.path.dirname(__file__), "dataset.yaml")
PROJECT_DIR = os.path.join(os.path.dirname(__file__), "runs")

def main():
    print(f"基礎模型: {BASE_MODEL}")
    print(f"資料集: {DATASET_YAML}")

    model = YOLO(BASE_MODEL)

    model.train(
        data=DATASET_YAML,
        epochs=50,
        imgsz=640,
        batch=4,
        patience=15,
        lr0=0.001,
        project=PROJECT_DIR,
        name="food_finetune",
        exist_ok=True,
        verbose=True,
    )

    # 顯示結果路徑
    best_path = os.path.join(PROJECT_DIR, "food_finetune", "weights", "best.pt")
    print(f"\n訓練完成！最佳模型: {best_path}")
    print(f"確認效果後，複製到 models/food.pt 即可替換：")
    print(f"  copy \"{best_path}\" \"{os.path.join(os.path.dirname(__file__), '..', 'models', 'food.pt')}\"")

if __name__ == "__main__":
    main()
