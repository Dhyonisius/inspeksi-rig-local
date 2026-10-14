"""Extract local rig PDF photographs and preserve source context for human review."""
import argparse
import hashlib
from io import BytesIO
import json
from pathlib import Path
import re
import unicodedata
from PIL import Image, ImageOps
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT / 'data' / 'private' / 'rig-pdf' / 'prepared'
Image.MAX_IMAGE_PIXELS = 40000000

def digest(value):
    return hashlib.sha256(value).hexdigest()

def clean(value):
    value = unicodedata.normalize('NFKC', value or '').replace('\x00', 't')
    return ''.join(c for c in value if c in '\n\t' or ord(c) >= 32)

def prepare(folder):
    DEST.mkdir(parents=True, exist_ok=True)
    images = DEST / 'images'
    images.mkdir(exist_ok=True)
    rows, docs, seen, errors = [], [], {}, []
    sources = sorted(folder.glob('*.pdf'))
    if not sources or len(sources) > 30:
        raise ValueError('Folder harus berisi 1-30 PDF.')
    for source in sources:
        if source.stat().st_size > 100 * 1024 * 1024:
            raise ValueError('PDF melebihi 100 MiB.')
        source_sha = digest(source.read_bytes())
        reader = PdfReader(source)
        if reader.is_encrypted or len(reader.pages) > 600:
            raise ValueError('PDF terkunci atau jumlah halaman berlebihan.')
        texts = [clean(page.extract_text()) for page in reader.pages]
        rig_match = re.search(r'Rig\s+(\S+)\s+Date', texts[0])
        rig = rig_match.group(1) if rig_match else source.stem[:60]
        doc = {'name': source.name, 'sha256': source_sha, 'rig_name': rig, 'pages': len(reader.pages), 'images': 0, 'duplicates': 0, 'skipped_small': 0}
        for number, page in enumerate(reader.pages, 1):
            # A caption may precede a photograph split onto the next page. Keep
            # neighboring page text as context; never infer a safety label from it.
            context = '\n'.join(f'[Halaman {n+1}]\n{texts[n]}' for n in range(max(0, number-2), min(len(texts), number+1)))[:6000]
            for index, image_file in enumerate(page.images, 1):
                try:
                    image = image_file.image
                    if min(image.size) < 160 or image.width * image.height < 60000:
                        doc['skipped_small'] += 1
                        continue
                    if image.width * image.height > 40000000:
                        raise ValueError('Ukuran gambar terlalu besar.')
                    image = ImageOps.exif_transpose(image).convert('RGB')
                    image.thumbnail((2000, 2000), Image.Resampling.LANCZOS)
                    pixels_sha = digest(str(image.size).encode() + image.tobytes())
                    occurrence = {'pdf_name': source.name, 'pdf_sha256': source_sha, 'rig_name': rig, 'page': number, 'image_index': index, 'context': context}
                    if pixels_sha in seen:
                        seen[pixels_sha]['occurrences'].append(occurrence)
                        doc['duplicates'] += 1
                        continue
                    output = BytesIO()
                    image.save(output, format='JPEG', quality=91, optimize=True)
                    binary = output.getvalue()
                    if len(binary) > 8 * 1024 * 1024:
                        raise ValueError('Foto melebihi 8 MiB.')
                    sha = digest(binary)
                    image_path = f'images/{sha}.jpg'
                    (DEST / image_path).write_bytes(binary)
                    row = {'source_id': pixels_sha, 'checksum': sha, 'image_path': image_path, 'width': image.width, 'height': image.height,
                           'bytes': len(binary), 'occurrences': [occurrence]}
                    rows.append(row)
                    seen[pixels_sha] = row
                    doc['images'] += 1
                except Exception as error:
                    errors.append({'pdf': source.name, 'page': number, 'image_index': index, 'error': str(error)[:200]})
            if len(rows) > 3000:
                raise ValueError('Lebih dari 3000 foto; pisahkan impor.')
        docs.append(doc)
        print(json.dumps(doc), flush=True)
    manifest = {'schema_version': 1, 'source': 'PROTECT_RIG_PDF', 'dataset_name': 'Rig Protect - calon pelatihan', 'version': 'pdf-20261007-1',
                'documents': docs, 'items': rows, 'errors': errors, 'label_policy': 'UNCERTAIN_DRAFT_HUMAN_REVIEW',
                'note': 'Completion/compliance text in the checklist is not a visual safety label. All photographs require human review. All initial splits are TRAIN; split by rig/document group before evaluating.'}
    encoded = json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
    (DEST / 'manifest.json').write_bytes(encoded)
    print(json.dumps({'ready': True, 'unique_images': len(rows), 'errors': len(errors), 'manifest_sha256': digest(encoded), 'manifest': str(DEST / 'manifest.json')}))

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('folder', type=Path)
    args = parser.parse_args()
    prepare(args.folder)
