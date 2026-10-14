"""Persistent SH17 YOLOv8 ONNX worker. CPU only, no torch import or network.

Input and output are one JSON document per line. Input images are ephemeral
base64 bytes, never a path supplied by a browser. Boxes are normalized relative
to the EXIF-oriented source photograph, after removing letterbox padding.
"""
import argparse
import base64
import hashlib
from io import BytesIO
import json
from pathlib import Path
import sys
import time

CLASSES = ["person", "ear", "ear-mufs", "face", "face-guard", "face-mask", "foot", "tool", "glasses", "gloves", "helmet", "hands", "head", "medical-suit", "shoes", "safety-suit", "safety-vest"]


def emit(value):
    print(json.dumps(value, ensure_ascii=False, allow_nan=False), flush=True)


def memory_bytes():
    try:
        import ctypes
        from ctypes import wintypes
        class Counters(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD), ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t), ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t), ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t), ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]
        counters = Counters()
        counters.cb = ctypes.sizeof(counters)
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        psapi = ctypes.WinDLL("psapi", use_last_error=True)
        kernel.GetCurrentProcess.restype = wintypes.HANDLE
        psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
        if psapi.GetProcessMemoryInfo(kernel.GetCurrentProcess(), ctypes.byref(counters), counters.cb):
            return counters.WorkingSetSize
    except (AttributeError, OSError):
        pass
    return None


def nms(boxes, scores, labels, threshold=0.5, max_detections=20):
    """Class-aware NMS keeps overlapping person and helmet boxes independent."""
    import numpy as np
    order = np.argsort(-scores, kind="stable")[:1000]
    keep = []
    while order.size and len(keep) < max_detections:
        index = int(order[0])
        keep.append(index)
        remaining = order[1:]
        if not remaining.size:
            break
        intersection_start = np.maximum(boxes[index, :2], boxes[remaining, :2])
        intersection_end = np.minimum(boxes[index, 2:], boxes[remaining, 2:])
        intersection_size = np.maximum(0, intersection_end - intersection_start)
        intersection = intersection_size[:, 0] * intersection_size[:, 1]
        area = np.maximum(0, boxes[:, 2] - boxes[:, 0]) * np.maximum(0, boxes[:, 3] - boxes[:, 1])
        iou = intersection / np.maximum(area[index] + area[remaining] - intersection, 1e-8)
        suppressed = (labels[remaining] == labels[index]) & (iou > threshold)
        order = remaining[~suppressed]
    return keep


