"""Create a small inference copy; never modify the original evidence file."""
from io import BytesIO
import json
import sys
from PIL import Image, ImageOps, UnidentifiedImageError

Image.MAX_IMAGE_PIXELS = 40_000_000
try:
    edge = int(sys.argv[1])
    if edge not in (768, 1024):
        raise ValueError('Profil foto AI tidak valid.')
    raw = sys.stdin.buffer.read(12 * 1024 * 1024 + 1)
    if not raw or len(raw) > 12 * 1024 * 1024:
        raise ValueError('Foto AI terlalu besar atau kosong.')
    with Image.open(BytesIO(raw)) as source:
        if source.format not in ('JPEG', 'PNG', 'WEBP'):
            raise ValueError('Format gambar tidak didukung. Pilih JPG, PNG, atau WebP.')
        if source.width * source.height > 40_000_000:
            raise ValueError('Ukuran piksel foto terlalu besar.')
        image = ImageOps.exif_transpose(source)
        image.thumbnail((edge, edge), Image.Resampling.LANCZOS)
        if image.mode in ('RGBA', 'LA') or (image.mode == 'P' and 'transparency' in image.info):
            foreground = image.convert('RGBA')
            rgb = Image.new('RGB', image.size, (255, 255, 255))
            rgb.paste(foreground, mask=foreground.getchannel('A'))
        else:
            rgb = image.convert('RGB')
        output = BytesIO()
        rgb.save(output, format='JPEG', quality=86, optimize=True)
        metadata = {'width': rgb.width, 'height': rgb.height}
        sys.stdout.buffer.write(json.dumps(metadata).encode('utf-8') + b'\n' + output.getvalue())
except (ValueError, OSError, UnidentifiedImageError, Image.DecompressionBombError) as error:
    print(str(error)[:220], file=sys.stderr)
    sys.exit(2)
