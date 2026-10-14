"""Decode an uploaded raster image and re-encode it without EXIF metadata."""
from io import BytesIO
import sys

from PIL import Image, ImageOps, UnidentifiedImageError

Image.MAX_IMAGE_PIXELS = 40_000_000
raw = sys.stdin.buffer.read()
try:
    source = Image.open(BytesIO(raw))
    kind = source.format
    if kind not in {"JPEG", "PNG", "WEBP"}:
        raise ValueError("Format gambar tidak didukung.")
    if source.width * source.height > 40_000_000:
        raise ValueError("Ukuran piksel foto terlalu besar.")
    image = ImageOps.exif_transpose(source)
    has_alpha = image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info)
    output = BytesIO()
    if kind == "JPEG":
        image.convert("RGB").save(output, format="JPEG", quality=91, optimize=True, progressive=True)
    elif kind == "PNG":
        image.convert("RGBA" if has_alpha else "RGB").save(output, format="PNG", optimize=True)
    else:
        image.convert("RGBA" if has_alpha else "RGB").save(output, format="WEBP", quality=91, method=5)
    sys.stdout.buffer.write(output.getvalue())
except (UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
    print("Foto tidak dapat dibaca sebagai gambar yang valid.", file=sys.stderr)
    sys.exit(2)
except ValueError as exc:
    print(str(exc), file=sys.stderr)
    sys.exit(2)
