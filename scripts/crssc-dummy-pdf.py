"""Generate clearly synthetic CRSSC reports with independently embedded evidence."""
import argparse, hashlib, io, json, random
from datetime import datetime, timezone, timedelta
from pathlib import Path
from PIL import Image, ImageDraw
from reportlab.pdfgen import canvas
from reportlab.lib.colors import HexColor, white
from reportlab.lib.utils import ImageReader
from reportlab.lib.pagesizes import A4
from pypdf import PdfReader, PdfWriter

ROLES = ['Toolpusher','Driller','Derrickman','Floorman','Mechanic','Truckpusher','HES Field']
EQUIPMENT = [('Drippan','Bolting'),('Drilling Spool','Bolting'),('Annular','Safety Sling'),('Single Ram','Manual Lock'),('Accumulator','Warning Sign'),('Drawwork','Parking Brake'),('Drilling Line','Dead Line Anchor'),('Choke Manifold','Safety Pin'),('Travelling Block','Connection Pin Hook & Block'),('Crown Block','Crown O Matic'),('Mud Tank','Grounding System'),('Electric Motor','Safety Cover'),('Mud Pump','Safety Release Valve'),('Rod Tong','Torque Gauge')]

def image_for(item, seed):
    rng=random.Random(str(seed)+item['id']); im=Image.new('RGB',(720,480),'#e5eaf0'); d=ImageDraw.Draw(im)
    if item['source_status']=='NA':
        d.rectangle((40,40,680,440),fill='white',outline='#74849b',width=5)
        d.text((240,180),'N/A - NOT APPLICABLE',fill='#34455b',stroke_width=1)
    else:
        # Diagram evidence is intentionally synthetic, never an operational photo.
        d.rectangle((40,350,680,390),fill='#9eafbe')
        d.rounded_rectangle((130,130,575,350),radius=35,fill='#297e9b',outline='#123c50',width=9)
        for x in (160,260,440,540): d.ellipse((x,155,x+28,183),fill='#b9c5cc',outline='#364354',width=4)
        d.line((90,270,620,270),fill='#546476',width=25)
        if item['source_status']=='NOT_READY':
            d.line((360,135,390,220,350,255,400,350),fill='#be333b',width=14)
            d.ellipse((450,365,520,395),fill='#a5353f')
        d.text((50,415),item['equipment']+' / '+item['check_item'],fill='#172b43')
        d.text((50,435),'Variation '+str(rng.randrange(10000)),fill='#52677d')
    d.rectangle((0,0,720,45),fill='#162a43');d.text((24,15),'DUMMY / SYNTHETIC EVIDENCE - '+item['id'],fill='white')
    output=io.BytesIO();im.save(output,format='JPEG',quality=88);return output.getvalue()

