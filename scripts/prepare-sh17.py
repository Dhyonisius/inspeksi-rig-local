"""Download and prepare the official SH17 dataset without running publisher code."""
from __future__ import annotations
import argparse
import concurrent.futures
import hashlib
import io
import json
import math
import os
from pathlib import Path
import re
import shutil
import threading
import time
import urllib.request
import urllib.parse
import zipfile
import xml.etree.ElementTree as ET

from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / "data" / "private" / "public-datasets" / "sh17"
PREPARED = BASE / "prepared"
SLUG = "mugheesahmad/sh17-dataset-for-ppe-detection"
API = "https://www.kaggle.com/api/v1/datasets/"
PUBLISHER_COMMIT = "2f832c289f9deea063367045ed8230b26e3e7ea9"
CLASS_NAMES = ["person", "ear", "ear-mufs", "face", "face-guard", "face-mask", "foot", "tool", "glasses", "gloves", "helmet", "hands", "head", "medical-suit", "shoes", "safety-suit", "safety-vest"]
DISPLAY_NAMES = ["Orang", "Telinga", "Pelindung telinga", "Wajah", "Pelindung wajah", "Masker", "Kaki", "Alat", "Kacamata", "Sarung tangan", "Helm", "Tangan", "Kepala", "Pakaian medis", "Sepatu", "Pakaian pelindung", "Rompi keselamatan"]

def atomic_json(file: Path, value):
    file.parent.mkdir(parents=True, exist_ok=True)
    temporary = file.with_name(file.name + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, file)

