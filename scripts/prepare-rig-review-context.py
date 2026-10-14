"""Read PDF placement/captions into review defaults without changing photos or labels."""
import argparse
import hashlib
import json
import logging
import re
import sys
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
import pdfplumber
from pypdf import PdfReader

ROOT = Path(__file__).resolve().parent.parent
logging.getLogger('pdfminer').setLevel(logging.ERROR)

def clean(value):
    return unicodedata.normalize('NFKC', value or '').replace('\x00', 't').strip()

def image_objects(page):
    result = {}
    for index, key in enumerate(page.images.keys(), 1):
        try:
            steps = key if isinstance(key, list) else [key]
            obj = page
            for step in steps:
                obj = obj['/Resources']['/XObject'][step]
            result[obj.indirect_reference.idnum] = index
        except (KeyError, AttributeError, TypeError):
            continue
    return result

def prepare(folder):
    manifest_path = ROOT / 'data/private/rig-pdf/prepared/manifest.json'
    manifest_bytes = manifest_path.read_bytes()
    manifest = json.loads(manifest_bytes)
    if manifest.get('source') != 'PROTECT_RIG_PDF':
        raise ValueError('Manifest bukan PDF Protect.')
    placements = {}
    documents = []
    warnings = []
    for document in manifest['documents']:
        source = folder / document['name']
        if source.parent.resolve() != folder.resolve() or source.suffix.lower() != '.pdf':
            raise ValueError('Lokasi PDF tidak valid.')
        if hashlib.sha256(source.read_bytes()).hexdigest() != document['sha256']:
            raise ValueError(f"PDF sumber berubah: {document['name']}")
        reader = PdfReader(source)
        area = None
        checklist = None
        caption = None
        matched = 0
        with pdfplumber.open(source) as pdf:
            for number, page in enumerate(pdf.pages, 1):
                object_map = image_objects(reader.pages[number - 1])
                events = [(line['top'], 0, line) for line in page.extract_text_lines(return_chars=False)
                          if 95 <= line['top'] < 765]
                events += [(image['top'], 1, image) for image in page.images]
                for _, kind, event in sorted(events, key=lambda row: (row[0], row[1])):
                    if kind == 0:
                        text = clean(event['text'])
                        if text.startswith('■'):
                            area = text[1:].strip()
                            checklist = None
                            caption = None
                        elif text.startswith(('✓', '✗')):
                            parsed = re.match(r'^[✓✗]\s*(.*?)\s*(?:\[([^\]]+)\])?\s*(?:🕐\s*([0-9:]+))?$', text)
                            checklist = {'name': parsed.group(1).strip() if parsed else text[1:].strip(),
                                         'frequency': parsed.group(2) if parsed else None,
                                         'time': parsed.group(3) if parsed else None,
                                         'mark': 'CHECKED' if text.startswith('✓') else 'NOT_CHECKED',
                                         'item_page': number}
                            caption = None
                        elif text.startswith('📷'):
                            filename = text[1:].strip()
                            caption = {'filename': filename, 'caption_page': number, 'area_name': area,
                                       **(checklist or {})} if checklist else None
                    else:
                        index = object_map.get(getattr(event.get('stream'), 'objid', None))
                        if index is None or not caption:
                            continue
                        key = (document['sha256'], number, index)
                        candidate = {**caption, 'pdf_name': document['name'], 'pdf_sha256': document['sha256'],
                                     'rig_name': document['rig_name'], 'page': number, 'image_index': index}
                        placements.setdefault(key, []).append(candidate)
                        matched += 1
                page.flush_cache()
        documents.append({'name': document['name'], 'sha256': document['sha256'], 'placements': matched})
        print(json.dumps({'document': document['name'], 'placements': matched}), flush=True)
    items = {}
    for item in manifest['items']:
        candidates = []
        seen = set()
        for occurrence in item['occurrences']:
            key = (occurrence['pdf_sha256'], occurrence['page'], occurrence['image_index'])
            for candidate in placements.get(key, []):
                identity = json.dumps(candidate, sort_keys=True)
                if identity not in seen:
                    candidates.append(candidate)
                    seen.add(identity)
            if key not in placements:
                warnings.append({'checksum': item['checksum'], 'pdf_name': occurrence['pdf_name'],
                                 'page': occurrence['page'], 'image_index': occurrence['image_index'],
                                 'reason': 'Caption/item checklist belum dapat dicocokkan dari posisi PDF.'})
        items[item['checksum']] = {'candidates': candidates}
    value = {'schema_version': 1, 'source': 'PROTECT_RIG_PDF',
             'manifest_sha256': hashlib.sha256(manifest_bytes).hexdigest(),
             'created_at': datetime.now(timezone.utc).isoformat(), 'documents': documents,
             'items': items, 'warnings': warnings, 'human_reviewed': False,
             'method': 'PDF_IMAGE_OBJECT_AND_POSITION_WITH_CAPTION_CROSS_PAGE'}
    target = ROOT / 'data/private/rig-pdf/review-context.json'
    temporary = target.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(target)
    print(json.dumps({'photos': len(items), 'with_pdf_context': sum(bool(row['candidates']) for row in items.values()),
                      'unmatched_occurrences': len(warnings), 'output': str(target)}), flush=True)

if __name__ == '__main__':
    sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('folder', type=Path)
    prepare(parser.parse_args().folder)
