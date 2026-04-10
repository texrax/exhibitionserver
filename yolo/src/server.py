"""
YoloTD 視覺辨識伺服器
固定雙人雙碗餐桌互動事件版
"""

import base64
from contextlib import asynccontextmanager
import os
from pathlib import Path
import threading
import time
from typing import Any, Dict, List, Optional

import cv2
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
import numpy as np
from pydantic import BaseModel
from pythonosc import udp_client

from config import read_scene_config, read_event_config
from detector import ObjectDetector
from analysis import ObjectAnalyzer
from overlay import draw_scene_overlay

# === 模型設定 ===
YOLO_PROFILE = os.environ.get("YOLO_PROFILE", "v8").lower()
GENERAL_MODEL_V8 = os.environ.get("GENERAL_MODEL_V8", "yolov8n.pt")
GENERAL_MODEL_Y11 = os.environ.get("GENERAL_MODEL_Y11", "yolo11s.pt")
CHOPSTICKS_MODEL_V8 = os.environ.get("CHOPSTICKS_MODEL_V8", "runs/detect/chopsticks_model_pro/weights/best.pt")
CHOPSTICKS_MODEL_Y11 = os.environ.get("CHOPSTICKS_MODEL_Y11", "runs/detect/chopsticks_model_pro/weights/best_y11.pt")
FOOD_MODEL_V8 = os.environ.get("FOOD_MODEL_V8", "runs/detect/food_model/weights/best_food_y11.pt")
FOOD_MODEL_Y11 = os.environ.get("FOOD_MODEL_Y11", "runs/detect/food_model_y11s_patience120_20260324/weights/best.pt")
BOWL_MODEL_V8 = os.environ.get("BOWL_MODEL_V8", "runs/detect/bowl_model/weights/best_bowl_y11.pt")
BOWL_MODEL_Y11 = os.environ.get("BOWL_MODEL_Y11", "runs/detect/bowl_model/weights/best_bowl_y11.pt")

# === 推論設定 ===
DETECT_CONF = float(os.environ.get("DETECT_CONF", "0.35"))
CHOPSTICKS_CONF = float(os.environ.get("CHOPSTICKS_CONF", "0.15"))
CHOPSTICKS_IOU = float(os.environ.get("CHOPSTICKS_IOU", "0.45"))
CHOPSTICKS_MAX_DET = int(os.environ.get("CHOPSTICKS_MAX_DET", "50"))
CHOPSTICKS_MIN_AREA = float(os.environ.get("CHOPSTICKS_MIN_AREA", "0.0001"))
CHOPSTICKS_MAX_AREA = float(os.environ.get("CHOPSTICKS_MAX_AREA", "0.95"))
CHOPSTICKS_MIN_ASPECT = float(os.environ.get("CHOPSTICKS_MIN_ASPECT", "2.5" if YOLO_PROFILE == "y11" else "1.0"))
CHOPSTICKS_LOW_ASPECT_HIGH_CONF = float(os.environ.get("CHOPSTICKS_LOW_ASPECT_HIGH_CONF", "0.88"))
CHOPSTICKS_TOP_K = int(os.environ.get("CHOPSTICKS_TOP_K", "1"))
FOOD_CONF = float(os.environ.get("FOOD_CONF", "0.25"))
FOOD_IOU = float(os.environ.get("FOOD_IOU", "0.45"))
FOOD_MAX_DET = int(os.environ.get("FOOD_MAX_DET", "20"))
BOWL_CONF = float(os.environ.get("BOWL_CONF", "0.55"))
BOWL_IOU = float(os.environ.get("BOWL_IOU", "0.45"))
BOWL_MAX_DET = int(os.environ.get("BOWL_MAX_DET", "6"))
BOWL_MIN_AREA = float(os.environ.get("BOWL_MIN_AREA", "0.008"))
BOWL_MAX_AREA = float(os.environ.get("BOWL_MAX_AREA", "0.60"))
BOWL_MAX_ASPECT = float(os.environ.get("BOWL_MAX_ASPECT", "1.8"))
BOWL_TOP_K = int(os.environ.get("BOWL_TOP_K", "2"))