def status(**values):
    atomic_json(BASE / "download-status.json", {"dataset_key": "sh17", "updated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), **values})

def fetch_json(url):
    request = urllib.request.Request(url, headers={"User-Agent": "InspeksiLokal-Dataset/1.0"})
    with urllib.request.urlopen(request, timeout=60) as response:
        if response.status != 200:
            raise RuntimeError("Metadata sumber tidak tersedia.")
        return json.load(response)

def sha_file(file):
    checksum = hashlib.sha256()
    with file.open("rb") as source:
        for block in iter(lambda: source.read(4 * 1024 * 1024), b""):
            checksum.update(block)
    return checksum.hexdigest()

def download(connections):
    BASE.mkdir(parents=True, exist_ok=True)
    metadata_file = BASE / "source-metadata.json"
    metadata = fetch_json(API + "view/" + SLUG)
    if metadata.get("ref") != SLUG or metadata.get("licenseName") != "CC BY-NC-SA 4.0":
        raise RuntimeError("Identitas atau lisensi dataset sumber berubah. Periksa sumber sebelum melanjutkan.")
    atomic_json(metadata_file, metadata)
    version = int(metadata["currentVersionNumber"])
    archive = BASE / f"sh17-kaggle-v{version}.zip"
    partial = archive.with_suffix(".zip.part")
    if archive.is_file() and zipfile.is_zipfile(archive):
        print("Arsip lokal tersedia; melanjutkan persiapan.", flush=True)
        return archive, metadata
    if shutil.disk_usage(BASE).free < int(metadata.get("totalBytes", 0)) * 2 + 2 * 1024**3:
        raise RuntimeError("Ruang penyimpanan belum cukup untuk arsip dan foto yang disiapkan.")
    url = API + "download/" + SLUG + f"?datasetVersionNumber={version}"
    request = urllib.request.Request(url, headers={"User-Agent": "InspeksiLokal-Dataset/1.0", "Range": "bytes=0-0"})
    with urllib.request.urlopen(request, timeout=60) as response:
        content_range = response.headers.get("Content-Range", "")
        if response.status != 206 or not re.fullmatch(r"bytes 0-0/[0-9]+", content_range):
            raise RuntimeError("Sumber belum mendukung unduhan yang dapat dilanjutkan. Periksa Kaggle.")
        total = int(content_range.split("/")[-1])
    parts = BASE / f"parts-v{version}"
    parts.mkdir(exist_ok=True)
    chunk_size = 16 * 1024**2
    spans = [(index, start, min(total, start+chunk_size)-start) for index, start in enumerate(range(0, total, chunk_size))]
    # Reuse complete chunks from an earlier sequential attempt.
    old_size = partial.stat().st_size if partial.exists() else 0
    if old_size:
        with partial.open("rb") as old:
            for index, start, length in spans:
                if start+length > old_size:
                    break
                piece = parts / f"{index:05d}.part"
                if not piece.exists():
                    old.seek(start)
                    piece.write_bytes(old.read(length))
    progress_lock = threading.Lock()
    received = [sum(min((parts / f"{index:05d}.part").stat().st_size, length) for index, start, length in spans if (parts / f"{index:05d}.part").exists())]
    def fetch_piece(span):
        index, start, length = span
        piece = parts / f"{index:05d}.part"
        for attempt in range(5):
            offset = piece.stat().st_size if piece.exists() else 0
            if offset == length:
                return
            if offset > length:
                raise RuntimeError("Ukuran bagian unduhan lokal tidak sesuai.")
            begin, end = start+offset, start+length-1
            try:
                request = urllib.request.Request(url, headers={"User-Agent": "InspeksiLokal-Dataset/1.0", "Range": f"bytes={begin}-{end}"})
                with urllib.request.urlopen(request, timeout=60) as response:
                    if response.status != 206 or response.headers.get("Content-Range") != f"bytes {begin}-{end}/{total}":
                        raise RuntimeError("Sumber memberikan bagian unduhan yang tidak sesuai.")
                    with piece.open("ab") as destination:
                        remaining = length-offset
                        while remaining:
                            block = response.read(min(1024**2, remaining))
                            if not block:
                                raise RuntimeError("Bagian unduhan belum lengkap.")
                            destination.write(block)
                            remaining -= len(block)
                            with progress_lock:
                                received[0] += len(block)
                if piece.stat().st_size != length:
                    raise RuntimeError("Bagian unduhan belum lengkap.")
                return
            except Exception:
                if attempt == 4:
                    raise
                time.sleep(min(20, 2**attempt))
    print(f"Melanjutkan unduhan dengan {connections} koneksi: {received[0] / 1024**3:.2f} / {total / 1024**3:.2f} GiB", flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=connections) as pool:
        pending = {pool.submit(fetch_piece, span) for span in spans}
        while pending:
            done, pending = concurrent.futures.wait(pending, timeout=5, return_when=concurrent.futures.FIRST_EXCEPTION)
            for future in done:
                future.result()
            status(status="DOWNLOADING", bytes_downloaded=received[0], total_bytes=total, archive_available=False, source_version=version)
            print(f"Unduhan: {received[0] / 1024**3:.2f} / {total / 1024**3:.2f} GiB", flush=True)
    with partial.open("wb") as destination:
        for index, start, length in spans:
            with (parts / f"{index:05d}.part").open("rb") as source:
                shutil.copyfileobj(source, destination, 4 * 1024**2)
    if not zipfile.is_zipfile(partial):
        raise RuntimeError("Sumber tidak memberikan arsip ZIP; periksa akses Kaggle.")
    os.replace(partial, archive)
    for index, start, length in spans:
        (parts / f"{index:05d}.part").unlink()
    checksum = sha_file(archive)
    atomic_json(BASE / "archive-manifest.json", {"dataset_slug": SLUG, "version": version, "archive_name": archive.name, "size_bytes": archive.stat().st_size, "sha256": checksum})
    status(status="DOWNLOADED", bytes_downloaded=archive.stat().st_size, total_bytes=archive.stat().st_size, archive_available=True, source_version=version, archive_sha256=checksum)
    return archive, metadata

def relative_name(value):
    return value.strip().replace("\\", "/").split("/")[-1]

def transform_box(box, orientation):
    x, y, w, h = box["x"], box["y"], box["width"], box["height"]
    transforms = {
        2: lambda a, b: (1-a, b), 3: lambda a, b: (1-a, 1-b),
        4: lambda a, b: (a, 1-b), 5: lambda a, b: (b, a),
        6: lambda a, b: (1-b, a), 7: lambda a, b: (1-b, 1-a),
        8: lambda a, b: (b, 1-a),
    }
    transform = transforms.get(orientation, lambda a, b: (a, b))
    points = [transform(a, b) for a, b in [(x, y), (x+w, y), (x, y+h), (x+w, y+h)]]
    left, top = min(p[0] for p in points), min(p[1] for p in points)
    return {"class_index": box["class_index"], "x": left, "y": top, "width": max(p[0] for p in points)-left, "height": max(p[1] for p in points)-top}

def parse_annotations(value, name):
    annotations = []
    for row_number, line in enumerate(value.splitlines(), 1):
        if not line.strip():
            continue
        fields = line.split()
        if len(fields) != 5:
            raise ValueError(f"Format label tidak sesuai: {name}, baris {row_number}")
        class_index = int(fields[0])
        cx, cy, width, height = map(float, fields[1:])
        if class_index not in range(17) or not all(math.isfinite(n) for n in (cx, cy, width, height)) or width <= 0 or height <= 0:
            raise ValueError(f"Label atau ukuran kotak tidak valid: {name}, baris {row_number}")
        x, y = cx-width/2, cy-height/2
        if min(x, y) < -0.00001 or x+width > 1.00001 or y+height > 1.00001:
            raise ValueError(f"Kotak berada di luar foto: {name}, baris {row_number}")
        x, y = max(0, x), max(0, y)
        annotations.append({"class_index": class_index, "x": x, "y": y, "width": min(width, 1-x), "height": min(height, 1-y)})
    return annotations

def prepare(archive, metadata, workers, max_edge, source_urls=None):
    PREPARED.mkdir(parents=True, exist_ok=True)
    def open_archive():
        if source_urls is None:
            return zipfile.ZipFile(archive)
        from sh17_http_zip import HttpZipReader
        url = API + "download/" + SLUG + f"?datasetVersionNumber={metadata['currentVersionNumber']}"
        return zipfile.ZipFile(HttpZipReader(url, BASE / f"range-cache-v{metadata['currentVersionNumber']}"))
    with open_archive() as source:
        members = source.infolist()
        if any(member.flag_bits & 1 for member in members):
            raise RuntimeError("Arsip terenkripsi tidak didukung.")
        images = [member for member in members if Path(member.filename).suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"} and not member.is_dir()]
        if len(images) != 8099:
            raise RuntimeError(f"Jumlah foto sumber {len(images)} berbeda dari 8099; periksa versi arsip sebelum impor.")
        by_image = {relative_name(member.filename): member for member in images}
        if len(by_image) != len(images):
            raise RuntimeError("Nama foto ganda ditemukan dalam arsip.")
        if len({Path(name).stem.lower() for name in by_image}) != len(images):
            raise RuntimeError("ID foto ganda ditemukan dalam arsip.")
        split_files = {relative_name(member.filename): member for member in members if relative_name(member.filename) in {"train_files.txt", "test_files.txt", "val_files.txt"}}
        if "train_files.txt" not in split_files or "val_files.txt" not in split_files:
            raise RuntimeError("Daftar TRAIN/VALIDATION resmi tidak ditemukan dalam arsip.")
        read_split = lambda member: {relative_name(line) for line in source.read(member).decode("utf-8-sig").splitlines() if line.strip()}
        train_ids, validation_ids = read_split(split_files["train_files.txt"]), read_split(split_files["val_files.txt"])
        if train_ids & validation_ids or train_ids | validation_ids != set(by_image):
            raise RuntimeError("Pembagian TRAIN/VALIDATION tumpang tindih atau tidak meliputi seluruh foto.")
        label_members = {}
        dimensions = {}
        xml_members = {Path(relative_name(member.filename)).stem: member for member in members if member.filename.startswith("voc_labels/") and member.filename.endswith(".xml")}
        for member in members:
            if member.is_dir() or Path(member.filename).suffix.lower() != ".txt" or relative_name(member.filename) in split_files:
                continue
            stem = Path(relative_name(member.filename)).stem
            if stem in label_members:
                raise RuntimeError(f"Label ganda ditemukan untuk {stem}.")
            label_members[stem] = member
        jobs = []
        test_candidates = sorted(train_ids, key=lambda name: hashlib.sha256(("sh17-test-1:" + name).encode()).hexdigest())
        test_ids = set(test_candidates[:max(1, round(len(train_ids)*.1))])
        for name, image in sorted(by_image.items()):
            source_id = Path(name).stem
            if not re.fullmatch(r"[A-Za-z0-9_.-]{1,180}", source_id):
                raise RuntimeError("Nama foto sumber tidak aman untuk persiapan lokal.")
            label = label_members.get(source_id)
            if label is None or label.file_size > 2 * 1024**2 or image.file_size > 100 * 1024**2:
                raise RuntimeError(f"Foto atau label belum tersedia/tidak sesuai: {name}")
            annotations = parse_annotations(source.read(label).decode("utf-8-sig"), label.filename)
            if source_urls is not None:
                xml = xml_members.get(source_id)
                if not xml or xml.file_size > 2 * 1024**2:
                    raise RuntimeError(f"Dimensi foto sumber belum tersedia: {name}")
                doc = ET.fromstring(source.read(xml))
                dimensions[source_id] = (int(doc.findtext("size/width")), int(doc.findtext("size/height")))
            split = "TEST" if name in test_ids else "VALIDATION" if name in validation_ids else "TRAIN"
            jobs.append((image.filename, source_id, split, annotations))
    # Each worker opens its own archive handle. Publisher scripts are never run.
    def process(job):
        member, source_id, split, annotations = job
        relative = f"images/{split.lower()}/{source_id}.jpg"
        output = PREPARED / relative
        receipt = output.with_suffix(".json")
        def write_label(boxes):
            label_path = PREPARED / f"labels/{split.lower()}/{source_id}.txt"
            label_path.parent.mkdir(parents=True, exist_ok=True)
            label_path.write_text("".join(f"{b['class_index']} {b['x']+b['width']/2:.8f} {b['y']+b['height']/2:.8f} {b['width']:.8f} {b['height']:.8f}\n" for b in boxes), encoding="utf-8")
        annotation_digest = hashlib.sha256(json.dumps(annotations, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        if output.is_file() and receipt.is_file():
            item = json.loads(receipt.read_text(encoding="utf-8"))
            if item.get("checksum_sha256") == sha_file(output) and item.get("source_archive") == archive.name and item.get("max_edge") == max_edge and item.get("source_annotations_sha256") == annotation_digest and item.get("split") == split and item.get("preparation_version") == 2:
                write_label(item["annotations"])
                return item
        publisher_url = None
        if source_urls is None:
            with zipfile.ZipFile(archive) as source:
                binary = source.read(member)
        elif relative_name(member) not in source_urls:
            with open_archive() as source:
                binary = source.read(member)
        else:
            publisher_url = source_urls[relative_name(member)]
            parts = urllib.parse.urlsplit(publisher_url)
            parameters = dict(urllib.parse.parse_qsl(parts.query))
            parameters.update({"auto": "compress", "cs": "tinysrgb", "w": str(max_edge)})
            if any(key in parameters for key in ("h", "fit", "crop")):
                raise RuntimeError("Tautan sumber memiliki pemotongan gambar yang belum didukung.")
            url = urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, urllib.parse.urlencode(parameters), ""))
            for attempt in range(4):
                try:
                    with urllib.request.urlopen(url, timeout=45) as response:
                        binary = response.read(20 * 1024**2 + 1)
                    if len(binary) > 20 * 1024**2:
                        raise RuntimeError("Foto sumber melebihi batas unduhan.")
                    break
                except Exception:
                    if attempt == 3:
                        # Recover a retired source URL from its pinned archive.
                        with open_archive() as source:
                            binary = source.read(member)
                        break
                    time.sleep(2**attempt)
        with Image.open(io.BytesIO(binary)) as image:
            source_dimensions = list(image.size)
            if source_urls is not None:
                expected_width, expected_height = dimensions[source_id]
                if expected_width <= 0 or expected_height <= 0 or abs(image.width/image.height-expected_width/expected_height) > .005:
                    raise RuntimeError(f"Rasio foto sumber berubah: {source_id}")
            orientation = int(image.getexif().get(274, 1))
            if image.width <= 0 or image.height <= 0 or image.width*image.height > 80_000_000:
                raise RuntimeError(f"Dimensi foto tidak didukung: {source_id}")
            image = ImageOps.exif_transpose(image).convert("RGB")
            image.thumbnail((max_edge, max_edge), Image.Resampling.LANCZOS)
            output.parent.mkdir(parents=True, exist_ok=True)
            temporary = output.with_suffix(".jpg.tmp")
            image.save(temporary, format="JPEG", quality=90, optimize=True)
            os.replace(temporary, output)
            width, height = image.size
        annotations = [transform_box(box, orientation) for box in annotations]
        item = {"source_id": source_id, "image_path": relative, "checksum_sha256": sha_file(output), "split": split, "width": width, "height": height, "annotations": annotations, "source_archive": archive.name, "max_edge": max_edge, "source_dimensions": source_dimensions, "exif_orientation_applied": orientation, "publisher_image_url": publisher_url, "source_annotations_sha256": annotation_digest, "preparation_version": 2}
        write_label(annotations)
        atomic_json(receipt, item)
        return item
    items = []
    print(f"Persiapan {len(jobs)} foto; maksimal {max_edge}px; {workers} pekerja.", flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(process, job): job[1] for job in jobs}
        for future in concurrent.futures.as_completed(futures):
            items.append(future.result())
            if len(items) % 50 == 0 or len(items) == len(jobs):
                status(status="PREPARING", archive_available=source_urls is None, source_mode="publisher-image-urls" if source_urls is not None else "kaggle-archive", source_version=metadata["currentVersionNumber"], prepared_items=len(items), total_items=len(jobs))
                print(f"Persiapan foto: {len(items)} / {len(jobs)}", flush=True)
    items.sort(key=lambda item: item["source_id"])
    classes = [{"class_index": i, "name": name, "display_name": DISPLAY_NAMES[i], "annotation_count": sum(box["class_index"] == i for item in items for box in item["annotations"])} for i, name in enumerate(CLASS_NAMES)]
    annotation_count = sum(len(item["annotations"]) for item in items)
    if annotation_count != 75994:
        raise RuntimeError(f"Jumlah anotasi {annotation_count} berbeda dari 75994. Foto disiapkan tetapi manifest impor belum diterbitkan.")
    training = PREPARED / "training"
    training.mkdir(exist_ok=True)
    for split in ("TRAIN", "VALIDATION", "TEST"):
        paths = [str((PREPARED / item["image_path"]).resolve()).replace("\\", "/") for item in items if item["split"] == split]
        (training / f"{split.lower()}.txt").write_text("\n".join(paths) + "\n", encoding="utf-8")
    config = "path: " + json.dumps(str(PREPARED.resolve()).replace("\\", "/")) + '\ntrain: training/train.txt\nval: training/validation.txt\ntest: training/test.txt\nnc: 17\nnames: ' + json.dumps(CLASS_NAMES) + "\n"
    (training / "data.yaml").write_text(config, encoding="utf-8")
    source = {"publisher": "Hafiz Mughees Ahmad dan Afshin Rahimi", "source_url": "https://github.com/ahmadmughees/SH17dataset", "dataset_url": "https://www.kaggle.com/datasets/" + SLUG, "license_name": "CC BY-NC-SA 4.0", "license_url": "https://creativecommons.org/licenses/by-nc-sa/4.0/", "paper_url": "https://doi.org/10.1016/j.jnlssr.2024.09.002", "annotation_review": "Anotasi awal, koreksi oleh ketua tim, lalu verifikasi akhir oleh mahasiswa pascasarjana.", "publisher_commit": PUBLISHER_COMMIT, "publisher_image_urls_sha256": sha_file(BASE / 'publisher-image-urls.csv') if source_urls is not None else None, "kaggle_version": metadata['currentVersionNumber']}
    manifest = {"format_version": 1, "dataset_key": "sh17", "dataset_name": "SH17 · Objek/APD", "dataset_version": f"kaggle-v{metadata['currentVersionNumber']}-local-1", "source": source, "source_item_count": 8099, "source_annotation_count": 75994, "classes": classes, "items": items, "preparation": {"max_edge": max_edge, "jpeg_quality": 90, "metadata_removed": True, "source_mode": "publisher-image-urls" if source_urls is not None else "kaggle-archive", "split_policy": "VALIDATION resmi (val_files.txt) dipertahankan; 10% TRAIN resmi dipisahkan menjadi TEST lokal dengan urutan hash sh17-test-1", "image_count": len(items), "annotation_count": annotation_count, "training_config": "training/data.yaml"}}
    atomic_json(PREPARED / "manifest.json", manifest)
    status(status="READY", archive_available=source_urls is None, source_mode="publisher-image-urls" if source_urls is not None else "kaggle-archive", source_version=metadata["currentVersionNumber"], prepared_items=len(items), total_items=len(items), annotation_count=annotation_count, training_config=str(training / "data.yaml"))
    print(f"Siap: {len(items)} foto, {annotation_count} kotak, 17 kelas. Manifest: {PREPARED / 'manifest.json'}", flush=True)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--prepare", action="store_true")
    parser.add_argument("--workers", type=int, default=3, choices=range(1, 13))
    parser.add_argument("--connections", type=int, default=8, choices=range(1, 13))
    parser.add_argument("--source-images", action="store_true", help="Gunakan foto dari tautan resmi penulis pada resolusi persiapan; label dari arsip versi tetap.")
    parser.add_argument("--max-edge", type=int, default=2560)
    args = parser.parse_args()
    if not args.download and not args.prepare and not args.source_images:
        parser.error("Pilih --download dan/atau --prepare")
    if args.max_edge < 640 or args.max_edge > 8192:
        parser.error("max-edge harus 640–8192")
    try:
        source_urls = None
        if args.source_images:
            BASE.mkdir(parents=True, exist_ok=True)
            metadata = fetch_json(API + "view/" + SLUG)
            if metadata.get("ref") != SLUG or metadata.get("licenseName") != "CC BY-NC-SA 4.0":
                raise RuntimeError("Identitas atau lisensi dataset sumber berubah.")
            atomic_json(BASE / "source-metadata.json", metadata)
            csv_url = f"https://raw.githubusercontent.com/ahmadmughees/SH17dataset/{PUBLISHER_COMMIT}/data/list_of_all_urls.csv"
            with urllib.request.urlopen(csv_url, timeout=60) as response:
                csv = response.read(2 * 1024**2).decode("utf-8-sig")
            (BASE / "publisher-image-urls.csv").write_text(csv, encoding="utf-8")
            source_urls = {}
            for row in csv.splitlines():
                url = row.strip()
                parts = urllib.parse.urlsplit(url)
                if parts.scheme != "https" or parts.hostname != "images.pexels.com":
                    raise RuntimeError("Tautan foto dari daftar resmi tidak sesuai.")
                name = urllib.parse.unquote(parts.path.split("/")[-1])
                if name in source_urls:
                    raise RuntimeError("Nama foto ganda dalam tautan resmi.")
                source_urls[name] = url
            archive = BASE / f"sh17-kaggle-v{metadata['currentVersionNumber']}-publisher-source.zip"
            status(status="PREPARING", archive_available=False, source_version=metadata["currentVersionNumber"], prepared_items=0, total_items=8099, source_mode="publisher-image-urls")
            print("Mengambil label versi tetap dan foto dari tautan resmi penulis.", flush=True)
        elif args.download:
            archive, metadata = download(args.connections)
        else:
            metadata = json.loads((BASE / "source-metadata.json").read_text(encoding="utf-8"))
            archive = BASE / f"sh17-kaggle-v{metadata['currentVersionNumber']}.zip"
        if args.prepare or args.source_images:
            prepare(archive, metadata, args.workers, args.max_edge, source_urls)
    except Exception as error:
        status(status="FAILED", error=str(error))
        raise

if __name__ == "__main__":
    main()