def detect(session, raw, confidence=0.35, classes=None):
    import numpy as np
    from PIL import Image, ImageOps
    Image.MAX_IMAGE_PIXELS = 40_000_000
    source = Image.open(BytesIO(raw))
    if source.format not in {"JPEG", "PNG", "WEBP"} or source.width * source.height > 40_000_000:
        raise ValueError("Format atau ukuran foto tidak didukung detektor.")
    source = ImageOps.exif_transpose(source).convert("RGB")
    width, height = source.size
    scale = min(640 / width, 640 / height)
    resized_width, resized_height = max(1, round(width * scale)), max(1, round(height * scale))
    left, top = (640 - resized_width) // 2, (640 - resized_height) // 2
    canvas = Image.new("RGB", (640, 640), (114, 114, 114))
    canvas.paste(source.resize((resized_width, resized_height), Image.Resampling.BILINEAR), (left, top))
    tensor = np.asarray(canvas, dtype=np.float32).transpose(2, 0, 1)[None, ...] / 255.0
    predictions = session.run(None, {session.get_inputs()[0].name: tensor})[0]
    classes = CLASSES if classes is None else classes
    if predictions.shape != (1, 4 + len(classes), 8400):
        raise ValueError("Bentuk keluaran detektor tidak sesuai dengan YOLOv8 SH17.")
    rows = predictions[0].T
    if not np.isfinite(rows).all():
        raise ValueError("Keluaran detektor tidak valid.")
    labels = rows[:, 4:].argmax(axis=1)
    scores = rows[np.arange(rows.shape[0]), labels + 4]
    selected = scores >= confidence
    rows, labels, scores = rows[selected], labels[selected], scores[selected]
    if not rows.size:
        return []
    boxes = np.column_stack((rows[:, 0] - rows[:, 2] / 2, rows[:, 1] - rows[:, 3] / 2, rows[:, 0] + rows[:, 2] / 2, rows[:, 1] + rows[:, 3] / 2))
    boxes[:, [0, 2]] = np.clip((boxes[:, [0, 2]] - left) / scale, 0, width)
    boxes[:, [1, 3]] = np.clip((boxes[:, [1, 3]] - top) / scale, 0, height)
    valid = (boxes[:, 2] > boxes[:, 0]) & (boxes[:, 3] > boxes[:, 1])
    boxes, scores, labels = boxes[valid], scores[valid], labels[valid]
    detections = []
    for index in nms(boxes, scores, labels):
        x1, y1, x2, y2 = boxes[index]
        class_id = int(labels[index])
        detections.append({"class_id": class_id, "class_name": classes[class_id], "confidence": round(float(scores[index]), 4),
            "box": {"x": round(float(x1) / width, 6), "y": round(float(y1) / height, 6), "width": round(float(x2 - x1) / width, 6), "height": round(float(y2 - y1) / height, 6)}})
    return detections


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--manifest")
    parser.add_argument("--probe", action="store_true")
    args = parser.parse_args()
    try:
        import numpy
        import onnxruntime as ort
        import PIL
        if args.probe:
            emit({"ready": True, "versions": {"numpy": numpy.__version__, "onnxruntime": ort.__version__, "Pillow": PIL.__version__}})
            return
        manifest_path = Path(args.manifest).resolve()
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        artifact = (manifest_path.parent / manifest["model_file"]).resolve()
        classes = manifest.get("class_names")
        rig = manifest.get("scope") == "rig_hazards"
        valid_classes = isinstance(classes, list) and 0 < len(classes) <= 100 and all(isinstance(name, str) and 0 < len(name) <= 160 for name in classes)
        if artifact.parent != manifest_path.parent or not valid_classes or (not rig and classes != CLASSES) or manifest.get("architecture") != "yolov8_raw" or manifest.get("input_size") != 640:
            raise ValueError("Manifest detektor tidak sesuai.")
        if hashlib.sha256(artifact.read_bytes()).hexdigest() != manifest["sha256"]:
            raise ValueError("Checksum model detektor tidak sesuai.")
        options = ort.SessionOptions()
        options.intra_op_num_threads = 2
        options.inter_op_num_threads = 1
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        session = ort.InferenceSession(str(artifact), sess_options=options, providers=["CPUExecutionProvider"])
        if session.get_inputs()[0].shape != [1, 3, 640, 640] or session.get_outputs()[0].shape != [1, 4 + len(classes), 8400]:
            raise ValueError("Dimensi input/keluaran model detektor tidak sesuai.")
        emit({"event": "ready", "ready": True, "runtime_bytes": memory_bytes()})
    except Exception as error:
        emit({"event": "error", "ready": False, "message": "Runtime detektor belum dapat dimuat: " + str(error)[:250]})
        sys.exit(2)
    # One sequential request, with a strict byte limit even before JSON decode.
    while True:
        line = sys.stdin.buffer.readline(12 * 1024 * 1024 + 1)
        if not line:
            return
        if len(line) > 12 * 1024 * 1024 or not line.endswith(b"\n"):
            emit({"event": "error", "message": "Permintaan detektor terlalu besar."})
            return
        request_id = None
        try:
            request = json.loads(line)
            request_id = request.get("id")
            raw = base64.b64decode(request["image"], validate=True)
            if not raw or len(raw) > 8 * 1024 * 1024:
                raise ValueError("Foto detektor melewati batas 8 MB.")
            started = time.perf_counter()
            detections = detect(session, raw, classes=classes)
            emit({"id": request_id, "detections": detections, "latency_ms": round((time.perf_counter() - started) * 1000, 1), "runtime_bytes": memory_bytes()})
        except Exception:
            # Image payloads and private image metadata never appear in logs.
            emit({"id": request_id, "error": "Foto belum dapat dibaca oleh detektor."})
        finally:
            # Do not retain the last private photograph while the worker is idle.
            request = None
            raw = None
            line = b""


if __name__ == "__main__":
    main()