# === 效能設定 ===
DETECT_EVERY_N = int(os.environ.get("DETECT_EVERY_N", "3"))  # 每 N 幀偵測一次
JPEG_QUALITY = int(os.environ.get("JPEG_QUALITY", "70"))

# === 裁切設定 (歸一化 0~1，格式: x1,y1,x2,y2) ===
CAMERA_CROP = os.environ.get("CAMERA_CROP", "")

# === OSC 設定 ===
OSC_IP = os.environ.get("OSC_IP", "127.0.0.1")
OSC_PORT = int(os.environ.get("OSC_PORT", "7000"))
OSC_ENABLED = os.environ.get("OSC_ENABLED", "true").lower() == "true"

MODEL_CONFIG = {
    "v8": {"general": GENERAL_MODEL_V8, "chopsticks": CHOPSTICKS_MODEL_V8, "food": FOOD_MODEL_V8, "bowl": BOWL_MODEL_V8},
    "y11": {"general": GENERAL_MODEL_Y11, "chopsticks": CHOPSTICKS_MODEL_Y11, "food": FOOD_MODEL_Y11, "bowl": BOWL_MODEL_Y11},
}
PROJECT_ROOT = Path(__file__).resolve().parent.parent

osc_client: Optional[udp_client.SimpleUDPClient] = None

detector: Optional[ObjectDetector] = None
analyzer: Optional[ObjectAnalyzer] = None
monitor_active = False
video_capture: Optional[cv2.VideoCapture] = None
latest_frame_jpg: Optional[bytes] = None
current_status: Dict[str, Any] = {"timestamp": 0, "count": 0, "analysis": {}, "objects": []}
lock = threading.Lock()

@asynccontextmanager
async def lifespan(app: FastAPI):
    global detector, analyzer, osc_client, monitor_active

    model_specs = resolve_model_specs(YOLO_PROFILE)
    model_paths = [spec["path"] for spec in model_specs]
    model_roles = [spec["role"] for spec in model_specs]
    print(f"正在初始化多模型系統... profile={YOLO_PROFILE}")
    for spec in model_specs:
        print(f"{spec['role']} 模型: {spec['path']}")
    print(f"scene config: {read_scene_config()}")

    detector = ObjectDetector(model_path=model_paths, model_profile=YOLO_PROFILE, model_roles=model_roles)
    analyzer = ObjectAnalyzer(scene_config=read_scene_config(), event_config=read_event_config())

    if OSC_ENABLED:
        osc_client = udp_client.SimpleUDPClient(OSC_IP, OSC_PORT)
    threading.Thread(target=video_loop, daemon=True).start()

    yield

    monitor_active = False
    time.sleep(1)


