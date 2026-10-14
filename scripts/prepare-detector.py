"""One-time preparation of the publisher's SH17 YOLOv8n into a CPU ONNX model.

Nothing is downloaded or trained by the application server. Run --install,
--download and --export explicitly; environments remain separate from Codex.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from datetime import datetime, timezone
import urllib.request
import venv

ROOT = Path(__file__).resolve().parent.parent
MODEL_DIR = ROOT / "models" / "sh17-yolov8n"
EXPORT_ENV = ROOT / "data" / "private" / "detector-export-env"
RUNTIME_ENV = ROOT / "data" / "private" / "detector-runtime"
WEIGHTS_URL = "https://github.com/ahmadmughees/SH17dataset/releases/download/v1/yolo8n.pt"
CLASS_URL = "https://raw.githubusercontent.com/ahmadmughees/SH17dataset/master/sh17.yaml"
CLASSES = ["person", "ear", "ear-mufs", "face", "face-guard", "face-mask", "foot", "tool", "glasses", "gloves", "helmet", "hands", "head", "medical-suit", "shoes", "safety-suit", "safety-vest"]


def env_python(folder):
    return folder / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def run(command):
    (ROOT / "data" / "private" / "detector-settings").mkdir(parents=True, exist_ok=True)
    print("Running:", " ".join(str(part) for part in command), flush=True)
    subprocess.run([str(part) for part in command], check=True, env={**os.environ, "YOLO_AUTOINSTALL": "False", "CUDA_VISIBLE_DEVICES": "", "YOLO_CONFIG_DIR": str(ROOT / "data" / "private" / "detector-settings")})


def install():
    for folder in [RUNTIME_ENV, EXPORT_ENV]:
        if not env_python(folder).exists():
            venv.EnvBuilder(with_pip=True).create(folder)
    run([env_python(RUNTIME_ENV), "-m", "pip", "install", "--disable-pip-version-check", "onnxruntime==1.23.2", "numpy==2.2.6", "Pillow==11.3.0"])
    run([env_python(EXPORT_ENV), "-m", "pip", "install", "--disable-pip-version-check", "torch==2.8.0", "torchvision==0.23.0", "--index-url", "https://download.pytorch.org/whl/cpu"])
    run([env_python(EXPORT_ENV), "-m", "pip", "install", "--disable-pip-version-check", "ultralytics==8.3.203", "onnx==1.19.0", "onnxruntime==1.23.2", "numpy==2.2.6", "Pillow==11.3.0"])


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download_file(url, destination, limit):
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix(destination.suffix + ".download")
    size = 0
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "InspeksiVisualLocal/1.0"})
        with urllib.request.urlopen(request, timeout=60) as response, temporary.open("wb") as target:
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > limit:
                    raise ValueError("Unduhan melebihi batas ukuran yang diizinkan.")
                target.write(chunk)
        temporary.replace(destination)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise
    print(json.dumps({"downloaded": str(destination), "bytes": size, "sha256": sha256(destination)}), flush=True)


def download():
    # Pin publisher release v1, never a COCO checkpoint with the same architecture.
    download_file(WEIGHTS_URL, MODEL_DIR / "source-yolo8n.pt", 16 * 1024 * 1024)
    download_file(CLASS_URL, MODEL_DIR / "source-sh17.yaml", 32 * 1024)
    text = (MODEL_DIR / "source-sh17.yaml").read_text(encoding="utf-8")
    for index, name in enumerate(CLASSES):
        if f"{index}: {name}" not in text:
            raise ValueError("Peta kelas resmi SH17 berubah; periksa sebelum ekspor.")


def export():
    python = env_python(EXPORT_ENV)
    if Path(sys.executable).resolve() != python.resolve():
        if not python.exists():
            raise ValueError("Lingkungan ekspor belum tersedia. Jalankan --install lebih dahulu.")
        run([python, __file__, "--export"])
        return
    os.environ["YOLO_AUTOINSTALL"] = "False"
    os.environ["CUDA_VISIBLE_DEVICES"] = ""
    os.environ["YOLO_CONFIG_DIR"] = str(ROOT / "data" / "private" / "detector-settings")
    (ROOT / "data" / "private" / "detector-settings").mkdir(parents=True, exist_ok=True)
    import importlib.metadata
    import onnx
    from ultralytics import YOLO

    weights = MODEL_DIR / "source-yolo8n.pt"
    if not weights.exists():
        raise ValueError("Bobot resmi belum diunduh. Jalankan --download lebih dahulu.")
    model = YOLO(str(weights))
    names = [model.names[index] for index in range(len(model.names))]
    if names != CLASSES or model.task != "detect":
        raise ValueError("Bobot tidak sesuai dengan 17 kelas deteksi SH17 resmi.")
    exported = Path(model.export(format="onnx", imgsz=640, batch=1, dynamic=False, simplify=False, opset=17, device="cpu", half=False, nms=False))
    artifact = MODEL_DIR / "model.onnx"
    if exported != artifact:
        shutil.copyfile(exported, artifact)
    graph = onnx.load(str(artifact))
    onnx.checker.check_model(graph)
    shape = [part.dim_value for part in graph.graph.output[0].type.tensor_type.shape.dim]
    if shape != [1, 21, 8400]:
        raise ValueError(f"Bentuk keluaran YOLOv8 SH17 tidak didukung: {shape}")
    # A local checksum detects changes after preparation. The publisher does not
    # publish an independent checksum; source authenticity rests on HTTPS release.
    manifest = {"schema_version": 1, "model_name": "SH17 YOLOv8n", "architecture": "yolov8_raw", "scope": "objects_only", "device": "cpu", "input_size": 640,
        "model_file": "model.onnx", "sha256": sha256(artifact), "model_bytes": artifact.stat().st_size, "class_names": CLASSES,
        "created_at": datetime.now(timezone.utc).isoformat(), "source_url": WEIGHTS_URL,
        "source_weights_sha256": sha256(weights), "class_source_url": CLASS_URL, "class_source_sha256": sha256(MODEL_DIR / "source-sh17.yaml"),
        "dataset_license": "CC BY-NC-SA 4.0", "software_license": "Ultralytics AGPL-3.0", "author": "Hafiz Mughees Ahmad dan Afshin Rahimi",
        "versions": {name: importlib.metadata.version(name) for name in ["ultralytics", "torch", "onnx", "onnxruntime", "numpy", "Pillow"]},
        "evaluation_note": "Bobot penerbit pernah melihat TRAIN resmi. TEST lokal turunan TRAIN tidak independen untuk bobot ini."}
    (MODEL_DIR / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ready": True, "manifest": str(MODEL_DIR / "manifest.json"), "model_bytes": manifest["model_bytes"], "sha256": manifest["sha256"]}), flush=True)


def check():
    path = MODEL_DIR / "manifest.json"
    if not path.exists():
        print(json.dumps({"ready": False, "reason": "Belum disiapkan.", "runtime_python": str(env_python(RUNTIME_ENV))}))
        return
    manifest = json.loads(path.read_text(encoding="utf-8"))
    valid = manifest.get("class_names") == CLASSES and manifest.get("sha256") == sha256(MODEL_DIR / "model.onnx")
    print(json.dumps({"ready": valid, "model_name": manifest.get("model_name"), "model_bytes": manifest.get("model_bytes"), "runtime_python": str(env_python(RUNTIME_ENV))}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--install", action="store_true", help="Install isolated CPU export and minimal runtime dependencies.")
    parser.add_argument("--download", action="store_true", help="Download the official publisher v1 SH17 nano weights and class map.")
    parser.add_argument("--export", action="store_true", help="Export and checksum a static CPU ONNX model without training.")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    try:
        if args.install:
            install()
        if args.download:
            download()
        if args.export:
            export()
        if args.check or not any([args.install, args.download, args.export]):
            check()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(2)
