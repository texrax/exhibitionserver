"""
餐桌互動事件分析模組
固定雙人、雙碗、上方鏡頭場景
"""

from __future__ import annotations

from collections import Counter
from copy import deepcopy
import math
from typing import Any, Dict, List, Optional, Tuple


class ObjectAnalyzer:
    def __init__(self, scene_config: Optional[Dict[str, Any]] = None, event_config: Optional[Dict[str, Any]] = None):
        self.zones = ["left", "center", "right"]
        self.UTENSILS = ["fork", "knife", "spoon", "chopsticks"]
        self.FOODS = ["pork", "vegetables", "beef", "bowl", "cake", "pizza", "donut", "sandwich", "hot dog"]
        self.CARRIABLE_FOODS = ["pork", "vegetables", "beef"]
        self.ACTORS = ["person"]
        self.TRACKABLE_LABELS = set(self.UTENSILS + self.CARRIABLE_FOODS + ["person", "bowl"])

        self.scene_config = scene_config or {}
        self.event_config = {
            "attach_distance": 95.0,
            "release_distance": 125.0,
            "attach_frames": 3,
            "release_frames": 3,
            "food_memory_frames": 30,
            "cooldown_frames": 18,
            "event_display_frames": 45,
            "max_idle_frames": 12,
            "track_match_distance": {
                "person": 220.0,
                "bowl": 180.0,
                "chopsticks": 140.0,
                "pork": 110.0,
                "vegetables": 110.0,
                "beef": 110.0,
                "default": 120.0,
            },
        }
        if event_config:
            self.event_config.update(event_config)
            if "track_match_distance" in event_config:
                merged = dict(self.event_config["track_match_distance"])
                merged.update(event_config["track_match_distance"])
                self.event_config["track_match_distance"] = merged

        self.frame_index = 0
        self.next_track_id = 1
        self.next_event_id = 1
        self.tracks: Dict[str, List[Dict[str, Any]]] = {}
        self.pending_pickup: Optional[Dict[str, Any]] = None
        self.active_event: Optional[Dict[str, Any]] = None
        self.last_completed_event: Optional[Dict[str, Any]] = None
        self.cooldown_until_frame = 0

    def analyze(
        self,
        detections: List[Dict[str, Any]],
        image_width: int = 1280,
        image_height: int = 720,
        use_state: bool = True,
    ) -> Dict[str, Any]:
        self.frame_index += 1

        working = [deepcopy(d) for d in detections]
        if working:
            self._assign_track_ids(working)

        counts = dict(Counter(d["label"] for d in working))
        zone_dist = self._analyze_zones(working, image_width)
        scene = self._resolve_scene(working, image_width, image_height)

        if use_state:
            dining_events = self._analyze_event_state(working, scene)
        else:
            dining_events = self._analyze_snapshot(working, scene)

        return {
            "summary": counts,
            "zones": zone_dist,
            "scene": self._serialize_scene(scene),
            "dining_events": dining_events,
            "total_count": len(working),
            "tracked_objects": working,
        }

    def _assign_track_ids(self, detections: List[Dict[str, Any]]) -> None:
        current_by_label: Dict[str, List[Dict[str, Any]]] = {}
        for det in detections:
            label = det["label"]
            if label not in self.TRACKABLE_LABELS:
                continue
            current_by_label.setdefault(label, []).append(det)

        seen_labels = set(current_by_label.keys()) | set(self.tracks.keys())
        for label in seen_labels:
            prev_tracks = self.tracks.get(label, [])
            current = current_by_label.get(label, [])
            for det in current:
                best_track = None
                best_distance = float("inf")
                for track in prev_tracks:
                    if track.get("matched"):
                        continue
                    dist = self._distance_points(track["center"], det["center"])
                    if dist < best_distance:
                        best_distance = dist
                        best_track = track

                match_limit = self.event_config["track_match_distance"].get(
                    label,
                    self.event_config["track_match_distance"]["default"],
                )
                if best_track and best_distance <= match_limit:
                    det["track_id"] = best_track["track_id"]
                    best_track["matched"] = True
                else:
                    det["track_id"] = self.next_track_id
                    self.next_track_id += 1

            updated_tracks = []
            for det in current:
                updated_tracks.append(
                    {
                        "track_id": det["track_id"],
                        "center": det["center"],
                        "bbox": det["bbox"],
                        "label": label,
                    }
                )
            self.tracks[label] = updated_tracks

    def _resolve_scene(self, detections: List[Dict[str, Any]], width: int, height: int) -> Dict[str, Any]:
        bowl_detections = [d for d in detections if d["label"] == "bowl"]
        person_detections = [d for d in detections if d["label"] == "person"]
        bowl_detections = sorted(bowl_detections, key=lambda d: d["center"]["x"])
        person_detections = sorted(person_detections, key=lambda d: d["center"]["x"])

        left_bowl_default = self._bbox_to_rect(bowl_detections[0]["bbox"], pad=70, width=width, height=height) if bowl_detections else self._rect_from_spec(self.scene_config.get("left_bowl_zone"), width, height) or self._default_bowl_rect("left", width, height)
        right_bowl_default = self._bbox_to_rect(bowl_detections[-1]["bbox"], pad=70, width=width, height=height) if len(bowl_detections) >= 2 else self._rect_from_spec(self.scene_config.get("right_bowl_zone"), width, height) or self._default_bowl_rect("right", width, height)

        left_person_default = self._rect_from_spec(self.scene_config.get("left_person_zone"), width, height) or self._default_person_rect("left", width, height)
        right_person_default = self._rect_from_spec(self.scene_config.get("right_person_zone"), width, height) or self._default_person_rect("right", width, height)
        table_zone = self._rect_from_spec(self.scene_config.get("table_valid_zone"), width, height) or {"x1": 0, "y1": 0, "x2": width, "y2": height}

        people_by_side = {
            "left": self._pick_best_in_rect(person_detections, left_person_default),
            "right": self._pick_best_in_rect(person_detections, right_person_default),
        }
        bowls_by_side = {
            "left": self._pick_best_in_rect(bowl_detections, left_bowl_default) or self._pick_by_side(bowl_detections, "left", width),
            "right": self._pick_best_in_rect(bowl_detections, right_bowl_default) or self._pick_by_side(bowl_detections, "right", width),
        }

        scene = {
            "width": width,
            "height": height,
            "midline_x": width // 2,
            "zones": {
                "left_person": left_person_default,
                "right_person": right_person_default,
                "left_bowl": left_bowl_default,
                "right_bowl": right_bowl_default,
                "table": table_zone,
            },
            "people": people_by_side,
            "bowls": bowls_by_side,
        }
        return scene

    def _analyze_event_state(self, detections: List[Dict[str, Any]], scene: Dict[str, Any]) -> List[Dict[str, Any]]:
        if self.last_completed_event and self.frame_index - self.last_completed_event.get("frame_completed", 0) > self.event_config["event_display_frames"]:
            self.last_completed_event = None

        chopsticks = self._select_primary_chopsticks(detections)
        foods = [d for d in detections if d["label"] in self.CARRIABLE_FOODS]

        if self.active_event:
            self._advance_active_event(chopsticks, foods, scene)
        else:
            self._update_pending_pickup(chopsticks, foods, scene)

        events: List[Dict[str, Any]] = []
        if self.active_event:
            events.append(self._serialize_event(self.active_event, scene, completed=False))
        elif self.last_completed_event:
            events.append(self._serialize_event(self.last_completed_event, scene, completed=True))
        return events

    def _analyze_snapshot(self, detections: List[Dict[str, Any]], scene: Dict[str, Any]) -> List[Dict[str, Any]]:
        chopsticks = self._select_primary_chopsticks(detections)
        if not chopsticks:
            return []

        food = self._find_attached_food(chopsticks, [d for d in detections if d["label"] in self.CARRIABLE_FOODS], None)
        source_side = self._classify_side(chopsticks["center"], scene)
        event = {
            "event_id": 0,
            "frame_started": self.frame_index,
            "frame_completed": None,
            "state": "holding_food" if food else "idle",
            "event_type": "pickup" if food else "none",
            "action": "pickup" if food else "idle",
            "utensil_id": chopsticks["id"],
            "utensil_track_id": chopsticks.get("track_id"),
            "utensil_type": chopsticks["label"],
            "camera_position": chopsticks["center"],
            "coords": chopsticks["center"],
            "source_side": source_side,
            "target_side": self._other_side(source_side),
            "source_bowl": f"{source_side}_bowl",
            "target_bowl": f"{self._other_side(source_side)}_bowl",
            "target_person": self._person_track_id_for_side(self._other_side(source_side), scene),
            "target_food": food["label"] if food else None,
            "carried_food": food["label"] if food else None,
            "success": None,
            "distances": self._build_distance_summary(chopsticks, food, scene),
        }
        return [self._serialize_event(event, scene, completed=False)]

    def _update_pending_pickup(self, chopsticks: Optional[Dict[str, Any]], foods: List[Dict[str, Any]], scene: Dict[str, Any]) -> None:
        if self.frame_index < self.cooldown_until_frame or not chopsticks:
            self.pending_pickup = None
            return

        food = self._find_attached_food(chopsticks, foods, None)
        if not food:
            self.pending_pickup = None
            return

        source_side = self._classify_side(chopsticks["center"], scene)
        key = (chopsticks.get("track_id"), food.get("track_id"), food["label"], source_side)
        if self.pending_pickup and self.pending_pickup.get("key") == key:
            self.pending_pickup["frames"] += 1
        else:
            self.pending_pickup = {"key": key, "frames": 1, "food": food, "chopsticks": chopsticks, "source_side": source_side}

        if self.pending_pickup["frames"] >= self.event_config["attach_frames"]:
            target_side = self._other_side(source_side)
            source_bowl = self._which_bowl(food["center"], scene)
            self.active_event = {
                "event_id": self.next_event_id,
                "frame_started": self.frame_index,
                "frame_completed": None,
                "state": "holding_food",
                "event_type": "pickup",
                "action": "pickup",
                "utensil_id": chopsticks["id"],
                "utensil_track_id": chopsticks.get("track_id"),
                "utensil_type": chopsticks["label"],
                "camera_position": dict(chopsticks["center"]),
                "coords": dict(chopsticks["center"]),
                "source_side": source_side,
                "target_side": target_side,
                "source_bowl": source_bowl or f"{source_side}_bowl",
                "target_bowl": f"{target_side}_bowl",
                "target_person": self._person_track_id_for_side(target_side, scene),
                "target_food": food["label"],
                "carried_food": food["label"],
                "carried_food_track_id": food.get("track_id"),
                "last_food_center": dict(food["center"]),
                "last_chopsticks_center": dict(chopsticks["center"]),
                "distances": self._build_distance_summary(chopsticks, food, scene),
                "success": None,
                "release_frames": 0,
                "food_missing_frames": 0,
                "idle_frames": 0,
                "entered_target_bowl": 0,
            }
            self.next_event_id += 1
            self.pending_pickup = None

    def _advance_active_event(self, chopsticks: Optional[Dict[str, Any]], foods: List[Dict[str, Any]], scene: Dict[str, Any]) -> None:
        assert self.active_event is not None
        event = self.active_event

        if chopsticks:
            event["camera_position"] = dict(chopsticks["center"])
            event["coords"] = dict(chopsticks["center"])
            event["last_chopsticks_center"] = dict(chopsticks["center"])
            event["target_person"] = self._person_track_id_for_side(event["target_side"], scene)
        else:
            event["idle_frames"] += 1

        food = self._find_attached_food(chopsticks, foods, event)
        if food:
            event["carried_food"] = food["label"]
            event["target_food"] = food["label"]
            event["carried_food_track_id"] = food.get("track_id")
            event["last_food_center"] = dict(food["center"])
            event["distances"] = self._build_distance_summary(chopsticks, food, scene)
            event["release_frames"] = 0
            event["food_missing_frames"] = 0
            event["idle_frames"] = 0
            event["state"] = "moving_to_target" if self._classify_side(chopsticks["center"], scene) != event["source_side"] else "holding_food"
            event["action"] = "carrying"
            if self._which_bowl(food["center"], scene) is not None:
                event["entered_target_bowl"] += 1
        else:
            event["food_missing_frames"] = event.get("food_missing_frames", 0) + 1
            if chopsticks and event.get("carried_food") and event["food_missing_frames"] <= self.event_config["food_memory_frames"]:
                remembered_center = dict(chopsticks["center"])
                event["last_food_center"] = remembered_center
                event["distances"] = self._build_distance_summary(chopsticks, {"center": remembered_center}, scene)
                event["state"] = "moving_to_target" if self._classify_side(chopsticks["center"], scene) != event["source_side"] else "holding_food"
                event["action"] = "carrying"
                event["idle_frames"] = 0
                event["release_frames"] = 0
                in_bowl = self._which_bowl(chopsticks["center"], scene)
                if in_bowl is not None:
                    event["entered_target_bowl"] += 1
                print(f"[STATE] 食物記憶中 ({event['food_missing_frames']}/{self.event_config['food_memory_frames']}) | 筷子位置=({chopsticks['center']['x']},{chopsticks['center']['y']}) | 碗區={in_bowl or '無'}", flush=True)
            else:
                event["release_frames"] += 1
                print(f"[STATE] 食物記憶過期，釋放中 ({event['release_frames']}/{self.event_config['release_frames']})", flush=True)
                if chopsticks:
                    event["distances"] = self._build_distance_summary(chopsticks, None, scene)

        if event["release_frames"] >= self.event_config["release_frames"]:
            self._complete_active_event(scene)
            return

        if event["idle_frames"] >= self.event_config["max_idle_frames"]:
            self._finish_event("abort", success=False, scene=scene)

    def _complete_active_event(self, scene: Dict[str, Any]) -> None:
        assert self.active_event is not None
        event = self.active_event
        release_point = event.get("last_food_center") or event.get("last_chopsticks_center")
        release_bowl = self._which_bowl(release_point, scene)
        print(f"[JUDGE] 最終判斷 | 食物={event.get('carried_food')} | 釋放點=({release_point.get('x')},{release_point.get('y')}) | 碗區={release_bowl or '無'} | 曾進碗={event.get('entered_target_bowl',0)}次", flush=True)

        if release_bowl is not None:
            self._finish_event("deliver", success=True, scene=scene)
        elif self._point_in_rect(release_point, scene["zones"]["table"]):
            self._finish_event("drop", success=False, scene=scene)
        else:
            self._finish_event("abort", success=False, scene=scene)

    def _finish_event(self, event_type: str, success: Optional[bool], scene: Dict[str, Any]) -> None:
        assert self.active_event is not None
        event = self.active_event
        event["frame_completed"] = self.frame_index
        event["event_type"] = event_type
        event["action"] = event_type if event_type != "abort" else "idle"
        event["state"] = {
            "deliver": "delivered_to_other_bowl",
            "drop": "dropped_outside_bowl",
            "abort": "aborted",
        }.get(event_type, event_type)
        event["success"] = success
        event["target_person"] = self._person_track_id_for_side(event["target_side"], scene)
        self.last_completed_event = deepcopy(event)
        self.active_event = None
        self.cooldown_until_frame = self.frame_index + self.event_config["cooldown_frames"]

    def _serialize_event(self, event: Dict[str, Any], scene: Dict[str, Any], completed: bool) -> Dict[str, Any]:
        data = deepcopy(event)
        data["completed"] = completed
        data["target_person"] = self._person_track_id_for_side(data.get("target_side"), scene)
        data.setdefault("target_food", data.get("carried_food"))
        return data

    def _serialize_scene(self, scene: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "width": scene["width"],
            "height": scene["height"],
            "midline_x": scene["midline_x"],
            "zones": scene["zones"],
            "people": {side: self._serialize_detection(det) for side, det in scene["people"].items()},
            "bowls": {side: self._serialize_detection(det) for side, det in scene["bowls"].items()},
        }

    def _serialize_detection(self, det: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        if not det:
            return None
        return {
            "track_id": det.get("track_id"),
            "id": det.get("id"),
            "label": det.get("label"),
            "center": det.get("center"),
            "bbox": det.get("bbox"),
        }

    def _analyze_zones(self, detections: List[Dict[str, Any]], width: int) -> Dict[str, List[Any]]:
        distribution = {z: [] for z in self.zones}
        for obj in detections:
            cx = obj["center"]["x"]
            rel_x = cx / max(width, 1)
            pos = "left" if rel_x < 0.33 else ("right" if rel_x > 0.66 else "center")
            distribution[pos].append({"label": obj["label"], "id": obj.get("id"), "track_id": obj.get("track_id")})
        return distribution

    def _pick_best_in_rect(self, detections: List[Dict[str, Any]], rect: Dict[str, int]) -> Optional[Dict[str, Any]]:
        inside = [d for d in detections if self._point_in_rect(d["center"], rect)]
        if not inside:
            return None
        return sorted(inside, key=lambda d: d.get("confidence", 0.0), reverse=True)[0]

    def _pick_by_side(self, detections: List[Dict[str, Any]], side: str, width: int) -> Optional[Dict[str, Any]]:
        if not detections:
            return None
        ordered = sorted(detections, key=lambda d: d["center"]["x"])
        return ordered[0] if side == "left" else ordered[-1]

    def _select_primary_chopsticks(self, detections: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        chopsticks = [d for d in detections if d["label"] == "chopsticks"]
        if not chopsticks:
            return None
        if self.active_event and self.active_event.get("utensil_track_id") is not None:
            for det in chopsticks:
                if det.get("track_id") == self.active_event["utensil_track_id"]:
                    return det
        return sorted(chopsticks, key=lambda d: d.get("confidence", 0.0), reverse=True)[0]

    def _find_attached_food(
        self,
        chopsticks: Optional[Dict[str, Any]],
        foods: List[Dict[str, Any]],
        event: Optional[Dict[str, Any]],
    ) -> Optional[Dict[str, Any]]:
        if not chopsticks or not foods:
            return None

        ranked = []
        max_distance = self.event_config["release_distance"] if event else self.event_config["attach_distance"]
        for food in foods:
            distance = self._distance_points(chopsticks["center"], food["center"])
            if distance > max_distance:
                continue
            score = distance
            if event:
                if food.get("track_id") == event.get("carried_food_track_id"):
                    score -= 25.0
                if food["label"] == event.get("carried_food"):
                    score -= 10.0
            ranked.append((score, food))

        if not ranked:
            return None
        ranked.sort(key=lambda item: item[0])
        return ranked[0][1]

    def _build_distance_summary(
        self,
        chopsticks: Optional[Dict[str, Any]],
        food: Optional[Dict[str, Any]],
        scene: Dict[str, Any],
    ) -> Dict[str, int]:
        summary: Dict[str, int] = {}
        if chopsticks and food:
            summary["food"] = int(self._distance_points(chopsticks["center"], food["center"]))
        if chopsticks:
            target_center = self._rect_center(scene["zones"][f"{self._other_side(self._classify_side(chopsticks['center'], scene))}_bowl"])
            summary["target_bowl"] = int(self._distance_points(chopsticks["center"], target_center))
        return summary

    def _person_track_id_for_side(self, side: Optional[str], scene: Dict[str, Any]) -> Optional[int]:
        if side not in ("left", "right"):
            return None
        person = scene["people"].get(side)
        return person.get("track_id") if person else None

    def _which_bowl(self, point: Optional[Dict[str, int]], scene: Dict[str, Any]) -> Optional[str]:
        if not point:
            return None
        if self._point_in_rect(point, scene["zones"]["left_bowl"]):
            return "left_bowl"
        if self._point_in_rect(point, scene["zones"]["right_bowl"]):
            return "right_bowl"
        return None

    def _classify_side(self, point: Dict[str, int], scene: Dict[str, Any]) -> str:
        if self._point_in_rect(point, scene["zones"]["left_person"]):
            return "left"
        if self._point_in_rect(point, scene["zones"]["right_person"]):
            return "right"
        return "left" if point["x"] < scene["midline_x"] else "right"

    def _other_side(self, side: Optional[str]) -> Optional[str]:
        if side == "left":
            return "right"
        if side == "right":
            return "left"
        return None

    def _point_in_rect(self, point: Optional[Dict[str, int]], rect: Dict[str, int]) -> bool:
        if not point:
            return False
        return rect["x1"] <= point["x"] <= rect["x2"] and rect["y1"] <= point["y"] <= rect["y2"]

    def _rect_center(self, rect: Dict[str, int]) -> Dict[str, int]:
        return {"x": int((rect["x1"] + rect["x2"]) / 2), "y": int((rect["y1"] + rect["y2"]) / 2)}

    def _bbox_to_rect(self, bbox: Dict[str, int], pad: int, width: int, height: int) -> Dict[str, int]:
        return {
            "x1": max(0, bbox["x1"] - pad),
            "y1": max(0, bbox["y1"] - pad),
            "x2": min(width, bbox["x2"] + pad),
            "y2": min(height, bbox["y2"] + pad),
        }

    def _rect_from_spec(self, spec: Any, width: int, height: int) -> Optional[Dict[str, int]]:
        if not spec:
            return None
        if isinstance(spec, dict):
            raw = [spec.get("x1"), spec.get("y1"), spec.get("x2"), spec.get("y2")]
            if any(v is None for v in raw):
                return None
        else:
            parts = [p.strip() for p in str(spec).split(",")]
            if len(parts) != 4:
                return None
            raw = parts

        try:
            values = [float(v) for v in raw]
        except (TypeError, ValueError):
            return None
        if all(0.0 <= v <= 1.0 for v in values):
            x1, y1, x2, y2 = values
            return {
                "x1": int(x1 * width),
                "y1": int(y1 * height),
                "x2": int(x2 * width),
                "y2": int(y2 * height),
            }
        return {"x1": int(values[0]), "y1": int(values[1]), "x2": int(values[2]), "y2": int(values[3])}

    def _default_person_rect(self, side: str, width: int, height: int) -> Dict[str, int]:
        if side == "left":
            return {"x1": 0, "y1": 0, "x2": width // 2, "y2": height}
        return {"x1": width // 2, "y1": 0, "x2": width, "y2": height}

    def _default_bowl_rect(self, side: str, width: int, height: int) -> Dict[str, int]:
        if side == "left":
            return {"x1": int(width * 0.08), "y1": int(height * 0.52), "x2": int(width * 0.42), "y2": int(height * 0.95)}
        return {"x1": int(width * 0.58), "y1": int(height * 0.52), "x2": int(width * 0.92), "y2": int(height * 0.95)}

    def _distance_points(self, a: Dict[str, int], b: Dict[str, int]) -> float:
        return math.sqrt((a["x"] - b["x"]) ** 2 + (a["y"] - b["y"]) ** 2)
