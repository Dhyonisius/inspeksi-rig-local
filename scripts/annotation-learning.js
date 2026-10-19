import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createAnnotationProposer } from './annotation-proposals.js';
import { createRigReviewContext } from './rig-review-context.js';

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const parse = value => { try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; } };
const fail = (status, message, code = '') => Object.assign(new Error(message), { status, code });
export function boxOverlap(a, b) {
  const intersection = Math.max(0, Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x)) * Math.max(0, Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y));
  return Math.min(1,intersection / Math.max(1e-9, a.width*a.height + b.width*b.height - intersection));
}

export function combineProposals(vlm, detector, hazards, method = 'HYBRID') {
  const ids = new Set(hazards.map(h => h.hazard_type_id));
  const detected = (detector?.detections || []).filter(d => ids.has(d.hazard_type_id) && Number.isFinite(d.confidence) && d.confidence >= .6 && d.confidence <= 1
    && d.box && ['x','y','width','height'].every(key => Number.isFinite(d.box[key])) && d.box.x >= 0 && d.box.y >= 0
    && d.box.width > .008 && d.box.height > .008 && d.box.x+d.box.width <= 1.000001 && d.box.y+d.box.height <= 1.000001)
    .slice(0, 20).map(d => ({ hazard_type_id: d.hazard_type_id, ...d.box, confidence: d.confidence, source: 'YOLO' }));
  let result = vlm ? { ...vlm, annotations: vlm.annotations.map(box => ({ ...box, source: 'VLM' })) }
    : { overall_label: detected.length ? 'RISK' : 'UNCERTAIN', description: detected.length
      ? 'Model rig mengusulkan lokasi kategori bahaya yang pernah dilatih. Periksa kondisi dan kotaknya pada foto.'
      : 'Model rig belum menemukan kategori bahaya yang dilatih. Periksa foto secara manual; hasil ini tidak memastikan aman.', annotations: detected };
  let disagreement = false;
  if (vlm && detector?.available) {
    const matched = detected.filter(d => vlm.annotations.some(v => v.hazard_type_id === d.hazard_type_id && boxOverlap(v,d) >= .2));
    // Replace VLM geometry only where both models identify the same region/category.
    result.annotations = result.annotations.map(v => {
      const d = matched.filter(d => d.hazard_type_id === v.hazard_type_id).sort((a,b) => boxOverlap(v,b)-boxOverlap(v,a))[0];
      return d && boxOverlap(v,d) >= .2 ? { ...d, source: 'VLM_YOLO' } : v;
    });
    const supported=new Set(detector.trained_hazard_ids || hazards.map(h=>h.hazard_type_id));
    disagreement = detected.some(d => !matched.includes(d)) || (vlm.overall_label === 'RISK' && vlm.annotations.some(v => supported.has(v.hazard_type_id) && !detected.some(d => d.hazard_type_id === v.hazard_type_id && boxOverlap(v,d) >= .2)));
  }
  const reasons = [];
  if(vlm?.review_notes?.length) reasons.push(...vlm.review_notes);
  if (disagreement) reasons.push('Gemma dan model rig berbeda');
  if (result.overall_label === 'UNCERTAIN') reasons.push('AI belum yakin');
  if (result.annotations.some(box => box.confidence < .8)) reasons.push('Kotak perlu diperiksa teliti');
  if (method === 'PSEUDO') reasons.push('Usulan dari model rig');
  if (!reasons.length) reasons.push('Usulan siap ditinjau');
  return { ...result, method: detector?.available ? method : 'VLM', model: vlm?.model || detector?.model_name,
    detector_model: detector?.available ? detector.model_name : null, detector_job_id: detector?.available ? detector.job_id || null : null, disagreement, priority_reasons: reasons,
    priority: disagreement || vlm?.review_flags?.includes('LABEL_BOX_CONFLICT') ? 95 : result.overall_label === 'UNCERTAIN' ? 85 : method === 'PSEUDO' ? 70 : vlm?.review_flags?.length ? 75 : result.annotations.some(b => b.confidence < .8) ? 65 : result.overall_label === 'RISK' ? 55 : 25,
    detector_note: detector?.note || null, human_reviewed: false };
}

