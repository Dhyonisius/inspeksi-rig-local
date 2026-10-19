import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const digest = value => crypto.createHash('sha256').update(value).digest('hex');

export function createLearningApi(ctx) {
  const { jsonQuery,sqlText,sqlAscii,intValue,httpError,sendJson,sanitizePhotoBinary,
    uploadDir,withDatasetReadLock,fetchInspectionConfig }=ctx;
  const permitted=user=>{if(!['admin','operator'].includes(user.role)) throw httpError(403,'Akun tidak dapat menambahkan foto pembelajaran.');};
  const joins=`FROM dbo.DatasetItem di JOIN dbo.Dataset d ON d.dataset_id=di.dataset_id
    JOIN dbo.ImageAsset ia ON ia.image_id=di.image_id
    LEFT JOIN dbo.DatasetTrainingReview r ON r.dataset_item_id=di.dataset_item_id
    LEFT JOIN dbo.DatasetAiProposal ai ON ai.dataset_item_id=di.dataset_item_id AND ai.image_checksum=ia.checksum
      AND ai.work_area_id=COALESCE(r.work_area_id,ia.work_area_id,ai.work_area_id)
    LEFT JOIN dbo.WorkArea wa ON wa.work_area_id=COALESCE(r.work_area_id,ia.work_area_id,ai.work_area_id)`;
  const scope=`d.dataset_kind='HAZARD' AND d.status<>'ARCHIVED' AND di.is_excluded=0`;
  return async function handle(request,response,url,user) {
    if(url.pathname==='/api/learning' && request.method==='GET') {
      const offset=intValue(url.searchParams.get('offset')||0,'Halaman',0,10000000);
      const status=url.searchParams.get('status')||'pending';
      const filters={pending:"di.label_status='DRAFT'",reviewed:"di.label_status='REVIEWED'",verified:"di.label_status='VERIFIED'"};
      if(!filters[status]) throw httpError(400,'Antrean tidak dikenal.');
      const search=String(url.searchParams.get('q')||'').trim().slice(0,120);
      const areaId=url.searchParams.get('area')?intValue(url.searchParams.get('area'),'Area'):null;
      const filter=filters[status]+(search?` AND (CHARINDEX(${sqlText(search)},ia.original_name)>0 OR CHARINDEX(${sqlText(search)},d.name)>0)`:'')+(areaId?` AND wa.work_area_id=${areaId}`:'');
      const sort=url.searchParams.get('sort')||'priority';
      if(!['priority','newest'].includes(sort))throw httpError(400,'Urutan antrean tidak tersedia.');
      const priority=`COALESCE(ai.priority,40)+CASE WHEN NOT EXISTS(SELECT 1 FROM dbo.DatasetItem known JOIN dbo.ImageAsset ki ON ki.image_id=known.image_id LEFT JOIN dbo.DatasetTrainingReview kr ON kr.dataset_item_id=known.dataset_item_id WHERE known.label_status='VERIFIED' AND known.is_excluded=0 AND known.split='TRAIN' AND COALESCE(kr.work_area_id,ki.work_area_id)=wa.work_area_id) THEN 10 ELSE 0 END`;
      const ordering=sort==='newest'?'di.dataset_item_id DESC':`${priority} DESC,ROW_NUMBER() OVER(PARTITION BY COALESCE(r.source_group_key,'item:'+CONVERT(varchar(20),di.dataset_item_id)) ORDER BY di.dataset_item_id),di.dataset_item_id`;
      const stats=await jsonQuery(`SELECT COUNT(*) AS total,
        COALESCE(SUM(CASE WHEN di.label_status='DRAFT' THEN 1 ELSE 0 END),0) AS pending,
        COALESCE(SUM(CASE WHEN di.label_status='REVIEWED' THEN 1 ELSE 0 END),0) AS reviewed,
        COALESCE(SUM(CASE WHEN di.label_status='VERIFIED' THEN 1 ELSE 0 END),0) AS verified,
        COALESCE(SUM(CASE WHEN di.label_status='VERIFIED' AND di.split='TRAIN' AND ia.license_verified=1
          AND wa.is_active=1 AND di.overall_label<>'UNCERTAIN' AND COALESCE(r.curated_description,'')<>'' THEN 1 ELSE 0 END),0) AS example_count
        ${joins} WHERE ${scope} FOR JSON PATH,WITHOUT_ARRAY_WRAPPER;`);
      const count=await jsonQuery(`SELECT COUNT(*) AS total ${joins} WHERE ${scope} AND ${filter} FOR JSON PATH,WITHOUT_ARRAY_WRAPPER;`);
      const items=await jsonQuery(`SELECT di.dataset_item_id,di.dataset_id,di.image_id,di.label_status,di.overall_label,di.split,
        d.name AS dataset_name,d.status AS dataset_status,ia.original_name,wa.name AS area_name,wa.work_area_id,
        ai.method AS proposal_method,JSON_VALUE(ai.proposal_json,'$.overall_label') AS proposal_label,
        JSON_QUERY(ai.proposal_json,'$.priority_reasons') AS priority_reasons,${priority} AS review_priority,
        CAST(CASE WHEN ai.dataset_item_id IS NULL THEN 0 ELSE 1 END AS BIT) AS has_proposal,
        CAST(CASE WHEN r.reviewed_at IS NULL THEN 1 ELSE 0 END AS BIT) AS needs_review
        ${joins} WHERE ${scope} AND ${filter} ORDER BY ${ordering}
        OFFSET ${offset} ROWS FETCH NEXT 24 ROWS ONLY FOR JSON PATH;`)||[];
      const datasets=await jsonQuery(`SELECT d.dataset_id,d.name,d.version,d.status,COUNT(di.dataset_item_id) AS total,
        COALESCE(SUM(CASE WHEN di.label_status='VERIFIED' AND ia.license_verified=1 THEN 1 ELSE 0 END),0) AS verified,
        COALESCE(SUM(CASE WHEN di.label_status='VERIFIED' AND di.overall_label<>'UNCERTAIN' AND di.split='TRAIN' THEN 1 ELSE 0 END),0) AS train_count,
        COALESCE(SUM(CASE WHEN di.label_status='VERIFIED' AND di.overall_label<>'UNCERTAIN' AND di.split='VALIDATION' THEN 1 ELSE 0 END),0) AS validation_count,
        COALESCE(SUM(CASE WHEN di.label_status='VERIFIED' AND di.overall_label<>'UNCERTAIN' AND di.split='TEST' THEN 1 ELSE 0 END),0) AS test_count
        FROM dbo.Dataset d LEFT JOIN dbo.DatasetItem di ON di.dataset_id=d.dataset_id AND di.is_excluded=0 LEFT JOIN dbo.ImageAsset ia ON ia.image_id=di.image_id
        WHERE d.dataset_kind='HAZARD' AND d.status<>'ARCHIVED' GROUP BY d.dataset_id,d.name,d.version,d.status ORDER BY d.dataset_id DESC FOR JSON PATH;`)||[];
      sendJson(response,200,{stats,items,total:count?.total||0,offset,status,datasets,
        rig_model:ctx.rigModelStatus?.()||{available:false},learning_method:'VERIFIED_VISUAL_EXAMPLES',weights_trained:false}); return true;
    }
    if(url.pathname==='/api/learning/photos' && request.method==='POST') {
      permitted(user);
      const form=await request.formData();
      if(form.get('permission')!=='on') throw httpError(400,'Konfirmasi izin foto diperlukan.');
      const datasetId=intValue(form.get('dataset_id'),'Dataset');
      const areaId=intValue(form.get('work_area_id'),'Area');
      const group=String(form.get('capture_group')||'').trim().slice(0,160);
      if(!group) throw httpError(400,'Isi kelompok pengambilan, misalnya rig dan tanggal kejadian.');
      const {area}=await fetchInspectionConfig(areaId);
      if(!area) throw httpError(400,'Area tidak tersedia.');
      const file=form.get('image'),photo=await sanitizePhotoBinary(file),checksum=digest(photo.buffer);
      const filename=crypto.randomUUID()+'.'+photo.extension,location=path.join(uploadDir,filename);
      await fs.writeFile(location,photo.buffer,{flag:'wx'});
      // Keep the file on unknown commits. Only confirmed duplicates remove the candidate.
      const result=await withDatasetReadLock(datasetId,()=>jsonQuery(`SET XACT_ABORT ON;BEGIN TRANSACTION;
        DECLARE @state VARCHAR(20),@image INT,@item INT,@new BIT=0,@kind VARCHAR(20),@labelStatus VARCHAR(20);
        SELECT @state=status,@kind=dataset_kind FROM dbo.Dataset WITH(UPDLOCK,HOLDLOCK) WHERE dataset_id=${datasetId};
        IF @state='DRAFT' AND @kind='HAZARD' BEGIN
          SELECT @image=image_id FROM dbo.ImageAsset WITH(UPDLOCK,HOLDLOCK) WHERE checksum=${sqlAscii(checksum)};
          IF @image IS NULL BEGIN
            INSERT dbo.ImageAsset(work_area_id,uploaded_by_user_id,file_uri,original_name,mime_type,file_size_bytes,origin_type,license_name,license_verified,checksum)
            VALUES(${areaId},${user.user_id},${sqlText('uploads/'+filename)},${sqlText(String(file.name||'foto-baru').replace(/[\x00-\x1f]/g,'').slice(0,240))},${sqlAscii(photo.mime)},${photo.buffer.length},'DATASET',N'Izin penggunaan internal dikonfirmasi pengguna',1,${sqlAscii(checksum)});
            SET @image=SCOPE_IDENTITY();SET @new=1;
          END;
          SELECT @item=dataset_item_id FROM dbo.DatasetItem WHERE dataset_id=${datasetId} AND image_id=@image;
          IF @item IS NULL BEGIN
            INSERT dbo.DatasetItem(dataset_id,image_id,split,overall_label,label_status,labeled_by_user_id)
              VALUES(${datasetId},@image,'TRAIN','UNCERTAIN','DRAFT',${user.user_id});SET @item=SCOPE_IDENTITY();
            INSERT dbo.DatasetTrainingReview(dataset_item_id,source_kind,source_group_key,source_metadata,work_area_id)
              VALUES(@item,'INSPECTION',${sqlAscii('upload:'+digest(group.toLowerCase()))},${sqlText(JSON.stringify({kind:'UPLOAD',capture_group:group}))},${areaId});
            INSERT dbo.AuditEvent(user_id,action_code,entity_type,entity_id,detail)
              VALUES(${user.user_id},'LEARNING_PHOTO_ADDED','DatasetItem',CONVERT(nvarchar(80),@item),N'Foto baru, menunggu label manusia');
          END;
        END;
        COMMIT TRANSACTION;SELECT @item AS dataset_item_id,@new AS new_image,@state AS dataset_status,(SELECT label_status FROM dbo.DatasetItem WHERE dataset_item_id=@item) AS label_status FOR JSON PATH,WITHOUT_ARRAY_WRAPPER;`));
      if(result?.new_image===false) await fs.unlink(location).catch(()=>{});
      if(!result?.dataset_item_id) throw httpError(409,'Pilih dataset bahaya yang masih Draft.');
      sendJson(response,201,{dataset_item_id:result.dataset_item_id,label_status:result.label_status});return true;
    }
    return false;
  };
}
