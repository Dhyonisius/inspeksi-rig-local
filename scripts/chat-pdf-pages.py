"""Index PDF text or render one page, keeping image memory bounded."""
import base64, json, sys, io
from pathlib import Path
from PIL import Image, ImageOps
Image.MAX_IMAGE_PIXELS=40000000
import pymupdf
try:
    source, mode = sys.argv[1:3]
    if mode == 'image':
        with Image.open(source) as photo:
            if photo.format not in {'JPEG','PNG','WEBP'} or photo.width*photo.height>40000000:
                raise ValueError('Gunakan JPG, PNG, atau WebP maksimal 40 megapiksel.')
            photo=ImageOps.exif_transpose(photo)
            photo.thumbnail((1600,1600))
            if photo.mode=='RGBA':
                background=Image.new('RGB',photo.size,'white');background.paste(photo,mask=photo.getchannel('A'));photo=background
            else: photo=photo.convert('RGB')
            output=io.BytesIO();photo.save(output,format='JPEG',quality=88)
            with pymupdf.open() as document:
                page=document.new_page(width=photo.width,height=photo.height)
                page.insert_image(page.rect,stream=output.getvalue())
                document.save(str(Path(source).with_name('source.pdf')))
        print(json.dumps({'pages':[{'page':1,'text':'','has_images':True,'layout':[]}]}))
        sys.exit(0)
    with pymupdf.open(source) as doc:
        if doc.needs_pass or not 1 <= len(doc) <= 500:
            raise ValueError('PDF harus tidak terkunci dan berisi 1-500 halaman.')
        if mode == 'index':
            pages=[]
            for i,p in enumerate(doc):
                blocks=p.get_text('blocks',sort=True)
                layout=[{'kind':'text','box':[round(v,1) for v in b[:4]],'text':b[4][:180]} for b in blocks if len(b)>6 and b[6]==0][:24]
                images=p.get_image_info()
                layout.extend({'kind':'image','box':[round(v,1) for v in image['bbox']]} for image in images[:12])
                text=p.get_text(sort=True)
                pages.append({'page':i+1,'text':text[:16000], 'has_images':bool(images) or not text.strip(), 'layout':sorted(layout,key=lambda b:b['box'][1])})
            print(json.dumps({'pages':pages}))
        else:
            number=int(sys.argv[3]); page=doc[number-1]; rect=page.rect
            if rect.width<=0 or rect.height<=0: raise ValueError('Ukuran halaman tidak valid.')
            scale=min(1.5,1200/max(rect.width,rect.height))
            pix=page.get_pixmap(matrix=pymupdf.Matrix(scale,scale),colorspace=pymupdf.csRGB,alpha=False)
            print(json.dumps({'page':number,'image':base64.b64encode(pix.tobytes('jpeg',jpg_quality=78)).decode()}))
except Exception as error:
    print(str(error)[:300],file=sys.stderr);sys.exit(1)
