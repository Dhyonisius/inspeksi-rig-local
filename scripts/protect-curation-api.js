import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { cleanupDatasetOrphans } from './dataset-delete.js';

export function createProtectCurationApi(ctx) {
  const { root, privateDir, uploadDir, jsonQuery, jsonBody, intValue, sqlText, sqlAscii,
    httpError, sendJson, withDatasetMutationLock } = ctx;
  const joins = `FROM dbo.DatasetItem di JOIN dbo.ImageAsset ia ON ia.image_id=di.image_id
    JOIN dbo.DatasetTrainingReview r ON r.dataset_item_id=di.dataset_item_id AND r.source_kind='PDF'`;
  const idList = body => {
    if (!Array.isArray(body?.item_ids) || !body.item_ids.length || body.item_ids.length > 100) throw httpError(400, 'Pilih 1–100 foto untuk satu tindakan.');
    const ids = body.item_ids.map(id => intValue(id, 'Foto', 1));
    if (new Set(ids).size !== ids.length) throw httpError(400, 'Daftar foto memuat pilihan ganda.');
    return ids;
  };
  const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const fingerprint = rows => hash(rows.map(row => [row.dataset_item_id, row.image_id, row.checksum, row.is_excluded, row.dataset_references, row.analysis_references, row.evaluation_referenced]));
  function allowed(user, permanent = false) {
    if (!['admin', 'operator'].includes(user.role) || permanent && user.role !== 'admin') throw httpError(403, permanent ? 'Penghapusan permanen hanya tersedia untuk admin.' : 'Kurasi tersedia untuk pengguna dan admin.');
  }
  async function dataset(id) {
    const row = await jsonQuery(`SELECT d.dataset_id,d.name,d.version,d.status FROM dbo.Dataset d WHERE d.dataset_id=${id} AND d.dataset_kind='HAZARD' AND (EXISTS(SELECT 1 FROM dbo.RigPdfImport i WHERE i.dataset_id=d.dataset_id) OR EXISTS(SELECT 1 FROM dbo.DatasetTrainingReview r JOIN dbo.DatasetItem di ON di.dataset_item_id=r.dataset_item_id WHERE di.dataset_id=d.dataset_id AND r.source_kind='PDF')) FOR JSON PATH,WITHOUT_ARRAY_WRAPPER;`);
    if (!row) throw httpError(404, 'Dataset foto Protect tidak ditemukan.');
    return row;
  }
  const selectedRows = (id, ids) => jsonQuery(`SELECT di.dataset_item_id,di.image_id,di.is_excluded,ia.checksum,ia.original_name,
    (SELECT COUNT(*) FROM dbo.DatasetItem other WHERE other.image_id=ia.image_id AND other.dataset_item_id NOT IN(${ids.join(',')})) AS dataset_references,
    (SELECT COUNT(*) FROM dbo.Analysis a WHERE a.image_id=ia.image_id) AS analysis_references,
    CAST(CASE WHEN EXISTS(SELECT 1 FROM dbo.EvaluationItem ei WHERE ei.image_id=ia.image_id) OR EXISTS(SELECT 1 FROM dbo.EvaluationRun er CROSS APPLY OPENJSON(CASE WHEN ISJSON(er.dataset_snapshot)=1 THEN er.dataset_snapshot ELSE N'{}' END,'$.items') WITH(image_id INT '$.image_id') snap WHERE snap.image_id=ia.image_id) THEN 1 ELSE 0 END AS BIT) AS evaluation_referenced
    ${joins} WHERE di.dataset_id=${id} AND di.dataset_item_id IN(${ids.join(',')}) ORDER BY di.dataset_item_id FOR JSON PATH;`);
  const mutableSql = id => `DECLARE @state VARCHAR(20); SELECT @state=status FROM dbo.Dataset WITH(XLOCK,HOLDLOCK) WHERE dataset_id=${id} AND dataset_kind='HAZARD';
    IF @state IS NULL THROW 51000,'Dataset tidak ditemukan.',1;
    IF @state<>'DRAFT' THROW 51000,'Kurasi hanya dapat diubah pada dataset Draft. Data yang disetujui dibekukan.',1;
    IF EXISTS(SELECT 1 FROM dbo.RigPdfImport WITH(HOLDLOCK) WHERE dataset_id=${id} AND completed_at IS NULL) THROW 51000,'Tunggu impor PDF selesai sebelum kurasi.',1;
    IF EXISTS(SELECT 1 FROM dbo.ModelTrainingDataset WITH(HOLDLOCK) WHERE dataset_id=${id}) THROW 51000,'Dataset masih terhubung ke model.',1;
    IF EXISTS(SELECT 1 FROM dbo.EvaluationRun WITH(HOLDLOCK) WHERE dataset_id=${id} AND status IN('QUEUED','RUNNING','CANCELLING')) THROW 51000,'Tunggu evaluasi dataset berhenti.',1;`;
  async function cleanupPrepared(rows) {
    let deleted = 0, pending = 0;
    for (const row of rows) {
      try {
        if (!/^[a-f0-9]{64}$/.test(row.checksum || '')) throw Error('Checksum tidak valid.');
        const directory = path.join(privateDir, 'rig-pdf', 'prepared', 'images');
        const file = path.join(directory, row.checksum + '.jpg');
        const realRoot = await fs.realpath(root), realDirectory = await fs.realpath(directory);
        const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
        if (!same(realDirectory, path.join(realRoot, 'data', 'private', 'rig-pdf', 'prepared', 'images'))) throw Error('Lokasi cache berubah.');
        const info = await fs.lstat(file), realFile = await fs.realpath(file);
        if (!info.isFile() || info.isSymbolicLink() || !same(path.dirname(realFile), realDirectory) || info.size > 8 * 1024 * 1024) throw Error('Berkas cache tidak valid.');
        const binary = await fs.readFile(file);
        if (crypto.createHash('sha256').update(binary).digest('hex') !== row.checksum) throw Error('Checksum cache berubah.');
        await fs.unlink(file); deleted++;
      } catch (error) { if (error.code === 'ENOENT') deleted++; else pending++; }
    }
    return { prepared_files_deleted: deleted, prepared_files_pending: pending };
  }
  return async function handle(request, response, url, user) {
    if (!url.pathname.startsWith('/api/protect-curation')) return false;
    allowed(user);
    if (request.method === 'GET' && url.pathname === '/api/protect-curation') {
      const datasets = await jsonQuery(`SELECT d.dataset_id,d.name,d.version,d.status FROM dbo.Dataset d WHERE d.dataset_kind='HAZARD' AND (EXISTS(SELECT 1 FROM dbo.RigPdfImport i WHERE i.dataset_id=d.dataset_id) OR EXISTS(SELECT 1 FROM dbo.DatasetTrainingReview r JOIN dbo.DatasetItem di ON di.dataset_item_id=r.dataset_item_id WHERE di.dataset_id=d.dataset_id AND r.source_kind='PDF')) ORDER BY d.dataset_id DESC FOR JSON PATH;`) || [];
      sendJson(response, 200, { datasets }); return true;
    }
    const match = url.pathname.match(/^\/api\/protect-curation\/(\d+)(?:\/(selection|delete-preview))?$/);
    if (!match) throw httpError(404, 'Fitur kurasi tidak ditemukan.');
    const id = intValue(match[1], 'Dataset', 1), info = await dataset(id);
    if (request.method === 'GET' && !match[2]) {
      const state = url.searchParams.get('state') || 'included';
      if (!['included', 'excluded', 'all'].includes(state)) throw httpError(400, 'Status foto tidak valid.');
      const conditions = [`di.dataset_id=${id}`];
      if (state !== 'all') conditions.push(`di.is_excluded=${state === 'excluded' ? 1 : 0}`);
      const rig = (url.searchParams.get('rig') || '').slice(0, 120), pdf = (url.searchParams.get('pdf') || '').slice(0, 255);
      const page = url.searchParams.get('page') ? intValue(url.searchParams.get('page'), 'Halaman PDF', 1, 10000) : null;
      if (rig || pdf || page) conditions.push(`EXISTS(SELECT 1 FROM OPENJSON(r.source_metadata,'$.occurrences') WITH(rig_name NVARCHAR(120),pdf_name NVARCHAR(255),page INT) o WHERE ${[rig && `o.rig_name=${sqlText(rig)}`, pdf && `o.pdf_name=${sqlText(pdf)}`, page && `o.page=${page}`].filter(Boolean).join(' AND ')})`);
      const q = (url.searchParams.get('q') || '').trim().slice(0, 120);
      if (q) conditions.push(`ia.original_name LIKE ${sqlText('%' + q.replace(/[\[\]%_]/g, c => '[' + c + ']') + '%')}`);
      const where = conditions.join(' AND '), count = await jsonQuery(`SELECT COUNT(*) AS total ${joins} WHERE ${where} FOR JSON PATH,WITHOUT_ARRAY_WRAPPER;`);
      const total = Number(count?.total || 0), requested = intValue(url.searchParams.get('offset') || 0, 'Halaman galeri', 0, 10000000);
      const offset = Math.min(requested, total ? Math.floor((total - 1) / 24) * 24 : 0);
      const items = await jsonQuery(`SELECT di.dataset_item_id,di.image_id,di.split,di.label_status,di.is_excluded,di.exclusion_reason,ia.original_name,
        JSON_QUERY((SELECT o.rig_name,o.pdf_name,o.page FROM OPENJSON(r.source_metadata,'$.occurrences') WITH(rig_name NVARCHAR(120),pdf_name NVARCHAR(255),page INT) o FOR JSON PATH)) AS origins
        ${joins} WHERE ${where} ORDER BY di.dataset_item_id OFFSET ${offset} ROWS FETCH NEXT 24 ROWS ONLY FOR JSON PATH;`) || [];
      const stats = await jsonQuery(`SELECT COUNT(*) AS total,COALESCE(SUM(CASE WHEN di.is_excluded=0 THEN 1 ELSE 0 END),0) AS included,COALESCE(SUM(CASE WHEN di.is_excluded=1 THEN 1 ELSE 0 END),0) AS excluded,(SELECT COUNT(*) FROM dbo.RigPdfItemSuppression WHERE dataset_id=${id}) AS deleted ${joins} WHERE di.dataset_id=${id} FOR JSON PATH,WITHOUT_ARRAY_WRAPPER;`);
      const origins = await jsonQuery(`SELECT DISTINCT o.rig_name,o.pdf_name ${joins} CROSS APPLY OPENJSON(r.source_metadata,'$.occurrences') WITH(rig_name NVARCHAR(120),pdf_name NVARCHAR(255)) o WHERE di.dataset_id=${id} ORDER BY o.rig_name,o.pdf_name FOR JSON PATH;`) || [];
      sendJson(response, 200, { dataset: info, stats, origins, items, total, offset, limit: 24 }); return true;
    }
    const body = await jsonBody(request), ids = idList(body);
    if (info.status !== 'DRAFT') throw httpError(409, 'Kurasi hanya dapat diubah pada dataset Draft. Dataset yang disetujui dibekukan.');
    if (request.method === 'POST' && match[2] === 'delete-preview') {
      allowed(user, true);
      const rows = await selectedRows(id, ids) || [];
      if (rows.length !== ids.length || rows.some(row => !row.is_excluded)) throw httpError(409, 'Pilih foto Protect yang sudah dikecualikan sebelum menghapus.');
      sendJson(response, 200, { count: rows.length, photos_retained: rows.filter(row => row.dataset_references || row.analysis_references || row.evaluation_referenced).length, items: rows, preview_token: fingerprint(rows), confirmation: `HAPUS ${rows.length} FOTO` }); return true;
    }
    if (request.method === 'PATCH' && match[2] === 'selection') {
      if (typeof body.excluded !== 'boolean') throw httpError(400, 'Pilih tindakan Dipakai atau Dikecualikan.');
      const reason = String(body.reason || '').trim().slice(0, 300);
      if (body.excluded && !reason) throw httpError(400, 'Isi alasan pengecualian foto.');
      const result = await withDatasetMutationLock(id, () => jsonQuery(`SET XACT_ABORT ON; BEGIN TRANSACTION;
        ${mutableSql(id)}
        IF (SELECT COUNT(*) ${joins} WHERE di.dataset_id=${id} AND di.dataset_item_id IN(${ids.join(',')}))<>${ids.length} THROW 51000,'Daftar foto berubah. Muat ulang galeri.',1;
        UPDATE di SET is_excluded=${body.excluded ? 1 : 0},exclusion_reason=${body.excluded ? sqlText(reason) : 'NULL'},excluded_at=${body.excluded ? 'SYSUTCDATETIME()' : 'NULL'},excluded_by_user_id=${body.excluded ? user.user_id : 'NULL'} FROM dbo.DatasetItem di WHERE di.dataset_id=${id} AND di.dataset_item_id IN(${ids.join(',')});
        INSERT dbo.AuditEvent(user_id,action_code,entity_type,entity_id,detail) SELECT ${user.user_id},${sqlAscii(body.excluded ? 'PROTECT_PHOTOS_EXCLUDED' : 'PROTECT_PHOTOS_RESTORED')},'DatasetItem',CONVERT(nvarchar(80),dataset_item_id),${sqlText(reason || 'Dikembalikan ke Dipakai')} FROM dbo.DatasetItem WHERE dataset_id=${id} AND dataset_item_id IN(${ids.join(',')});
        COMMIT TRANSACTION; SELECT ${ids.length} AS changed,CAST(${body.excluded ? 1 : 0} AS BIT) AS excluded FOR JSON PATH,WITHOUT_ARRAY_WRAPPER;`));
      if (result?.changed !== ids.length) throw httpError(503, 'Hasil kurasi belum terkonfirmasi. Muat ulang galeri.');
      sendJson(response, 200, result); return true;
    }
    if (request.method === 'DELETE' && !match[2]) {
      allowed(user, true);
      if (body.permanent !== true || body.confirmation !== `HAPUS ${ids.length} FOTO` || !/^[a-f0-9]{64}$/.test(body.preview_token || '')) throw httpError(400, 'Tinjau daftar foto dan masukkan konfirmasi penghapusan.');
      const result = await withDatasetMutationLock(id, async () => {
        const rows = await selectedRows(id, ids) || [];
        if (rows.length !== ids.length || rows.some(row => !row.is_excluded) || fingerprint(rows) !== body.preview_token) throw httpError(409, 'Daftar foto berubah. Tinjau kembali sebelum menghapus.');
        const committed = await jsonQuery(`SET XACT_ABORT ON; BEGIN TRANSACTION;
          ${mutableSql(id)}
          IF (SELECT COUNT(*) ${joins} WHERE di.dataset_id=${id} AND di.is_excluded=1 AND di.dataset_item_id IN(${ids.join(',')}))<>${ids.length} THROW 51000,'Pilih hanya foto Protect yang dikecualikan.',1;
          DECLARE @assets TABLE(image_id INT PRIMARY KEY,file_uri NVARCHAR(500),checksum CHAR(64));
          DECLARE @orphans TABLE(image_id INT,file_uri NVARCHAR(500),checksum CHAR(64));
          INSERT @assets SELECT DISTINCT ia.image_id,ia.file_uri,ia.checksum FROM dbo.ImageAsset ia WITH(XLOCK,HOLDLOCK) JOIN dbo.DatasetItem di ON di.image_id=ia.image_id WHERE di.dataset_id=${id} AND di.dataset_item_id IN(${ids.join(',')});
          INSERT dbo.RigPdfItemSuppression(dataset_id,checksum,original_name,deleted_by_user_id) SELECT DISTINCT ${id},ia.checksum,ia.original_name,${user.user_id} ${joins} WHERE di.dataset_id=${id} AND di.dataset_item_id IN(${ids.join(',')}) AND NOT EXISTS(SELECT 1 FROM dbo.RigPdfItemSuppression s WITH(UPDLOCK,HOLDLOCK) WHERE s.dataset_id=${id} AND s.checksum=ia.checksum);
          DELETE FROM dbo.Annotation WHERE dataset_item_id IN(${ids.join(',')});
          DELETE FROM dbo.DatasetItemProvenance WHERE dataset_item_id IN(${ids.join(',')});
          DELETE FROM dbo.DatasetItem WHERE dataset_id=${id} AND dataset_item_id IN(${ids.join(',')});
          DELETE ia OUTPUT deleted.image_id,deleted.file_uri,deleted.checksum INTO @orphans FROM dbo.ImageAsset ia JOIN @assets a ON a.image_id=ia.image_id
          WHERE NOT EXISTS(SELECT 1 FROM dbo.DatasetItem WITH(HOLDLOCK) WHERE image_id=ia.image_id)
            AND NOT EXISTS(SELECT 1 FROM dbo.Analysis WITH(HOLDLOCK) WHERE image_id=ia.image_id)
            AND NOT EXISTS(SELECT 1 FROM dbo.EvaluationItem WITH(HOLDLOCK) WHERE image_id=ia.image_id)
            AND NOT EXISTS(SELECT 1 FROM dbo.ImageAsset other WITH(HOLDLOCK) WHERE other.image_id<>ia.image_id AND other.file_uri=ia.file_uri)
            AND NOT EXISTS(SELECT 1 FROM dbo.EvaluationRun er WITH(HOLDLOCK) CROSS APPLY OPENJSON(CASE WHEN ISJSON(er.dataset_snapshot)=1 THEN er.dataset_snapshot ELSE N'{}' END,'$.items') WITH(image_id INT '$.image_id') snap WHERE snap.image_id=ia.image_id);
          INSERT dbo.AuditEvent(user_id,action_code,entity_type,entity_id,detail) VALUES(${user.user_id},'PROTECT_PHOTOS_DELETED','Dataset',${sqlText(id)},${sqlText(JSON.stringify({ item_ids: ids, count: ids.length }))});
          COMMIT TRANSACTION;
          SELECT ${ids.length} AS deleted,(SELECT COUNT(*) FROM @orphans) AS photos_deleted,((SELECT COUNT(*) FROM @assets)-(SELECT COUNT(*) FROM @orphans)) AS photos_retained,JSON_QUERY((SELECT image_id,file_uri,checksum FROM @orphans FOR JSON PATH)) AS orphans FOR JSON PATH,WITHOUT_ARRAY_WRAPPER;`);
        if (committed?.deleted !== ids.length || !Number.isSafeInteger(committed.photos_deleted) || !Array.isArray(committed.orphans) || committed.orphans.length !== committed.photos_deleted) throw httpError(503, 'Hasil penghapusan belum terkonfirmasi. Berkas tetap dipertahankan; muat ulang galeri.');
        const cleanup = await cleanupDatasetOrphans({ root, privateDir, uploadDir, deletionConfirmed: true }, committed.orphans);
        const prepared = await cleanupPrepared(committed.orphans);
        return { deleted: committed.deleted, photos_retained: committed.photos_retained, ...cleanup, ...prepared,
          ...(prepared.prepared_files_pending ? { prepared_warning: 'Sebagian salinan hasil ekstraksi belum dapat dibersihkan. PDF asli tetap dipertahankan.' } : {}) };
      });
      sendJson(response, 200, result); return true;
    }
    throw httpError(405, 'Metode kurasi tidak tersedia.');
  };
}
