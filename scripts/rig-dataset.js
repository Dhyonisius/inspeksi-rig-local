import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseDatasetAnnotations } from './dataset-validation.js';
import { createRigReviewContext } from './rig-review-context.js';
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const labels = ['RISK','NO_LISTED_HAZARD_VISIBLE','UNCERTAIN'];
const splits = ['TRAIN','VALIDATION','TEST'];
const asJson = value => { try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; } };

export function createRigDataset(ctx) {
 const { root, privateDir, uploadDir, jsonQuery, executeSql, databaseName, sqlText, sqlAscii, intValue, httpError, jsonBody, sendJson, withDatasetReadLock } = ctx;
 const prepared = path.join(privateDir,'rig-pdf','prepared');
 const draftsDir = path.join(privateDir,'rig-pdf','ai-drafts');
 const reviewDefaults = createRigReviewContext({ privateDir });
 async function draftFile(name) { try {
  const data=JSON.parse(await fs.readFile(path.join(draftsDir,name),'utf8'));
  if(name==='status.json' && data.status==='RUNNING' && Number.isSafeInteger(data.pid)) {
   try { process.kill(data.pid,0); } catch(error) { if(error.code==='ESRCH') return {...data,status:'INTERRUPTED'}; }
  }
  return data;
 } catch { return null; } }
 let importPromise = null;
 const state = { status: 'PENDING', imported: 0, total: 0, dataset_id: null, error: null };
 const allowed = user => { if (!['admin','operator'].includes(user.role)) throw httpError(403,'Akun ini tidak dapat mengelola calon pelatihan.'); };
 const admin = user => { if (user.role !== 'admin') throw httpError(403,'Impor PDF dan pembagian kelompok hanya tersedia untuk admin.'); };
 const bodyObject = async request => { const body = await jsonBody(request); if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400,'Isi permintaan tidak valid.'); return body; };
 async function loadManifest() {
  const binary = await fs.readFile(path.join(prepared,'manifest.json'));
  if (binary.length > 20*1024*1024) throw Error('Manifest PDF terlalu besar.');
  const manifest = JSON.parse(binary);
  if (manifest.schema_version !== 1 || manifest.source !== 'PROTECT_RIG_PDF' || !Array.isArray(manifest.items) || manifest.items.length > 3000) throw Error('Manifest PDF tidak sesuai.');
  return { manifest, digest: hash(binary) };
 }
 async function importPrepared(user) {
  if (importPromise) return importPromise;
  importPromise = (async () => {
   state.status='RUNNING'; state.error=null;
   try {
    const {manifest,digest} = await loadManifest(); state.total=manifest.items.length; state.imported=0;
    const checkpoint = await jsonQuery(`SET XACT_ABORT ON; BEGIN TRANSACTION;
DECLARE @id INT,@known BIT=0,@completed BIT=0;
SELECT @id=dataset_id,@known=1,@completed=CASE WHEN completed_at IS NULL THEN 0 ELSE 1 END FROM dbo.RigPdfImport WITH(UPDLOCK,HOLDLOCK) WHERE manifest_sha256=${sqlAscii(digest)};
IF @known=0 BEGIN
 INSERT dbo.Dataset(created_by_user_id,name,version,status,notes,dataset_kind) VALUES(${user.user_id},${sqlText(manifest.dataset_name)},${sqlAscii(manifest.version)},'DRAFT',N'Foto PDF Protect: calon pelatihan, label belum diperiksa. Kelompok rig/dokumen harus dipisahkan sebelum evaluasi.','HAZARD'); SET @id=SCOPE_IDENTITY();
 INSERT dbo.RigPdfImport(manifest_sha256,dataset_id) VALUES(${sqlAscii(digest)},@id);
END;
COMMIT TRANSACTION;
SELECT @id AS dataset_id,@completed AS completed,CAST(CASE WHEN EXISTS(SELECT 1 FROM dbo.Dataset WHERE dataset_id=@id) THEN 1 ELSE 0 END AS BIT) AS present FOR JSON PATH,WITHOUT_ARRAY_WRAPPER;`);
    if (!checkpoint?.dataset_id) throw Error('Checkpoint impor belum terkonfirmasi.');
    state.dataset_id=checkpoint.dataset_id;
    const suppressedRows=await jsonQuery(`SELECT checksum FROM dbo.RigPdfItemSuppression WHERE dataset_id=${state.dataset_id} FOR JSON PATH;`)||[];
    const suppressed=new Set(suppressedRows.map(row=>row.checksum));
    if (!checkpoint.present) { state.status='DELETED'; return {...state}; }
    if (checkpoint.completed) { state.status='COMPLETED'; state.imported=state.total; return {...state}; }
    // Connected PDF groups sharing identical photos must stay in the same split.
    const parent = new Map(manifest.documents.map(doc=>[doc.sha256,doc.sha256]));
    const find = key => { if (!parent.has(key)) throw Error('Asal dokumen tidak dikenal.'); while(parent.get(key)!==key) key=parent.get(key); return key; };
    for (const row of manifest.items) { const docs=row.occurrences.map(o=>o.pdf_sha256); for(const doc of docs.slice(1)) parent.set(find(doc),find(docs[0])); }
    const components = new Map(); for(const key of parent.keys()) { const top=find(key); if(!components.has(top)) components.set(top,[]); components.get(top).push(key); }
    for (const row of manifest.items) {
     if(suppressed.has(row.checksum)) { state.imported++; continue; }
     if (!/^[a-f0-9]{64}$/.test(row.checksum) || row.image_path!==`images/${row.checksum}.jpg` || !Array.isArray(row.occurrences) || !row.occurrences.length) throw Error('Metadata foto PDF tidak valid.');
     const source = path.join(prepared,row.image_path), realSource=await fs.realpath(source), realPrepared=await fs.realpath(prepared);
     const realRoot=await fs.realpath(root),realUploads=await fs.realpath(uploadDir);
     if (realPrepared.toLowerCase()!==path.join(realRoot,'data','private','rig-pdf','prepared').toLowerCase() || realUploads.toLowerCase()!==path.join(realRoot,'data','private','uploads').toLowerCase() || !realSource.startsWith(realPrepared+path.sep)) throw Error('Lokasi gambar PDF tidak valid.');
     const binary=await fs.readFile(source); if(binary.length>8*1024*1024 || hash(binary)!==row.checksum) throw Error('Checksum gambar PDF tidak sesuai.');
     const group='pdf:'+hash(components.get(find(row.occurrences[0].pdf_sha256)).sort().join('|'));
     const name=crypto.randomUUID()+'.jpg', file=path.join(uploadDir,name);
     await fs.writeFile(file,binary,{flag:'wx'});
     let result;
     // Unknown commits retain their candidate; retry resolves by checksum/item.
     result=await withDatasetReadLock(state.dataset_id,()=>jsonQuery(`SET XACT_ABORT ON; BEGIN TRANSACTION;
DECLARE @image INT,@item INT,@new BIT=0,@locked BIT=0;
IF NOT EXISTS(SELECT 1 FROM dbo.Dataset WITH(UPDLOCK,HOLDLOCK) WHERE dataset_id=${state.dataset_id} AND status='DRAFT') SET @locked=1;
IF @locked=0 BEGIN
 SELECT @image=image_id FROM dbo.ImageAsset WITH(UPDLOCK,HOLDLOCK) WHERE checksum=${sqlAscii(row.checksum)};
 IF @image IS NULL BEGIN INSERT dbo.ImageAsset(uploaded_by_user_id,file_uri,original_name,mime_type,file_size_bytes,origin_type,license_name,license_verified,checksum) VALUES(${user.user_id},${sqlText('uploads/'+name)},${sqlText(`${row.occurrences[0].rig_name} - halaman ${row.occurrences[0].page} - ${row.source_id.slice(0,8)}.jpg`)},'image/jpeg',${binary.length},'DATASET',N'Izin internal PDF Protect belum dikonfirmasi',0,${sqlAscii(row.checksum)}); SET @image=SCOPE_IDENTITY(); SET @new=1; END;
 SELECT @item=dataset_item_id FROM dbo.DatasetItem WHERE dataset_id=${state.dataset_id} AND image_id=@image;
 IF @item IS NULL BEGIN
  INSERT dbo.DatasetItem(dataset_id,image_id,split,overall_label,label_status,labeled_by_user_id) VALUES(${state.dataset_id},@image,'TRAIN','UNCERTAIN','DRAFT',${user.user_id}); SET @item=SCOPE_IDENTITY();
  INSERT dbo.DatasetTrainingReview(dataset_item_id,source_kind,source_group_key,source_metadata) VALUES(@item,'PDF',${sqlAscii(group)},${sqlText(JSON.stringify({occurrences:row.occurrences,width:row.width,height:row.height}))});
 END;
END;
COMMIT TRANSACTION; SELECT @item AS dataset_item_id,@new AS new_image,@locked AS locked FOR JSON PATH,WITHOUT_ARRAY_WRAPPER;`));
     if (result?.locked) { await fs.unlink(file).catch(()=>{}); throw Error('Dataset sudah diajukan atau dihapus selama impor.'); }
     if (!result?.dataset_item_id || typeof result.new_image!=='boolean') throw Error('Hasil impor belum terkonfirmasi. Coba lanjutkan impor setelah memeriksa dataset.');
     if(!result.new_image) await fs.unlink(file).catch(()=>{});
     state.imported++;
    }
    await jsonQuery(`UPDATE dbo.RigPdfImport SET completed_at=SYSUTCDATETIME() WHERE manifest_sha256=${sqlAscii(digest)}; SELECT 1 AS ok FOR JSON PATH,WITHOUT_ARRAY_WRAPPER;`);
    state.status='COMPLETED';
   } catch(error) { state.status='FAILED'; state.error=String(error.message).slice(0,500); }
   return {...state};
  })().finally(()=>{importPromise=null;});
  return importPromise;
 }
 async function handle(request,response,url,user) {
  let match;
  if(url.pathname==='/api/rig-pdf/status' && request.method==='GET') {
   let manifest; try { ({manifest}=await loadManifest()); } catch { manifest=null; }
   const rows=await jsonQuery(`SELECT di.dataset_id,COUNT(*) AS total,SUM(CASE WHEN r.reviewed_at IS NULL THEN 1 ELSE 0 END) AS pending FROM dbo.DatasetTrainingReview r JOIN dbo.DatasetItem di ON di.dataset_item_id=r.dataset_item_id WHERE di.is_excluded=0 GROUP BY di.dataset_id FOR JSON PATH;`)||[];
   sendJson(response,200,{...state,prepared:Boolean(manifest),documents:manifest?.documents||[],unique_images:manifest?.items.length||0,datasets:rows,ai_drafts:await draftFile('status.json')}); return true;
  }
  if(url.pathname==='/api/rig-pdf/import' && request.method==='POST') {
   admin(user); if(!importPromise) void importPrepared(user); sendJson(response,202,{...state});return true;
  }
  if((match=url.pathname.match(/^\/api\/dataset-items\/(\d+)\/training-review$/))) {
   allowed(user); const id=intValue(match[1],'Foto dataset');
   if(request.method==='GET') {
    const rowQuery = `SELECT di.*,d.name AS dataset_name,d.status AS dataset_status,ia.original_name,ia.checksum,ia.license_verified,ia.license_name,r.source_kind,r.source_group_key,r.source_metadata,r.curated_description,r.reviewed_at,r.work_area_id AS review_work_area_id,ia.work_area_id AS image_work_area_id FROM dbo.DatasetItem di JOIN dbo.Dataset d ON d.dataset_id=di.dataset_id JOIN dbo.ImageAsset ia ON ia.image_id=di.image_id LEFT JOIN dbo.DatasetTrainingReview r ON r.dataset_item_id=di.dataset_item_id WHERE di.dataset_item_id=${id} AND d.dataset_kind='HAZARD' FOR JSON PATH,WITHOUT_ARRAY_WRAPPER;`;
    // sqlcmd can wrap/pad textual columns. Transport UTF-16 JSON as short ASCII
    // hex lines, so embedded PDF text and long escaped strings stay intact.
    const sql = `DECLARE @json NVARCHAR(MAX)=(${rowQuery.replace(/;$/, '')});
DECLARE @bytes VARBINARY(MAX)=CONVERT(VARBINARY(MAX),@json),@pos INT=1;
DECLARE @chunks TABLE(sequence_id INT IDENTITY(1,1),payload VARCHAR(MAX));
WHILE @pos<=DATALENGTH(@bytes) BEGIN
 INSERT @chunks(payload) VALUES('K3JSONHEX:'+CONVERT(VARCHAR(2000),SUBSTRING(@bytes,@pos,1000),2));
 SET @pos+=1000;
END;
SELECT payload FROM @chunks ORDER BY sequence_id;`;
    const raw = await executeSql(sql,{database:databaseName});
    const hex = raw.split(/\r?\n/).filter(line=>/^K3JSONHEX:[0-9A-Fa-f]+$/.test(line.trim())).map(line=>line.trim().slice(10)).join('');
    let row=null;
    if(hex) { try { row=JSON.parse(Buffer.from(hex,'hex').toString('utf16le')); } catch { throw httpError(503,'Detail foto belum dapat dibaca. Muat ulang halaman dan coba kembali.','DATABASE_RESPONSE'); } }

    if(!row) { const exists=await jsonQuery(`SELECT dataset_item_id FROM dbo.DatasetItem WHERE dataset_item_id=${id} FOR JSON PATH,WITHOUT_ARRAY_WRAPPER;`); if(exists) throw httpError(503,'Foto masih tersimpan, tetapi detailnya belum dapat dibaca.','DATABASE_RESPONSE'); throw httpError(404,'Foto dataset tidak ditemukan.'); }
    const annotations=await jsonQuery(`SELECT hazard_type_id,bbox_x AS x,bbox_y AS y,bbox_width AS width,bbox_height AS height FROM dbo.Annotation WHERE dataset_item_id=${id} FOR JSON PATH;`)||[];
    const proposal = /^[a-f0-9]{64}$/.test(row.checksum || '') ? await draftFile(row.checksum+'.json') : null;
    const aiDraft = proposal?.image_checksum===row.checksum && proposal?.human_reviewed===false && labels.includes(proposal.overall_label) ? proposal : null;
    const areas=await jsonQuery("SELECT work_area_id,name FROM dbo.WorkArea WHERE is_active=1 AND scope_key='CRSSC-20261005' FOR JSON PATH;")||[];
    const pdfPrefill=await reviewDefaults(row,areas,aiDraft);
    sendJson(response,200,{ai_draft:aiDraft,pdf_prefill:pdfPrefill,analysis:{image_id:row.image_id,original_name:row.original_name},item:row,annotations,source:asJson(row.source_metadata),prediction:{summary:row.curated_description||''}});return true;
   }
   if(request.method==='POST') {
    const body=await bodyObject(request), label=body.overall_label, description=typeof body.description==='string' ? body.description.trim().slice(0,1200) : '';
    if(!labels.includes(label)||!description||body.license_confirmed!==true) throw httpError(400,'Periksa label, isi deskripsi, dan konfirmasi izin penggunaan foto.');
    const reviewArea=intValue(body.work_area_id,'Area foto');
    const activeArea=await jsonQuery(`SELECT work_area_id,area_type FROM dbo.WorkArea WHERE work_area_id=${reviewArea} AND is_active=1 AND scope_key='CRSSC-20261005' FOR JSON PATH,WITHOUT_ARRAY_WRAPPER;`);
    if(!activeArea) throw httpError(400,'Pilih area yang tersedia sesuai PDF atau Ruangan Kantor.');
    const boxes=parseDatasetAnnotations(JSON.stringify(body.annotations),label,intValue,httpError);
    const hazards=await jsonQuery(`SELECT hazard_type_id FROM dbo.HazardType WHERE is_active=1 AND area_type IN(${sqlAscii(activeArea.area_type)},'KEDUANYA') FOR JSON PATH;`)||[];
    if(boxes.some(box=>!hazards.some(h=>h.hazard_type_id===box.hazardId))) throw httpError(400,'Kategori anotasi tidak tersedia untuk area yang dipilih.');
    const result=await jsonQuery(`SET XACT_ABORT ON; BEGIN TRANSACTION;
DECLARE @dataset INT,@state VARCHAR(20),@image INT,@found BIT=0;
SELECT @dataset=dataset_id FROM dbo.DatasetItem WHERE dataset_item_id=${id};
SELECT @state=status FROM dbo.Dataset WITH(UPDLOCK,HOLDLOCK) WHERE dataset_id=@dataset AND dataset_kind='HAZARD';
SELECT @image=image_id,@found=1 FROM dbo.DatasetItem WITH(UPDLOCK,HOLDLOCK) WHERE dataset_item_id=${id};
IF EXISTS(SELECT 1 FROM dbo.DatasetItem WHERE dataset_item_id=${id} AND is_excluded=1) THROW 51000,'Pulihkan foto melalui Kurasi foto Protect sebelum memberi label.',1;
IF @found=1 AND @state='DRAFT' BEGIN
 UPDATE dbo.DatasetItem SET overall_label=${sqlAscii(label)},label_status='REVIEWED',labeled_by_user_id=${user.user_id},verified_by_user_id=NULL WHERE dataset_item_id=${id};
 DELETE FROM dbo.Annotation WHERE dataset_item_id=${id};
 ${boxes.map(b=>`INSERT dbo.Annotation(dataset_item_id,hazard_type_id,bbox_x,bbox_y,bbox_width,bbox_height) VALUES(${id},${b.hazardId},${b.x},${b.y},${b.width},${b.height});`).join('\n')}
 UPDATE dbo.ImageAsset SET license_verified=1,license_name=CASE WHEN license_verified=0 OR license_name IS NULL THEN N'Izin penggunaan internal dikonfirmasi pengguna' ELSE license_name END WHERE image_id=@image;
 UPDATE dbo.DatasetTrainingReview SET work_area_id=${reviewArea},reviewed_at=SYSUTCDATETIME(),reviewed_by_user_id=${user.user_id},curated_description=${sqlText(description)} WHERE dataset_item_id=${id};
 IF @@ROWCOUNT=0 INSERT dbo.DatasetTrainingReview(dataset_item_id,source_kind,source_group_key,source_metadata,curated_description,reviewed_at,reviewed_by_user_id,work_area_id) VALUES(${id},'INSPECTION','item:'+CONVERT(varchar(20),${id}),N'{}',${sqlText(description)},SYSUTCDATETIME(),${user.user_id},${reviewArea});
 INSERT dbo.AuditEvent(user_id,action_code,entity_type,entity_id,detail) VALUES(${user.user_id},'TRAINING_CANDIDATE_REVIEWED','DatasetItem',${sqlText(id)},${sqlText(label)});
END;
COMMIT TRANSACTION;SELECT @found AS found,@state AS dataset_status FOR JSON PATH,WITHOUT_ARRAY_WRAPPER;`);
    if(!result?.found) throw httpError(404,'Foto dataset tidak ditemukan.');
    if(result.dataset_status!=='DRAFT') throw httpError(409,'Label hanya dapat diperbarui pada dataset Draft.');
    sendJson(response,200,{dataset_item_id:id,label_status:'REVIEWED'});return true;
   }
  }
  if((match=url.pathname.match(/^\/api\/datasets\/(\d+)\/training-groups$/))) {
   const id=intValue(match[1],'Dataset');
   if(request.method==='GET') { const groups=await jsonQuery(`SELECT r.source_group_key,COUNT(*) AS total,MIN(di.split) AS split,MIN(COALESCE(JSON_VALUE(r.source_metadata,'$.occurrences[0].rig_name'),JSON_VALUE(r.source_metadata,'$.capture_group'),r.source_group_key)) AS rig_name FROM dbo.DatasetTrainingReview r JOIN dbo.DatasetItem di ON di.dataset_item_id=r.dataset_item_id WHERE di.dataset_id=${id} GROUP BY r.source_group_key FOR JSON PATH;`)||[];sendJson(response,200,{groups});return true; }
   if(request.method==='POST') {
    admin(user);const body=await bodyObject(request);
    if(!/^(?:(pdf|upload|image):[a-f0-9]{64}|camera:[a-f0-9-]{36}|item:[0-9]+)$/.test(body.group_key)||!splits.includes(body.split)) throw httpError(400,'Kelompok atau pembagian data tidak valid.');
    const result=await jsonQuery(`SET XACT_ABORT ON;BEGIN TRANSACTION;DECLARE @state VARCHAR(20),@changed INT=0;SELECT @state=status FROM dbo.Dataset WITH(UPDLOCK,HOLDLOCK) WHERE dataset_id=${id};IF @state='DRAFT' BEGIN UPDATE di SET split=${sqlAscii(body.split)} FROM dbo.DatasetItem di JOIN dbo.DatasetTrainingReview r ON r.dataset_item_id=di.dataset_item_id WHERE di.dataset_id=${id} AND r.source_group_key=${sqlAscii(body.group_key)};SET @changed=@@ROWCOUNT;INSERT dbo.AuditEvent(user_id,action_code,entity_type,entity_id,detail) VALUES(${user.user_id},'PDF_GROUP_SPLIT_CHANGED','Dataset',${sqlText(id)},${sqlText(body.group_key+'; '+body.split)});END;COMMIT TRANSACTION;SELECT @changed AS changed,@state AS dataset_status FOR JSON PATH,WITHOUT_ARRAY_WRAPPER;`);
    if(result?.dataset_status!=='DRAFT') throw httpError(409,'Pembagian hanya dapat diubah pada dataset Draft.');sendJson(response,200,result);return true;
   }
  }
  return false;
 }
 handle.importPrepared=importPrepared;
 handle.initialize=async()=>{const user=await jsonQuery("SELECT TOP(1) user_id,role FROM dbo.AppUser WHERE role='admin' AND is_active=1 ORDER BY user_id FOR JSON PATH,WITHOUT_ARRAY_WRAPPER;");if(user) return importPrepared(user);};
 return handle;
}