app = FastAPI(title="YoloTD 視覺辨識系統", version="2.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


def _is_builtin_weight_name(profile: str, path: str) -> bool:
    filename = os.path.basename(path).lower()
    expected_prefix = {"v8": "yolov8", "y11": "yolo11"}.get(profile, "")
    return bool(expected_prefix) and filename.startswith(expected_prefix) and filename.endswith(".pt")


def _resolve_existing_local_path(path_str: str) -> Optional[str]:
    if not path_str:
        return None
    candidate = Path(path_str).expanduser()
    if candidate.is_file():
        return str(candidate)
    if not candidate.is_absolute():
        project_candidate = (PROJECT_ROOT / candidate).resolve()
        if project_candidate.is_file():
            return str(project_candidate)
    return None


def resolve_model_specs(profile: str) -> List[Dict[str, str]]:
    if profile not in MODEL_CONFIG:
        supported = ", ".join(sorted(MODEL_CONFIG.keys()))
        raise ValueError(f"Invalid YOLO_PROFILE='{profile}'. Supported values: {supported}")

    config = MODEL_CONFIG[profile]
    general_model = config["general"]
    chopsticks_model = config["chopsticks"]
    food_model = config.get("food", "")
    bowl_model = config.get("bowl", "")

    if not general_model:
        raise ValueError(f"General model path is empty for profile '{profile}'")
    resolved_general = _resolve_existing_local_path(general_model)
    if _is_builtin_weight_name(profile, general_model):
        final_general = general_model
    elif resolved_general:
        final_general = resolved_general
    else:
        raise FileNotFoundError(
            f"General model not found for profile '{profile}': {general_model}. "
            f"Set GENERAL_MODEL_{profile.upper()} to a valid path or official model name."
        )

    if not chopsticks_model:
        raise ValueError(f"Chopsticks model path is empty for profile '{profile}'")
    resolved_chopsticks = _resolve_existing_local_path(chopsticks_model)
    if not resolved_chopsticks:
        raise FileNotFoundError(
            f"Chopsticks model not found for profile '{profile}': {chopsticks_model}. "
            f"Set CHOPSTICKS_MODEL_{profile.upper()} to a valid local .pt path."
        )

    specs = [
        {"role": "general", "path": final_general},
        {"role": "chopsticks", "path": resolved_chopsticks},
    ]

    if food_model:
        resolved_food = _resolve_existing_local_path(food_model)
        if not resolved_food:
            raise FileNotFoundError(
                f"Food model not found for profile '{profile}': {food_model}. "
                f"Set FOOD_MODEL_{profile.upper()} to a valid local .pt path."
            )
        specs.append({"role": "food", "path": resolved_food})

    if bowl_model:
        resolved_bowl = _resolve_existing_local_path(bowl_model)
        if not resolved_bowl:
            raise FileNotFoundError(
                f"Bowl model not found for profile '{profile}': {bowl_model}. "
                f"Set BOWL_MODEL_{profile.upper()} to a valid local .pt path."
            )
        specs.append({"role": "bowl", "path": resolved_bowl})

    return specs


def send_osc_data(analysis_result: Dict[str, Any]) -> None:
    if not OSC_ENABLED or osc_client is None:
        return

    try:
        total = analysis_result.get("total_count", 0)
        osc_client.send_message("/yolotd/count", total)

        events = analysis_result.get("dining_events", [])
        if not events:
            osc_client.send_message("/yolotd/interaction/has_action", 0)
            osc_client.send_message("/yolotd/interaction/x", -1.0)
            osc_client.send_message("/yolotd/interaction/y", -1.0)
            osc_client.send_message("/yolotd/interaction/target_person", -1)
            osc_client.send_message("/yolotd/interaction/action", 0)
            osc_client.send_message("/yolotd/event/id", -1)
            osc_client.send_message("/yolotd/event/type", "none")
            osc_client.send_message("/yolotd/event/state", "idle")
            osc_client.send_message("/yolotd/event/food", "")
            osc_client.send_message("/yolotd/event/source_side", "")
            osc_client.send_message("/yolotd/event/target_side", "")
            osc_client.send_message("/yolotd/event/success", -1)
            osc_client.send_message("/yolotd/event/drop", 0)
            osc_client.send_message("/yolotd/event/completed", 0)
            return

        event = events[0]
        camera_position = event.get("camera_position") or event.get("coords") or {"x": -1, "y": -1}
        osc_client.send_message("/yolotd/interaction/has_action", 1)
        osc_client.send_message("/yolotd/interaction/x", float(camera_position["x"]))
        osc_client.send_message("/yolotd/interaction/y", float(camera_position["y"]))
        osc_client.send_message("/yolotd/interaction/target_person", event.get("target_person") or -1)
        osc_client.send_message("/yolotd/interaction/action", 0 if event.get("action") == "idle" else 1)

        osc_client.send_message("/yolotd/event/id", int(event.get("event_id") or -1))
        osc_client.send_message("/yolotd/event/type", str(event.get("event_type") or "none"))
        osc_client.send_message("/yolotd/event/state", str(event.get("state") or "idle"))
        osc_client.send_message("/yolotd/event/food", str(event.get("carried_food") or ""))
        osc_client.send_message("/yolotd/event/source_side", str(event.get("source_side") or ""))
        osc_client.send_message("/yolotd/event/target_side", str(event.get("target_side") or ""))
        success = event.get("success")
        osc_client.send_message("/yolotd/event/success", -1 if success is None else int(bool(success)))
        osc_client.send_message("/yolotd/event/drop", int(event.get("event_type") == "drop"))
        osc_client.send_message("/yolotd/event/completed", int(bool(event.get("completed"))))
    except Exception as exc:
        print(f"[OSC ERROR] {exc}")


# === Pydantic models ===
class BBox(BaseModel):
    x1: int
    y1: int
    x2: int
    y2: int


class Center(BaseModel):
    x: int
    y: int


class DetectionObject(BaseModel):
    id: int
    label: str
    class_id: int
    confidence: float
    bbox: BBox
    center: Center
    camera_position: Optional[Center] = None
    track_id: Optional[int] = None


class DiningEvent(BaseModel):
    event_id: int
    utensil_id: int
    utensil_track_id: Optional[int] = None
    utensil_type: str
    camera_position: Center
    coords: Optional[Center] = None
    action: str
    event_type: str
    state: str
    source_side: Optional[str] = None
    target_side: Optional[str] = None
    source_bowl: Optional[str] = None
    target_bowl: Optional[str] = None
    target_person: Optional[int] = None
    target_food: Optional[str] = None
    carried_food: Optional[str] = None
    success: Optional[bool] = None
    completed: bool = False
    distances: Dict[str, int]


class AnalysisData(BaseModel):
    summary: Dict[str, int]
    zones: Dict[str, List[Any]]
    scene: Dict[str, Any]
    dining_events: List[DiningEvent]
    total_count: int


class ApiResponse(BaseModel):
    success: bool
    message: str
    data: AnalysisData
    objects: List[DetectionObject]
    annotated_image: Optional[str] = None


# === 監控主迴圈 ===
def video_loop() -> None:
    global video_capture, latest_frame_jpg, current_status, monitor_active
    camera_source = os.environ.get("CAMERA_SOURCE", "0")
    print(f"[Camera] CAMERA_SOURCE={camera_source}", flush=True)
    # 支援數字（本機攝影機 index）或 URL（手機 IP Cam / RTSP 串流）
    if camera_source.isdigit():
        # 根據作業系統選擇正確的攝影機 backend
        import sys
        if sys.platform == "darwin":
            video_capture = cv2.VideoCapture(int(camera_source), cv2.CAP_AVFOUNDATION)
        elif sys.platform == "win32":
            video_capture = cv2.VideoCapture(int(camera_source), cv2.CAP_MSMF)
        else:
            video_capture = cv2.VideoCapture(int(camera_source))
    else:
        video_capture = cv2.VideoCapture(camera_source)
    print(f"[Camera] opened={video_capture.isOpened()}, backend={video_capture.getBackendName()}", flush=True)
    video_capture.set(cv2.CAP_PROP_FRAME_WIDTH, 1920)
    video_capture.set(cv2.CAP_PROP_FRAME_HEIGHT, 1080)
    video_capture.set(cv2.CAP_PROP_FPS, 30)
    video_capture.set(cv2.CAP_PROP_BUFFERSIZE, 1)  # 避免讀到舊幀

    if not video_capture.isOpened():
        print("[ERROR] 無法開啟攝影機")
        return

    # 解析裁切區域
    crop_rect = None
    if CAMERA_CROP:
        try:
            parts = [float(v.strip()) for v in CAMERA_CROP.split(",")]
            if len(parts) == 4:
                crop_rect = parts
                print(f"[Camera] 裁切區域: {crop_rect}", flush=True)
        except ValueError:
            print(f"[Camera] CAMERA_CROP 格式錯誤: {CAMERA_CROP}", flush=True)

    monitor_active = True
    frame_count = 0
    last_tracked_objects = []
    last_analysis_res = {}
    while monitor_active:
        success, frame = video_capture.read()
        if not success:
            time.sleep(0.2)
            continue

        # 裁切畫面
        if crop_rect:
            h, w = frame.shape[:2]
            cx1 = int(crop_rect[0] * w)
            cy1 = int(crop_rect[1] * h)
            cx2 = int(crop_rect[2] * w)
            cy2 = int(crop_rect[3] * h)
            frame = frame[cy1:cy2, cx1:cx2]

        frame_count += 1
        run_detect = (frame_count % DETECT_EVERY_N == 0)

        try:
            if run_detect:
                detections = detector.detect(
                    frame,
                    conf_threshold=DETECT_CONF,
                    custom_conf_threshold=CHOPSTICKS_CONF,
                    custom_iou_threshold=CHOPSTICKS_IOU,
                    custom_max_det=CHOPSTICKS_MAX_DET,
                    custom_min_area_ratio=CHOPSTICKS_MIN_AREA,
                    custom_max_area_ratio=CHOPSTICKS_MAX_AREA,
                    custom_min_aspect_ratio=CHOPSTICKS_MIN_ASPECT,
                    custom_low_aspect_high_conf=CHOPSTICKS_LOW_ASPECT_HIGH_CONF,
                    custom_top_k=CHOPSTICKS_TOP_K,
                    food_conf_threshold=FOOD_CONF,
                    food_iou_threshold=FOOD_IOU,
                    food_max_det=FOOD_MAX_DET,
                    bowl_conf_threshold=BOWL_CONF,
                    bowl_iou_threshold=BOWL_IOU,
                    bowl_max_det=BOWL_MAX_DET,
                    bowl_min_area_ratio=BOWL_MIN_AREA,
                    bowl_max_area_ratio=BOWL_MAX_AREA,
                    bowl_max_aspect_ratio=BOWL_MAX_ASPECT,
                    bowl_top_k=BOWL_TOP_K,
                ) if detector else []
                analysis_res = analyzer.analyze(detections, image_width=frame.shape[1], image_height=frame.shape[0], use_state=True) if analyzer else {}
                tracked_objects = analysis_res.get("tracked_objects", detections)
                last_analysis_res = analysis_res

                with lock:
                    current_status = {
                        "timestamp": time.time(),
                        "count": len(tracked_objects),
                        "analysis": {k: v for k, v in analysis_res.items() if k != "tracked_objects"},
                        "objects": tracked_objects,
                    }

                send_osc_data(analysis_res)
                last_tracked_objects = tracked_objects

                # 記錄偵測到的物件
                if tracked_objects:
                    from collections import Counter as _Counter
                    obj_summary = _Counter(d["label"] for d in tracked_objects)
                    summary_str = ", ".join(f"{label}x{cnt}" for label, cnt in obj_summary.items())
                    print(f"[DETECT] {summary_str}", flush=True)

                # 記錄餐桌互動事件
                for ev in analysis_res.get("dining_events", []):
                    etype = ev.get("event_type", "none")
                    food = ev.get("carried_food") or "無"
                    state = ev.get("state", "")
                    src = ev.get("source_side") or "?"
                    tgt = ev.get("target_side") or "?"
                    if etype == "deliver":
                        print(f"[EVENT] ✅ 成功送餐！{food} 從 {src} 送到 {tgt} 的碗裡", flush=True)
                    elif etype == "pickup":
                        print(f"[EVENT] 🥢 夾起 {food}（{src} 側）", flush=True)
                    elif etype == "drop":
                        print(f"[EVENT] ❌ {food} 掉落！（{state}）", flush=True)

                annotated = detector.draw_results(frame, tracked_objects) if detector else frame.copy()
                annotated = draw_scene_overlay(annotated, analysis_res)
            else:
                # 非偵測幀：重用上次的偵測結果畫 bounding box + overlay
                annotated = detector.draw_results(frame, last_tracked_objects) if detector else frame.copy()
                annotated = draw_scene_overlay(annotated, last_analysis_res) if last_analysis_res else annotated

            ret, buffer = cv2.imencode(".jpg", annotated, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY])
            if ret:
                with lock:
                    latest_frame_jpg = buffer.tobytes()
        except Exception as exc:
            print(f"[VIDEO LOOP ERROR] {exc}")
            time.sleep(0.1)

        time.sleep(0.005)  # 僅讓出 CPU，不再硬鎖幀率

    if video_capture:
        video_capture.release()


