"""
共用畫面覆蓋層繪製模組
"""

from typing import Any, Dict

import cv2
import numpy as np


def draw_scene_overlay(frame: np.ndarray, analysis_result: Dict[str, Any]) -> np.ndarray:
    scene = analysis_result.get("scene") or {}
    zones = scene.get("zones") or {}
    event = (analysis_result.get("dining_events") or [None])[0]

    zone_styles = {
        "left_person": ((120, 160, 255), "L PERSON"),
        "right_person": ((120, 160, 255), "R PERSON"),
        "left_bowl": ((255, 120, 80), "L BOWL"),
        "right_bowl": ((255, 120, 80), "R BOWL"),
        "table": ((120, 255, 180), "TABLE"),
    }
    for key, rect in zones.items():
        if not rect:
            continue
        color, label = zone_styles.get(key, ((180, 180, 180), key.upper()))
        thickness = 2 if "bowl" in key else 1
        cv2.rectangle(frame, (rect["x1"], rect["y1"]), (rect["x2"], rect["y2"]), color, thickness)
        cv2.putText(frame, label, (rect["x1"] + 6, rect["y1"] + 18), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1)

    if not event:
        cv2.putText(frame, "Event: none", (20, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (220, 220, 220), 2)
        return frame

    lines = [
        f"Event #{event.get('event_id', '-')}: {event.get('event_type', 'none')}",
        f"State: {event.get('state', 'idle')}",
        f"Food: {event.get('carried_food') or '-'}",
        f"Flow: {event.get('source_side') or '-'} -> {event.get('target_side') or '-'}",
        f"Success: {event.get('success')}",
    ]
    for idx, line in enumerate(lines):
        cv2.putText(frame, line, (20, 30 + idx * 24), cv2.FONT_HERSHEY_SIMPLEX, 0.65, (0, 255, 255), 2)

    camera_position = event.get("camera_position") or event.get("coords")
    if camera_position:
        cv2.circle(frame, (camera_position["x"], camera_position["y"]), 12, (0, 255, 255), 2)
        cv2.putText(frame, event.get("event_type", "event"), (camera_position["x"] + 12, camera_position["y"] - 12), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)
    return frame
