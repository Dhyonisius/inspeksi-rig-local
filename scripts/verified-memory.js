import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const digest = value => crypto.createHash('sha256').update(value).digest('hex');

// Only human-verified TRAIN photos of the selected area may become examples.
// Validation/test images and the inspected image itself are never references.
export function createVerifiedMemory({ jsonQuery, uploadDir, prepareImage }) {
  return async function examples(area, imageBuffer, options = {}) {
    if (!Number.isSafeInteger(area.work_area_id) || options.useExamples === false) return [];
    const checksum = digest(imageBuffer);
    const candidates = await jsonQuery(`SELECT TOP(12) di.dataset_item_id,di.image_id,di.overall_label,
      ia.checksum,ia.file_uri,COALESCE(r.curated_description,p.curated_description) AS description,
      JSON_QUERY((SELECT h.code,an.bbox_x AS x,an.bbox_y AS y,an.bbox_width AS width,an.bbox_height AS height
        FROM dbo.Annotation an JOIN dbo.HazardType h ON h.hazard_type_id=an.hazard_type_id
        WHERE an.dataset_item_id=di.dataset_item_id FOR JSON PATH)) AS annotations
      FROM dbo.DatasetItem di JOIN dbo.Dataset d ON d.dataset_id=di.dataset_id
      JOIN dbo.ImageAsset ia ON ia.image_id=di.image_id
      LEFT JOIN dbo.DatasetTrainingReview r ON r.dataset_item_id=di.dataset_item_id
      LEFT JOIN dbo.DatasetItemProvenance p ON p.dataset_item_id=di.dataset_item_id
      WHERE d.dataset_kind='HAZARD' AND d.status<>'ARCHIVED' AND di.label_status='VERIFIED' AND di.is_excluded=0
      AND di.verified_by_user_id IS NOT NULL AND di.split='TRAIN' AND ia.license_verified=1
      AND di.overall_label IN('RISK','NO_LISTED_HAZARD_VISIBLE')
      AND COALESCE(r.work_area_id,ia.work_area_id)=${area.work_area_id}
      AND ia.checksum<>'${checksum}' AND COALESCE(r.curated_description,p.curated_description) IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM dbo.DatasetItem heldout WHERE heldout.image_id=ia.image_id AND heldout.split<>'TRAIN')
      ORDER BY di.dataset_item_id DESC FOR JSON PATH;`) || [];
    const selected=[], seen=new Set();
    // Prefer one risk and one normal example; cap input size for local hardware.
    const ordered=[...candidates.filter(c=>c.overall_label==='RISK'),...candidates.filter(c=>c.overall_label==='NO_LISTED_HAZARD_VISIBLE')];
    for (const candidate of ordered) {
      if (selected.length===2) break;
      if (seen.has(candidate.overall_label) || !/^uploads\/[a-f0-9-]+\.(jpg|png|webp)$/.test(candidate.file_uri)) continue;
      options.signal?.throwIfAborted();
      try {
        const file=path.join(uploadDir,path.basename(candidate.file_uri));
        const [realRoot,realFile,info]=await Promise.all([fs.realpath(uploadDir),fs.realpath(file),fs.lstat(file)]);
        if (!realFile.startsWith(realRoot+path.sep) || info.isSymbolicLink() || !info.isFile() || info.size>8*1024*1024) continue;
        const buffer=await fs.readFile(file);
        if (digest(buffer)!==candidate.checksum) continue;
        const prepared=await prepareImage(buffer,{profile:'hemat',signal:options.signal});
        let annotations=candidate.annotations||[];
        if (typeof annotations==='string') annotations=JSON.parse(annotations);
        if (candidate.overall_label==='RISK' && !annotations.length) continue;
        selected.push({ dataset_item_id:candidate.dataset_item_id,image_id:candidate.image_id,checksum:candidate.checksum,
          label:candidate.overall_label,description:String(candidate.description).slice(0,600),
          annotations:annotations.slice(0,8),buffer:prepared.buffer });
        seen.add(candidate.overall_label);
      } catch (error) { if (options.signal?.aborted) throw error; /* A missing reference must not invent an example. */ }
    }
    return selected;
  };
}
