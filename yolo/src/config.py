"""
共用設定讀取模組
server.py 和 webcam_demo.py 都從這裡讀取場景/事件/推論設定
"""

import os
from typing import Any, Dict


def read_scene_config() -> Dict[str, Any]:
    return {
        "left_person_zone": os.environ.get("LEFT_PERSON_ZONE", ""),
        "right_person_zone": os.environ.get("RIGHT_PERSON_ZONE", ""),
        "left_bowl_zone": os.environ.get("LEFT_BOWL_ZONE", ""),
        "right_bowl_zone": os.environ.get("RIGHT_BOWL_ZONE", ""),
        "table_valid_zone": os.environ.get("TABLE_VALID_ZONE", ""),
    }


def read_event_config() -> Dict[str, Any]:
    return {
        "attach_distance": float(os.environ.get("EVENT_ATTACH_DISTANCE", "95")),
        "release_distance": float(os.environ.get("EVENT_RELEASE_DISTANCE", "125")),
        "attach_frames": int(os.environ.get("EVENT_ATTACH_FRAMES", "3")),
        "release_frames": int(os.environ.get("EVENT_RELEASE_FRAMES", "3")),
        "food_memory_frames": int(os.environ.get("EVENT_FOOD_MEMORY_FRAMES", "8")),
        "cooldown_frames": int(os.environ.get("EVENT_COOLDOWN_FRAMES", "18")),
        "event_display_frames": int(os.environ.get("EVENT_DISPLAY_FRAMES", "45")),
        "max_idle_frames": int(os.environ.get("EVENT_MAX_IDLE_FRAMES", "12")),
    }


def read_detect_conf() -> float:
    return float(os.environ.get("DETECT_CONF", "0.35"))


def read_chopsticks_postprocess(profile: str) -> Dict[str, Any]:
    min_aspect_default = "2.5" if profile == "y11" else "1.0"
    return {
        "custom_conf_threshold": float(os.environ.get("CHOPSTICKS_CONF", "0.15")),
        "custom_iou_threshold": float(os.environ.get("CHOPSTICKS_IOU", "0.45")),
        "custom_max_det": int(os.environ.get("CHOPSTICKS_MAX_DET", "50")),
        "custom_min_area_ratio": float(os.environ.get("CHOPSTICKS_MIN_AREA", "0.0001")),
        "custom_max_area_ratio": float(os.environ.get("CHOPSTICKS_MAX_AREA", "0.95")),
        "custom_min_aspect_ratio": float(os.environ.get("CHOPSTICKS_MIN_ASPECT", min_aspect_default)),
        "custom_low_aspect_high_conf": float(os.environ.get("CHOPSTICKS_LOW_ASPECT_HIGH_CONF", "0.88")),
        "custom_top_k": int(os.environ.get("CHOPSTICKS_TOP_K", "1")),
    }


def read_food_postprocess() -> Dict[str, Any]:
    return {
        "food_conf_threshold": float(os.environ.get("FOOD_CONF", "0.25")),
        "food_iou_threshold": float(os.environ.get("FOOD_IOU", "0.45")),
        "food_max_det": int(os.environ.get("FOOD_MAX_DET", "20")),
    }


def read_bowl_postprocess() -> Dict[str, Any]:
    return {
        "bowl_conf_threshold": float(os.environ.get("BOWL_CONF", "0.55")),
        "bowl_iou_threshold": float(os.environ.get("BOWL_IOU", "0.45")),
        "bowl_max_det": int(os.environ.get("BOWL_MAX_DET", "6")),
        "bowl_min_area_ratio": float(os.environ.get("BOWL_MIN_AREA", "0.008")),
        "bowl_max_area_ratio": float(os.environ.get("BOWL_MAX_AREA", "0.60")),
        "bowl_max_aspect_ratio": float(os.environ.get("BOWL_MAX_ASPECT", "1.8")),
        "bowl_top_k": int(os.environ.get("BOWL_TOP_K", "2")),
    }