@app.get("/")
async def root() -> Dict[str, Any]:
    return {"service": "YoloTD", "version": "2.0.0", "profile": YOLO_PROFILE}


@app.get("/osc/status")
async def get_osc_status() -> Dict[str, Any]:
    return {"enabled": OSC_ENABLED, "ip": OSC_IP, "port": OSC_PORT}


@app.get("/status")
async def get_status() -> Dict[str, Any]:
    with lock:
        return current_status


@app.get("/video_feed")
async def video_feed() -> StreamingResponse:
    def generate():
        while True:
            with lock:
                data = latest_frame_jpg
            if data is None:
                time.sleep(0.1)
                continue
            yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + data + b"\r\n"
            time.sleep(0.016)  # ~60fps 串流上限

    return StreamingResponse(generate(), media_type="multipart/x-mixed-replace; boundary=frame")


@app.post("/detect", response_model=ApiResponse)
async def detect_image(file: UploadFile = File(...), conf: float = DETECT_CONF) -> Dict[str, Any]:
    if not detector:
        raise HTTPException(500, "Not initialized")

    contents = await file.read()
    image = cv2.imdecode(np.frombuffer(contents, np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise HTTPException(400, "Invalid image")

    detections = detector.detect(
        image,
        conf_threshold=conf,
        custom_conf_threshold=CHOPSTICKS_CONF,
        custom_iou_threshold=CHOPSTICKS_IOU,
        custom_max_det=CHOPSTICKS_MAX_DET,
        custom_min_area_ratio=CHOPSTICKS_MIN_AREA,
        custom_max_area_ratio=CHOPSTICKS_MAX_AREA,
        custom_min_aspect_ratio=CHOPSTICKS_MIN_ASPECT,
        custom_low_aspect_high_conf=CHOPSTICKS_LOW_ASPECT_HIGH_CONF,
        custom_top_k=CHOPSTICKS_TOP_K,
        food_conf_threshold=FOOD_CONF,
        food_iou_threshold=FOOD_IOU,
        food_max_det=FOOD_MAX_DET,
        food_top_k=FOOD_TOP_K,
        bowl_conf_threshold=BOWL_CONF,
        bowl_iou_threshold=BOWL_IOU,
        bowl_max_det=BOWL_MAX_DET,
        bowl_min_area_ratio=BOWL_MIN_AREA,
        bowl_max_area_ratio=BOWL_MAX_AREA,
        bowl_max_aspect_ratio=BOWL_MAX_ASPECT,
        bowl_top_k=BOWL_TOP_K,
    )
    snapshot_analyzer = ObjectAnalyzer(scene_config=read_scene_config(), event_config=read_event_config())
    analysis = snapshot_analyzer.analyze(detections, image_width=image.shape[1], image_height=image.shape[0], use_state=False)
    tracked_objects = analysis.pop("tracked_objects", detections)

    annotated = detector.draw_results(image, tracked_objects)
    annotated = draw_scene_overlay(annotated, analysis)
    _, buffer = cv2.imencode(".jpg", annotated)
    encoded = base64.b64encode(buffer.tobytes()).decode("ascii")

    return {
        "success": True,
        "message": "OK",
        "data": analysis,
        "objects": tracked_objects,
        "annotated_image": encoded,
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000, access_log=False)