export function createAnnotationLearning(ctx) {
  const { jsonQuery, sqlText, sqlAscii, withDatasetReadLock, withInferenceLock, uploadDir } = ctx;
  const propose = ctx.proposeAnnotation || createAnnotationProposer({ listModels: ctx.listOllamaVisionModels, prepareImage: ctx.prepareInferenceImage });
  const reviewDefaults=createRigReviewContext({privateDir:ctx.privateDir});
  async function prepareAreas() {
    const rows=await jsonQuery(`SELECT di.dataset_item_id,ia.checksum,r.source_kind,r.reviewed_at,r.curated_description FROM dbo.DatasetItem di JOIN dbo.Dataset d ON d.dataset_id=di.dataset_id JOIN dbo.ImageAsset ia ON ia.image_id=di.image_id JOIN dbo.DatasetTrainingReview r ON r.dataset_item_id=di.dataset_item_id WHERE d.status='DRAFT' AND d.dataset_kind='HAZARD' AND di.label_status='DRAFT' AND di.is_excluded=0 AND r.work_area_id IS NULL AND r.reviewed_at IS NULL AND r.source_kind='PDF' FOR JSON PATH;`)||[];
    if(!rows.length)return;
    const areas=await jsonQuery("SELECT work_area_id,name FROM dbo.WorkArea WHERE is_active=1 AND scope_key='CRSSC-20261005' FOR JSON PATH;")||[];
    const updates=[];
    for(const row of rows) {
      const context=await reviewDefaults(row,areas,null);
      if(Number.isSafeInteger(context?.work_area_id))updates.push(`UPDATE r SET work_area_id=${context.work_area_id} FROM dbo.DatasetTrainingReview r JOIN dbo.DatasetItem di ON di.dataset_item_id=r.dataset_item_id JOIN dbo.Dataset d ON d.dataset_id=di.dataset_id WHERE r.dataset_item_id=${Number(row.dataset_item_id)} AND r.work_area_id IS NULL AND r.reviewed_at IS NULL AND di.label_status='DRAFT' AND di.is_excluded=0 AND d.status='DRAFT';`);
    }
    // Only unambiguous document metadata fills an empty area; labels are untouched.
    if(updates.length)await jsonQuery('SET XACT_ABORT ON;BEGIN TRANSACTION;'+updates.join('\n')+'COMMIT TRANSACTION;SELECT 1 AS completed FOR JSON PATH,WITHOUT_ARRAY_WRAPPER;');
  }
  async function getProposal(id, row) {
    const record = await jsonQuery(`SELECT proposal_json,image_checksum,work_area_id FROM dbo.DatasetAiProposal WHERE dataset_item_id=${Number(id)} FOR JSON PATH,WITHOUT_ARRAY_WRAPPER;`);
    if (!record || record.image_checksum !== row.checksum) return null;
    const area = row.review_work_area_id || row.image_work_area_id;
    if (area && area !== record.work_area_id) return null;
    const value = parse(record.proposal_json);
    return value?.human_reviewed === false ? value : null;
  }
  async function suggest(id, user, body = {}, options = {}) {
    const itemId = ctx.intValue(id, 'Foto dataset');
    if (!['admin','operator'].includes(user?.role)) throw fail(403, 'Akun tidak dapat membuat usulan AI.');
    const method = String(body.method || 'HYBRID').toUpperCase();
    if (!['VLM','HYBRID','PSEUDO'].includes(method)) throw fail(400, 'Pilih metode usulan yang tersedia.');
    const row = await jsonQuery(`SELECT di.dataset_item_id,di.dataset_id,di.label_status,di.is_excluded,di.split,d.status AS dataset_status,ia.file_uri,ia.checksum,
      COALESCE(r.work_area_id,ia.work_area_id) AS work_area_id,r.reviewed_at
      FROM dbo.DatasetItem di JOIN dbo.Dataset d ON d.dataset_id=di.dataset_id JOIN dbo.ImageAsset ia ON ia.image_id=di.image_id LEFT JOIN dbo.DatasetTrainingReview r ON r.dataset_item_id=di.dataset_item_id
      WHERE di.dataset_item_id=${itemId} AND d.dataset_kind='HAZARD' FOR JSON PATH,WITHOUT_ARRAY_WRAPPER;`);
    if (!row || row.is_excluded) throw fail(404,'Foto calon pelatihan tidak ditemukan.');
    if (row.dataset_status !== 'DRAFT' || row.label_status !== 'DRAFT' || row.reviewed_at) throw fail(409,'Usulan AI hanya untuk foto yang belum ditinjau pada dataset Draft.');
    const areaId = ctx.intValue(body.work_area_id || row.work_area_id, 'Area foto');
    const area = await jsonQuery(`SELECT work_area_id,name,area_type FROM dbo.WorkArea WHERE work_area_id=${areaId} AND is_active=1 AND scope_key='CRSSC-20261005' FOR JSON PATH,WITHOUT_ARRAY_WRAPPER;`);
    if (!area) throw fail(400,'Pilih area foto yang tersedia sebelum membuat usulan AI.');
    const hazards = await jsonQuery(`SELECT hazard_type_id,code,name,area_type,description FROM dbo.HazardType WHERE is_active=1 AND area_type IN(${sqlAscii(area.area_type)},'KEDUANYA') FOR JSON PATH;`) || [];
    const run = async () => {
      options.signal?.throwIfAborted();
      if (!/^uploads\/[a-f0-9-]+\.(jpg|png|webp)$/.test(row.file_uri || '') || !/^[a-f0-9]{64}$/.test(row.checksum || '')) throw fail(409,'Lokasi foto tidak sesuai untuk usulan AI.');
      const file = path.join(uploadDir,path.basename(row.file_uri));
      const [root,real,info] = await Promise.all([fs.realpath(uploadDir),fs.realpath(file),fs.lstat(file)]);
      if (!real.startsWith(root+path.sep) || info.isSymbolicLink() || !info.isFile() || !info.size || info.size > 8*1024*1024) throw fail(409,'Foto sumber belum dapat dibaca.');
      const binary = await fs.readFile(file);
      if (digest(binary) !== row.checksum) throw fail(409,'Foto sumber berubah. Muat ulang foto sebelum membuat usulan.');
      let detector = null;
      if (method !== 'VLM' && ctx.detectRig) {
        try { detector = await ctx.detectRig(binary, hazards, { signal: options.signal }); }
        catch (error) { options.signal?.throwIfAborted(); detector = { available: false, note: 'Model rig belum dapat dipakai. Usulan menggunakan Gemma.' }; }
      }
      if (method === 'PSEUDO' && !detector?.available) throw fail(409,'Model rig terlatih belum dipilih. Gunakan usulan Gemma sambil menyiapkan model rig.');
      const vlm = method === 'PSEUDO' ? null : await propose(binary,area,hazards,{signal:options.signal});
      options.signal?.throwIfAborted();
      const proposal = { ...combineProposals(vlm,detector,hazards,method), work_area_id: areaId, image_checksum: row.checksum,
        created_at: new Date().toISOString(), prompt_version: vlm?.prompt_version || 'rig-pseudo-1' };
      if(proposal.annotations.length) {
        const frequencies=await jsonQuery(`SELECT an.hazard_type_id,COUNT(*) AS total FROM dbo.Annotation an JOIN dbo.DatasetItem di ON di.dataset_item_id=an.dataset_item_id WHERE di.dataset_id=${row.dataset_id} AND di.label_status='VERIFIED' AND di.split='TRAIN' AND di.is_excluded=0 GROUP BY an.hazard_type_id FOR JSON PATH;`)||[];
        if(proposal.annotations.some(box=>(frequencies.find(f=>f.hazard_type_id===box.hazard_type_id)?.total||0)<20)) {
          proposal.priority=Math.min(100,proposal.priority+10);proposal.priority_reasons.push('Kategori masih sedikit contoh');
        }
      }
      // Check the current human-review state under SQL locks AFTER inference.
      // A concurrent review, exclusion or dataset approval must win over AI work.
      const saved = await jsonQuery(`SET XACT_ABORT ON;BEGIN TRANSACTION;DECLARE @saved BIT=0,@dataset INT,@state VARCHAR(20);
        SELECT @dataset=dataset_id FROM dbo.DatasetItem WHERE dataset_item_id=${itemId};
        SELECT @state=status FROM dbo.Dataset WITH(UPDLOCK,HOLDLOCK) WHERE dataset_id=@dataset;
        IF @state='DRAFT' AND EXISTS(SELECT 1 FROM dbo.DatasetItem di WITH(UPDLOCK,HOLDLOCK) JOIN dbo.ImageAsset ia ON ia.image_id=di.image_id
          LEFT JOIN dbo.DatasetTrainingReview r ON r.dataset_item_id=di.dataset_item_id WHERE di.dataset_item_id=${itemId} AND di.label_status='DRAFT' AND di.is_excluded=0 AND r.reviewed_at IS NULL AND ia.checksum=${sqlAscii(row.checksum)})
        BEGIN
          UPDATE dbo.DatasetAiProposal SET work_area_id=${areaId},image_checksum=${sqlAscii(row.checksum)},proposal_json=${sqlText(JSON.stringify(proposal))},method=${sqlAscii(proposal.method)},priority=${proposal.priority},created_by_user_id=${user.user_id},created_at=SYSUTCDATETIME() WHERE dataset_item_id=${itemId};
          IF @@ROWCOUNT=0 INSERT dbo.DatasetAiProposal(dataset_item_id,work_area_id,image_checksum,proposal_json,method,priority,created_by_user_id)
            VALUES(${itemId},${areaId},${sqlAscii(row.checksum)},${sqlText(JSON.stringify(proposal))},${sqlAscii(proposal.method)},${proposal.priority},${user.user_id});
          SET @saved=1;
          INSERT dbo.AuditEvent(user_id,action_code,entity_type,entity_id,detail) VALUES(${user.user_id},'AI_PROPOSAL_CREATED','DatasetItem',CONVERT(nvarchar(80),${itemId}),${sqlText(proposal.method+'; '+proposal.model)});
        END;COMMIT TRANSACTION;SELECT @saved AS saved FOR JSON PATH,WITHOUT_ARRAY_WRAPPER;`);
      if (!saved?.saved) throw fail(409,'Foto atau status tinjauan berubah selama AI bekerja. Label manusia tetap dipertahankan.');
      return proposal;
    };
    return withDatasetReadLock(row.dataset_id, () => options.lockHeld ? run() : withInferenceLock(user.user_id,run));
  }
  return { suggest, getProposal, prepareAreas };
}
