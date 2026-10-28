"""Extract independent photo/context evidence; PDF remains a replaceable source."""
import argparse,hashlib,io,json,re,unicodedata
from pathlib import Path
from PIL import Image,ImageOps
from pypdf import PdfReader
import pdfplumber
Image.MAX_IMAGE_PIXELS=40000000

def clean(text):
    return unicodedata.normalize('NFKC',text or '').replace('\x00','t')
def digest(data):return hashlib.sha256(data).hexdigest()
def parse(source,dest):
    reader=PdfReader(source)
    if reader.is_encrypted or not 1<=len(reader.pages)<=150:raise ValueError('PDF terkunci atau jumlah halaman di luar batas 1-150.')
    dest.mkdir(parents=True,exist_ok=True);(dest/'images').mkdir(exist_ok=True)
    texts=[clean(p.extract_text()) for p in reader.pages]
    attachment=None
    if 'crssc-report.json' in reader.attachments:
        attachment=json.loads(reader.attachments['crssc-report.json'][0])
        if attachment.get('schema_version')!=1 or not isinstance(attachment.get('items'),list):raise ValueError('Metadata laporan tidak valid.')
        # Embedded data is accepted only after matching it against the PDF pages/images.
        if len(attachment['items'])>300:raise ValueError('Terlalu banyak item laporan.')
    ocr=None
    if not attachment:
        from rapidocr_onnxruntime import RapidOCR
        ocr=RapidOCR(intra_op_num_threads=1,inter_op_num_threads=1)
    rigmatch=re.search(r'Rig\s+(\S+)\s+Date',texts[0]);datematch=re.search(r'Date\s+(\d{4}-\d{2}-\d{2})',texts[0])
    report={'schema_version':1,'rig':attachment.get('rig') if attachment else (rigmatch.group(1) if rigmatch else source.stem),'date':attachment.get('date') if attachment else (datematch.group(1) if datematch else None),'is_dummy':bool(attachment and attachment.get('is_dummy')),'pages':len(reader.pages),'source_sha256':digest(source.read_bytes()),'text':'\n'.join(texts)[:250000], 'items':[],'skipped_na':0,'warnings':[]}
    previous_lines=[];role='';equipment='';seen=set();na_images=set();embedded_index=0;generic_index=0
    roles=['Toolpusher','Driller','Derrickman','Floorman','Mechanic','Truckpusher','HES Field']
    # Text and photographs can straddle page boundaries. Match the stable source
    # filename against the whole document rather than assuming one item per page.
    source_items={};whole='\n'.join(texts)
    matches=list(re.finditer(r'crssc_[\w.-]+\.(?:jpg|jpeg|png)',whole,re.I))
    for index,match in enumerate(matches):
        prefix=whole[:match.start()];tail=whole[match.end():matches[index+1].start() if index+1<len(matches) else len(whole)]
        equipment_matches=list(re.finditer(r'^Gûá\s+([^\n]+)',prefix,re.M))
        role_matches=list(re.finditer(r'^('+'|'.join(map(re.escape,roles))+r')\s+[^\n]*complete',prefix,re.M|re.I))
        checks=list(re.finditer(r'^([^\n]+?)\s+\[([^\]]+)\]',prefix,re.M))
        check=checks[-1].group(1) if checks else ''
        check=re.sub(r'^(?:G£|GÇ|ô|\s)+','',check).strip()
        remark=re.search(r'Remark:\s*["“]?([^\n"”]+)',tail,re.I)
        source_items[match.group()]={'equipment':equipment_matches[-1].group(1).strip() if equipment_matches else '', 'role':role_matches[-1].group(1) if role_matches else '', 'check_item':check,'frequency':checks[-1].group(2) if checks else '', 'remark':remark.group(1).strip() if remark else ''}
    with pdfplumber.open(source) as layout:
        for pi,page in enumerate(reader.pages):
            placements=sorted(layout.pages[pi].images,key=lambda x:(x['top'],x['x0']))
            if attachment and pi==0:continue
            image_map={str(key).lstrip('/'):page.images[key] for key in page.images.keys() if isinstance(key,str)}
            previous_bottom=65
            for placement in placements:
                name=placement['name'];file=image_map.get(name)
                if file is None:report['warnings'].append(f'Gambar halaman {pi+1} belum dapat dipasangkan.');continue
                image=ImageOps.exif_transpose(file.image).convert('RGB')
                if image.width*image.height<50000 or min(image.size)<100:continue
                before=clean(layout.pages[pi].crop((0,max(0,previous_bottom),layout.pages[pi].width,max(previous_bottom+1,placement['top']))).extract_text() or '')
                after_top=placement['bottom'];next_top=min([x['top'] for x in placements if x['top']>after_top]+[layout.pages[pi].height-30])
                after=clean(layout.pages[pi].crop((0,after_top,layout.pages[pi].width,max(after_top+1,next_top))).extract_text() or '')
                context='\n'.join(previous_lines[-6:]+before.splitlines()+after.splitlines()[:2])[:5000]
                if attachment:
                    if embedded_index>=len(attachment['items']):raise ValueError('Jumlah gambar melebihi metadata laporan.')
                    item=dict(attachment['items'][embedded_index]);embedded_index+=1
                    if item.get('filename') not in texts[pi] or item.get('equipment') not in texts[pi]:raise ValueError('Metadata tidak cocok dengan isi PDF.')
                else:
                    lines=before.splitlines()
                    for line in lines:
                        for r in roles:
                            if re.match(r'^'+re.escape(r)+r'\b',line):role=r
                        if '[' not in line and not any(k in line for k in ['Report','Check','Generated','Remark','crssc_','complete']) and len(line.strip())>4:
                            if not any(r in line for r in roles):equipment=re.sub(r'^[^A-Za-z]+','',line).strip() or equipment
                    checkline=next((line for line in reversed(lines) if '[' in line),'')
                    filename=re.search(r'crssc_[\w.-]+\.(?:jpg|jpeg|png)',before,re.I)
                    remark=re.search(r'Remark:\s*"?([^\n"]+)',after,re.I)
                    item={'id':f'P{pi+1}-{name}','role':role,'equipment':equipment,'check_item':re.sub(r'^[^A-Za-z]+','',checkline.split('[')[0]).strip(),'filename':filename.group() if filename else f'page-{pi+1}-{name}.jpg','remark':remark.group(1).strip() if remark else '', 'source_status':'RECORDED','is_na':False,'is_dummy':False}
                    if generic_index<len(matches):
                        expected=matches[generic_index].group()
                        if filename and filename.group()!=expected:report['warnings'].append(f'Urutan foto/caption halaman {pi+1} tidak cocok.')
                        item['filename']=expected;item.update(source_items[expected])
                    else:report['warnings'].append(f'Caption foto halaman {pi+1} tidak ditemukan.')
                    generic_index+=1
                    item['is_na']=bool(re.search(r'\bN\s*/?\s*A\b|not applicable|not available',item['remark'],re.I))
                item['page']=pi+1;item['source_context']=context
                previous_lines=before.splitlines()+after.splitlines();previous_bottom=placement['bottom']
                if ocr and not item.get('is_na'):
                    preview=image.copy();preview.thumbnail((800,800));encoded=io.BytesIO();preview.save(encoded,'JPEG',quality=88)
                    detected,_=ocr(encoded.getvalue());detected=detected or []
                    item['image_ocr']='\n'.join(str(row[1]) for row in detected)[:1200]
                    for box,text,score in detected:
                        area=(max(p[0] for p in box)-min(p[0] for p in box))*(max(p[1] for p in box)-min(p[1] for p in box))
                        if score>=0.85 and re.fullmatch(r'N\s*[/\\]?\s*A',str(text).strip(),re.I) and area/(preview.width*preview.height)>0.01:
                            item['is_na']=True;item['na_reason']='N/A pada bukti foto (OCR)';break
                image.thumbnail((1600,1600));out=io.BytesIO();image.save(out,'JPEG',quality=90,optimize=True);binary=out.getvalue();sha=digest(binary)
                if item.get('is_na') or item.get('source_status')=='NA':report['skipped_na']+=1;na_images.add(sha);continue
                item['checksum']=sha;item['image_path']='images/'+sha+'.jpg';item['width'],item['height']=image.size
                (dest/item['image_path']).write_bytes(binary)
                # Preserve every occurrence even when a photograph repeats across items.
                item['duplicate_photo']=sha in seen;seen.add(sha);report['items'].append(item)
    if attachment and embedded_index!=len(attachment['items']):raise ValueError('Ekstraksi belum lengkap: jumlah metadata dan gambar berbeda.')
    if not attachment and generic_index!=len(matches):report['warnings'].append('Jumlah foto dan caption sumber tidak sama.')
    # Identical N/A placeholder images remain N/A even where the caption omits it.
    retained=[]
    for item in report['items']:
        if item['checksum'] in na_images:report['skipped_na']+=1
        else:retained.append(item)
    report['items']=retained;used={i['checksum'] for i in retained}
    for image in (dest/'images').glob('*.jpg'):
        if image.stem not in used:image.unlink()
    report['photos']=len(used);report['source_policy']='TRUSTED_REPORT_SOURCE';report['extraction_complete']=not report['warnings']
    (dest/'report.json').write_text(json.dumps(report,ensure_ascii=False),encoding='utf-8')
    print(json.dumps({'items':len(report['items']),'photos':report['photos'],'skipped_na':report['skipped_na'],'complete':report['extraction_complete']}),flush=True)
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('source',type=Path);p.add_argument('destination',type=Path);a=p.parse_args();parse(a.source,a.destination)
