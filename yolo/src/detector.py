"""
通用物件偵測器 (Object Detection)
支援多模型合併偵測 (例如: YOLOv8n/YOLO11s + Custom Chopsticks Model)
並支援類別過濾 (只保留人、碗、筷子)
"""

from typing import Optional, List, Dict, Any, Union
from ultralytics import YOLO
import cv2
import numpy as np
import random
import os

class ObjectDetector:
    """支援多模型的物件偵測器"""

    def __init__(
        self,
        model_path: Union[str, List[str]] = "yolov8n.pt",
        model_profile: str = "v8",
        classes: Optional[List[int]] = None,
        model_roles: Optional[List[str]] = None,
    ):
        """
        初始化檢測器
        
        Args:
            model_path: 可以是單一字串 (路徑)，也可以是路徑列表 ["yolov8n.pt", "best.pt"]
            model_profile: v8 或 y11
        """
        self.models = []
        self.colors = {}
        self.model_profile = model_profile

        # 定義我們要保留的通用模型類別 (COCO ID)
        # 0: person, 45: bowl
        self.ALLOWED_COCO_CLASSES = [0, 45]

        paths = [model_path] if isinstance(model_path, str) else model_path
        input_roles = model_roles[:] if model_roles else self._default_roles(len(paths))
        if len(input_roles) != len(paths):
            raise ValueError("model_roles length must match model_path length")

        loaded_models = []
        loaded_roles = []
        for path, role in zip(paths, input_roles):
            try:
                if os.path.exists(path) or self._is_builtin_weight_name(path):
                    model = YOLO(path)
                    loaded_models.append(model)
                    loaded_roles.append(role)
                    print(f"[OK] 模型載入成功: {path} (role={role})")
                else:
                    print(f"[WARN] 找不到模型檔案: {path} (role={role}), 跳過")
            except Exception as e:
                print(f"[ERROR] 模型 {path} (role={role}) 載入失敗: {e}")

        self.models = loaded_models
        self.model_roles = loaded_roles
        if "bowl" in self.model_roles:
            # 獨立 bowl 模型啟用時，通用模型只保留 person，避免重複 bowl 框。
            self.ALLOWED_COCO_CLASSES = [0]

        if self.model_roles and self.model_roles[0] != "general":
            print("[WARN] 第一個成功載入的模型不是 general，偵測可能不正確")

    def _default_roles(self, count: int) -> List[str]:
        if count <= 1:
            return ["general"]
        if count == 2:
            return ["general", "chopsticks"]
        if count == 3:
            return ["general", "chopsticks", "food"]
        if count == 4:
            return ["general", "chopsticks", "food", "bowl"]
        return ["general"] + [f"custom_{idx}" for idx in range(1, count)]

    def _is_builtin_weight_name(self, path: str) -> bool:
        """Allow canonical Ultralytics model names without requiring local files."""
        builtin_prefix_by_profile = {
            "v8": "yolov8",
            "y11": "yolo11",
        }
        expected_prefix = builtin_prefix_by_profile.get(self.model_profile, "")
        filename = os.path.basename(path).lower()
        return bool(expected_prefix) and filename.startswith(expected_prefix) and filename.endswith(".pt")

    def _build_detection(
        self,
        detection_id: int,
        label_name: str,
        cls_id: int,
        conf: float,
        x1: float,
        y1: float,
        x2: float,
        y2: float,
    ) -> Dict[str, Any]:
        center = {"x": int((x1 + x2) / 2), "y": int((y1 + y2) / 2)}
        payload: Dict[str, Any] = {
            "id": detection_id,
            "label": label_name,
            "class_id": cls_id,
            "confidence": round(conf, 3),
            "bbox": {"x1": int(x1), "y1": int(y1), "x2": int(x2), "y2": int(y2)},
            "center": center,
        }
        if label_name == "chopsticks":
            payload["camera_position"] = center
        return payload

    def _append_general_detections(
        self,
        image: np.ndarray,
        conf_threshold: float,
        all_detections: List[Dict[str, Any]],
        global_id_counter: int,
    ) -> int:
        general_model = self.models[0]
        results = general_model(image, conf=conf_threshold, classes=self.ALLOWED_COCO_CLASSES, verbose=False)

        for result in results:
            if result.boxes:
                for box in result.boxes:
                    x1, y1, x2, y2 = box.xyxy[0].tolist()
                    conf = float(box.conf[0])
                    cls_id = int(box.cls[0])
                    label_name = general_model.names[cls_id]

                    all_detections.append(
                        self._build_detection(
                            detection_id=global_id_counter,
                            label_name=label_name,
                            cls_id=cls_id,
                            conf=conf,
                            x1=x1,
                            y1=y1,
                            x2=x2,
                            y2=y2,
                        )
                    )
                    global_id_counter += 1

        return global_id_counter

    def _append_chopsticks_detections(
        self,
        model: YOLO,
        image: np.ndarray,
        w_img: int,
        h_img: int,
        detections: List[Dict[str, Any]],
        custom_conf: float,
        custom_iou_threshold: Optional[float],
        custom_max_det: int,
        custom_min_area_ratio: Optional[float],
        custom_max_area_ratio: Optional[float],
        custom_min_aspect_ratio: Optional[float],
        custom_low_aspect_high_conf: Optional[float],
        custom_top_k: Optional[int],
    ) -> None:
        custom_kwargs = {"conf": custom_conf, "max_det": custom_max_det, "verbose": False}
        if custom_iou_threshold is not None:
            custom_kwargs["iou"] = custom_iou_threshold
        results = model(image, **custom_kwargs)

        custom_detections = []
        for result in results:
            if result.boxes:
                for box in result.boxes:
                    x1, y1, x2, y2 = box.xyxy[0].tolist()
                    conf = float(box.conf[0])
                    box_w = max(1.0, x2 - x1)
                    box_h = max(1.0, y2 - y1)
                    area_ratio = (box_w * box_h) / float(w_img * h_img)
                    aspect_ratio = max(box_w / box_h, box_h / box_w)

                    if custom_min_area_ratio is not None and area_ratio < custom_min_area_ratio:
                        continue
                    if custom_max_area_ratio is not None and area_ratio > custom_max_area_ratio:
                        continue
                    if (
                        custom_min_aspect_ratio is not None
                        and aspect_ratio < custom_min_aspect_ratio
                        and (
                            custom_low_aspect_high_conf is None
                            or conf < custom_low_aspect_high_conf
                        )
                    ):
                        continue

                    custom_detections.append(
                        self._build_detection(
                            detection_id=-1,
                            label_name="chopsticks",
                            cls_id=999,
                            conf=conf,
                            x1=x1,
                            y1=y1,
                            x2=x2,
                            y2=y2,
                        )
                    )

        if custom_top_k is not None and custom_top_k > 0 and custom_detections:
            custom_detections = sorted(custom_detections, key=lambda d: d["confidence"], reverse=True)[:custom_top_k]

        detections.extend(custom_detections)

    def _append_food_detections(
        self,
        model: YOLO,
        image: np.ndarray,
        detections: List[Dict[str, Any]],
        food_conf_threshold: float,
        food_iou_threshold: Optional[float],
        food_max_det: int,
    ) -> None:
        food_kwargs = {"conf": food_conf_threshold, "max_det": food_max_det, "verbose": False}
        if food_iou_threshold is not None:
            food_kwargs["iou"] = food_iou_threshold
        results = model(image, **food_kwargs)

        for result in results:
            if result.boxes:
                for box in result.boxes:
                    x1, y1, x2, y2 = box.xyxy[0].tolist()
                    conf = float(box.conf[0])
                    cls_id = int(box.cls[0])
                    label_name = str(model.names[cls_id])
                    detections.append(
                        self._build_detection(
                            detection_id=-1,
                            label_name=label_name,
                            cls_id=cls_id,
                            conf=conf,
                            x1=x1,
                            y1=y1,
                            x2=x2,
                            y2=y2,
                        )
                    )

    def _append_bowl_detections(
        self,
        model: YOLO,
        image: np.ndarray,
        w_img: int,
        h_img: int,
        detections: List[Dict[str, Any]],
        bowl_conf_threshold: float,
        bowl_iou_threshold: Optional[float],
        bowl_max_det: int,
        bowl_min_area_ratio: Optional[float],
        bowl_max_area_ratio: Optional[float],
        bowl_max_aspect_ratio: Optional[float],
        bowl_top_k: Optional[int],
    ) -> None:
        bowl_kwargs = {"conf": bowl_conf_threshold, "max_det": bowl_max_det, "verbose": False}
        if bowl_iou_threshold is not None:
            bowl_kwargs["iou"] = bowl_iou_threshold
        results = model(image, **bowl_kwargs)

        bowl_detections = []
        for result in results:
            if result.boxes:
                for box in result.boxes:
                    x1, y1, x2, y2 = box.xyxy[0].tolist()
                    conf = float(box.conf[0])
                    box_w = max(1.0, x2 - x1)
                    box_h = max(1.0, y2 - y1)
                    area_ratio = (box_w * box_h) / float(w_img * h_img)
                    aspect_ratio = max(box_w / box_h, box_h / box_w)

                    if bowl_min_area_ratio is not None and area_ratio < bowl_min_area_ratio:
                        continue
                    if bowl_max_area_ratio is not None and area_ratio > bowl_max_area_ratio:
                        continue
                    if bowl_max_aspect_ratio is not None and aspect_ratio > bowl_max_aspect_ratio:
                        continue

                    bowl_detections.append(
                        self._build_detection(
                            detection_id=-1,
                            label_name="bowl",
                            cls_id=45,
                            conf=conf,
                            x1=x1,
                            y1=y1,
                            x2=x2,
                            y2=y2,
                        )
                    )

        if bowl_top_k is not None and bowl_top_k > 0 and bowl_detections:
            bowl_detections = sorted(bowl_detections, key=lambda d: d["confidence"], reverse=True)[:bowl_top_k]

        detections.extend(bowl_detections)

    def detect(
        self,
        image: np.ndarray,
        conf_threshold: float = 0.5,
        custom_conf_threshold: Optional[float] = None,
        custom_iou_threshold: Optional[float] = None,
        custom_max_det: int = 300,
        custom_min_area_ratio: Optional[float] = None,
        custom_max_area_ratio: Optional[float] = None,
        custom_min_aspect_ratio: Optional[float] = None,
        custom_low_aspect_high_conf: Optional[float] = None,
        custom_top_k: Optional[int] = None,
        food_conf_threshold: Optional[float] = None,
        food_iou_threshold: Optional[float] = None,
        food_max_det: int = 50,
        bowl_conf_threshold: Optional[float] = None,
        bowl_iou_threshold: Optional[float] = None,
        bowl_max_det: int = 10,
        bowl_min_area_ratio: Optional[float] = None,
        bowl_max_area_ratio: Optional[float] = None,
        bowl_max_aspect_ratio: Optional[float] = None,
        bowl_top_k: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        """執行偵測並合併結果，並過濾不需要的類別"""
        if not self.models:
            return []

        all_detections = []
        global_id_counter = 0
        custom_conf = conf_threshold if custom_conf_threshold is None else custom_conf_threshold
        food_conf = conf_threshold if food_conf_threshold is None else food_conf_threshold
        bowl_conf = conf_threshold if bowl_conf_threshold is None else bowl_conf_threshold
        h_img, w_img = image.shape[:2]

        global_id_counter = self._append_general_detections(
                image=image,
                conf_threshold=conf_threshold,
                all_detections=all_detections,
                global_id_counter=global_id_counter,
            )

        for idx, model in enumerate(self.models[1:], start=1):
            role = self.model_roles[idx]
            staged_detections: List[Dict[str, Any]] = []
            if role == "chopsticks":
                self._append_chopsticks_detections(
                    model=model,
                    image=image,
                    w_img=w_img,
                    h_img=h_img,
                    detections=staged_detections,
                    custom_conf=custom_conf,
                    custom_iou_threshold=custom_iou_threshold,
                    custom_max_det=custom_max_det,
                    custom_min_area_ratio=custom_min_area_ratio,
                    custom_max_area_ratio=custom_max_area_ratio,
                    custom_min_aspect_ratio=custom_min_aspect_ratio,
                    custom_low_aspect_high_conf=custom_low_aspect_high_conf,
                    custom_top_k=custom_top_k,
                )
            elif role == "food":
                self._append_food_detections(
                    model=model,
                    image=image,
                    detections=staged_detections,
                    food_conf_threshold=food_conf,
                    food_iou_threshold=food_iou_threshold,
                    food_max_det=food_max_det,
                )
            elif role == "bowl":
                self._append_bowl_detections(
                    model=model,
                    image=image,
                    w_img=w_img,
                    h_img=h_img,
                    detections=staged_detections,
                    bowl_conf_threshold=bowl_conf,
                    bowl_iou_threshold=bowl_iou_threshold,
                    bowl_max_det=bowl_max_det,
                    bowl_min_area_ratio=bowl_min_area_ratio,
                    bowl_max_area_ratio=bowl_max_area_ratio,
                    bowl_max_aspect_ratio=bowl_max_aspect_ratio,
                    bowl_top_k=bowl_top_k,
                )
            else:
                continue

            for det in staged_detections:
                det["id"] = global_id_counter
                all_detections.append(det)
                global_id_counter += 1

        return all_detections

    def draw_results(self, image: np.ndarray, detections: List[Dict[str, Any]]) -> np.ndarray:
        output = image.copy()
        for obj in detections:
            bbox = obj["bbox"]
            label = obj["label"]
            
            # 顏色：人=綠，碗=藍，筷子=紅
            if label == "person":
                color = (0, 255, 0)
            elif label == "bowl":
                color = (255, 0, 0)
            elif label == "chopsticks":
                color = (0, 0, 255)
            elif label == "vegetables":
                color = (0, 180, 0)
            elif label == "pork":
                color = (255, 140, 180)
            elif label == "beef":
                color = (60, 90, 180)
            else:
                if label not in self.colors:
                    self.colors[label] = (random.randint(50,255), random.randint(50,255), random.randint(50,255))
                color = self.colors[label]

            cv2.rectangle(output, (bbox["x1"], bbox["y1"]), (bbox["x2"], bbox["y2"]), color, 2)
            track_suffix = f"#{obj['track_id']}" if obj.get("track_id") is not None else ""
            cv2.putText(output, f"{label}{track_suffix}", (bbox["x1"], bbox["y1"]-5), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 2)
            
        return output
