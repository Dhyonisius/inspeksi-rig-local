"""Render bounded PDF pages for multimodal chat; no files are persisted."""
import base64
import json
import sys
import pymupdf

try:
    data = sys.stdin.buffer.read(8 * 1024 * 1024 + 1)
    if not data.startswith(b'%PDF-') or len(data) > 8 * 1024 * 1024:
        raise ValueError('Pilih PDF valid maksimal 8 MB.')
    with pymupdf.open(stream=data, filetype='pdf') as doc:
        if doc.needs_pass or not 1 <= len(doc) <= 8:
            raise ValueError('PDF harus tidak terkunci dan berisi 1-8 halaman.')
        pages = []
        for number, page in enumerate(doc, 1):
            rect = page.rect
            if rect.width <= 0 or rect.height <= 0:
                raise ValueError('Ukuran halaman PDF tidak valid.')
            scale = min(1.5, 1400 / max(rect.width, rect.height))
            image = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), colorspace=pymupdf.csRGB, alpha=False)
            pages.append({'page': number, 'text': page.get_text()[:6000],
                          'image': base64.b64encode(image.tobytes('jpeg', jpg_quality=80)).decode('ascii')})
        print(json.dumps({'pages': pages}))
except Exception as error:
    print(str(error)[:300], file=sys.stderr)
    sys.exit(1)