def build(output, version, evidence_dir=None, rig='DUMMY-IDB-08'):
    moment=datetime.fromtimestamp(version*900,tz=timezone(timedelta(hours=7)))
    items=[]
    for i,(equipment,check) in enumerate(EQUIPMENT):
        status='NA' if i in (3,11) else ('NOT_READY' if (i+version)%5==0 else 'READY')
        items.append({'id':f'DUMMY-{version}-{i+1:03}','role':ROLES[i//2], 'equipment':equipment,'check_item':check,'frequency':'Per Tour','source_status':status,'remark':{'READY':'good - simulasi','NOT_READY':'Perlu perbaikan - simulasi','NA':'N/A - tidak berlaku pada simulasi ini'}[status],'captured_at':moment.isoformat(),'filename':f'dummy_crssc_{version}_{i+1:03}.jpg','is_na':status=='NA','is_dummy':True})
    for item in items:
        item['id']=rig+'-'+item['id'];item['filename']=item['filename'].replace('dummy_crssc_', 'dummy_crssc_'+rig+'_')
    manifest={'schema_version':1,'is_dummy':True,'rig':rig,'date':moment.date().isoformat(),'version':str(version),'generated_at':moment.isoformat(),'verified_by':'SIMULASI / SUMBER DUMMY','items':items}
    content=io.BytesIO(); c=canvas.Canvas(content,pagesize=A4,invariant=1);w,h=A4
    def frame(page):
        c.setFillColor(HexColor('#173651'));c.setFont('Helvetica-Bold',13);c.drawCentredString(w/2,h-36,'Comprehensive Rig Safeguard System Check')
        c.setFont('Helvetica',8);c.drawCentredString(w/2,h-49,'CRSSC Inspection Report - DUMMY / SIMULASI')
        c.setStrokeColor(HexColor('#1679cf'));c.line(36,h-60,w-36,h-60)
        c.setFillColor(HexColor('#5a7188'));c.setFont('Helvetica',7);c.drawString(36,27,'DUMMY CRSSC | '+moment.strftime('%d %b %Y %H:%M')+' WIB | version '+str(version))
        c.drawRightString(w-36,27,f'Page {page} of 8 - NOT FOR OPERATIONAL INSPECTION')
    frame(1); y=h-88
    for label,value in [('Rig',manifest['rig']),('Date',manifest['date']),('Records','7 role groups / 14 checklist items'),('Verified By','SIMULATED SOURCE - NO REAL INSPECTION')]:
        c.setFont('Helvetica-Bold',9);c.drawString(42,y,label);c.setFont('Helvetica',9);c.drawString(130,y,value);y-=21
    y-=15;c.setFont('Helvetica-Bold',12);c.drawString(42,y,'Compliance Summary');y-=25
    c.setFillColor(HexColor('#1476bd'));c.rect(40,y-5,w-80,24,fill=1,stroke=0);c.setFillColor(white);c.setFont('Helvetica-Bold',9)
    for x,t in [(48,'Role'),(240,'Safeguards Filled'),(355,'Compliance %'),(450,'Status')]:c.drawString(x,y+3,t)
    y-=29
    for role in ROLES:
        rows=[r for r in items if r['role']==role];filled=sum(r['source_status']!='NA' for r in rows);ready=sum(r['source_status']=='READY' for r in rows)
        c.setFillColor(HexColor('#eef3f8'));c.rect(40,y-7,w-80,25,fill=1,stroke=0);c.setFillColor(HexColor('#243c55'));c.setFont('Helvetica',9)
        for x,t in [(48,role),(240,f'{filled} / {len(rows)}'),(355,f'{round(100*ready/max(1,filled))}%'),(450,'DUMMY')]:c.drawString(x,y+2,t)
        y-=30
    c.setFont('Helvetica-Bold',11);c.drawString(42,y-20,'All photographs and values in this report are synthetic.')
    c.setFont('Helvetica',9);c.drawString(42,y-40,'Report version refreshes every 15 minutes. Export remains a normal PDF download.')
    c.showPage()
    for index,role in enumerate(ROLES):
        frame(index+2);y=h-85;c.setFillColor(HexColor('#153751'));c.setFont('Helvetica-Bold',12);c.drawString(40,y,role+' - Inspection Detail');y-=30
        for item in [r for r in items if r['role']==role]:
            c.setFillColor(HexColor('#126aba'));c.setFont('Helvetica-Bold',10);c.drawString(43,y,item['equipment']);y-=17
            c.setFillColor(HexColor('#18354f'));c.setFont('Helvetica',9);c.drawString(43,y,item['check_item']+' [Per Tour]  Status: '+item['source_status']);y-=14
            c.setFont('Helvetica',7);c.drawString(43,y,item['filename']+' | '+item['captured_at']);y-=190
            binary=image_for(item,str(version)+'-'+rig)
            if evidence_dir:
                evidence_dir.mkdir(parents=True,exist_ok=True);(evidence_dir/item['filename']).write_bytes(binary)
            c.drawImage(ImageReader(io.BytesIO(binary)),60,y,width=285,height=190)
            y-=15;c.setFont('Helvetica',8);c.drawString(60,y,'Remark: '+item['remark']);y-=34
        c.showPage()
    c.save();writer=PdfWriter();writer.append(PdfReader(io.BytesIO(content.getvalue())))
    writer.add_attachment('crssc-report.json',json.dumps(manifest,ensure_ascii=False).encode())
    output.parent.mkdir(parents=True,exist_ok=True)
    with output.open('wb') as stream:writer.write(stream)
    output.with_suffix('.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
    print(json.dumps({'path':str(output),'version':version,'pages':8,'items':len(items),'na':2}),flush=True)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('output',type=Path);p.add_argument('--version',type=int,required=True);p.add_argument('--evidence-dir',type=Path);p.add_argument('--rig',default='DUMMY-IDB-08');a=p.parse_args()
    if not a.rig.replace('-','').isalnum() or len(a.rig)>30:p.error('Nama rig tidak valid.')
    build(a.output,a.version,a.evidence_dir,a.rig)
