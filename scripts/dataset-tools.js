import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';

const labels = ['RISK', 'NO_LISTED_HAZARD_VISIBLE', 'UNCERTAIN'];
const splits = ['TRAIN', 'VALIDATION', 'TEST'];
const terminal = ['COMPLETED', 'CANCELLED', 'FAILED', 'INTERRUPTED'];
const promptVersion = 'k3-vision-3-base';
const storedBoxEdgeTolerance = 1e-6;
const extension = mime => ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[mime] || 'jpg');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const text = (value, length = 1200) => String(value || '').trim().slice(0, length);
const parseJson = (value, fallback) => { try { return typeof value === 'string' ? JSON.parse(value) : value ?? fallback; } catch { return fallback; } };

function within(directory, file) {
  const relative = path.relative(directory, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function samePath(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

// ZIP uses the uncompressed STORE format, UTF-8 names and data descriptors.
// Entries are written sequentially, so the archive never accumulates in RAM.
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}
function dosDate(value) {
  const date = new Date(value || '2026-01-01T00:00:00Z');
  if (!Number.isFinite(date.getTime())) return dosDate('2026-01-01T00:00:00Z');
  return { date: ((Math.max(1980, Math.min(2107, date.getUTCFullYear())) - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(), time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2) };
}
async function writeZip(response, entries, createdAt) {
  const central = []; let offset = 0; const stamp = dosDate(createdAt);
  const write = async buffer => {
    if (response.destroyed) throw new Error('Unduhan dibatalkan.');
    const accepted = response.write(buffer); offset += buffer.length;
    if (!accepted) await new Promise((resolve, reject) => {
      const cleanup = () => { response.off('drain', drained); response.off('close', closed); response.off('error', failed); };
      const drained = () => { cleanup(); resolve(); };
      const closed = () => { cleanup(); reject(new Error('Unduhan dibatalkan.')); };
      const failed = error => { cleanup(); reject(error); };
      response.once('drain', drained); response.once('close', closed); response.once('error', failed);
    });
  };
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const buffer = entry.buffer || await entry.load();
    if (buffer.length > 0xffffffff || offset + buffer.length + 1024 > 0xffffffff || central.length >= 65535) throw new Error('Arsip melebihi batas ZIP. Pisahkan dataset menjadi versi yang lebih kecil.');
    const start = offset; const checksum = crc32(buffer);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0808, 6); header.writeUInt16LE(stamp.time, 10); header.writeUInt16LE(stamp.date, 12); header.writeUInt16LE(name.length, 26);
    await write(header); await write(name); await write(buffer);
    const descriptor = Buffer.alloc(16); descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(checksum, 4); descriptor.writeUInt32LE(buffer.length, 8); descriptor.writeUInt32LE(buffer.length, 12); await write(descriptor);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(0x0808, 8); record.writeUInt16LE(stamp.time, 12); record.writeUInt16LE(stamp.date, 14); record.writeUInt32LE(checksum, 16); record.writeUInt32LE(buffer.length, 20); record.writeUInt32LE(buffer.length, 24); record.writeUInt16LE(name.length, 28); record.writeUInt32LE(start, 42); central.push(Buffer.concat([record, name]));
  }
  const centralStart = offset;
  for (const record of central) await write(record);
  const footer = Buffer.alloc(22); footer.writeUInt32LE(0x06054b50); footer.writeUInt16LE(central.length, 8); footer.writeUInt16LE(central.length, 10); footer.writeUInt32LE(offset - centralStart, 12); footer.writeUInt32LE(centralStart, 16); await write(footer); response.end();
}

export function createDatasetTools(ctx) {
  const { jsonQuery, executeSql, sqlText, sqlAscii, intValue, httpError, jsonBody, sendJson, audit, analyzeWithOllama, listOllamaVisionModels, withInferenceLock } = ctx;
  const running = new Map();
  const writeSql = query => executeSql(query, { database: 'K3VisionLocal' });
  const allowed = user => { if (!['operator', 'admin'].includes(user.role)) throw httpError(403, 'Fitur dataset tersedia untuk pengguna dan admin.'); };
  const owner = (user, run) => { if (user.role !== 'admin' && user.user_id !== run.owner_user_id) throw httpError(404, 'Evaluasi tidak ditemukan.'); };
  const jsonDate = column => `CONVERT(varchar(33),${column},126)`;
  async function objectBody(request) {
    const body = await jsonBody(request);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'Isi permintaan harus berupa objek JSON.');
    return body;
  }

  async function loadImageBuffer(asset) {
    const uri = asset.file_uri;
    if (typeof uri !== 'string' || uri.includes('\0') || path.isAbsolute(uri)) throw httpError(409, 'Lokasi foto dataset tidak valid.');
    const uploads = path.resolve(ctx.privateDir, 'uploads');
    const file = path.resolve(ctx.privateDir, uri);
    if (!within(uploads, file)) throw httpError(409, 'Foto dataset berada di luar folder unggahan.');
    const realRoot = await fs.realpath(ctx.root);
    const realUploads = await fs.realpath(uploads);
    if (!samePath(realUploads, path.join(realRoot, 'data', 'private', 'uploads'))) throw httpError(409, 'Folder unggahan mengarah ke lokasi lain.');
    const realFile = await fs.realpath(file);
    if (!within(realUploads, realFile)) throw httpError(409, 'Foto dataset mengarah ke lokasi lain.');
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024) throw httpError(409, 'Berkas foto dataset tidak valid.');
    const buffer = await fs.readFile(file);
    if (digest(buffer) !== asset.checksum) throw httpError(409, `Foto dataset ${asset.image_id} berubah; checksum tidak sesuai. Periksa data sebelum melanjutkan.`);
    return buffer;
  }
  async function imageBuffer(asset) {
    try { return await loadImageBuffer(asset); }
    catch (error) {
      if (error.status) throw error;
      throw httpError(409, `Berkas foto dataset ${asset.image_id} belum dapat dibaca dari penyimpanan lokal. Periksa berkas sebelum ekspor atau evaluasi.`);
    }
  }

  async function datasetSnapshot(id) {
    const dataset = await jsonQuery(`SELECT dataset_id,name,version,status,dataset_kind,${jsonDate('created_at')} AS created_at FROM dbo.Dataset WHERE dataset_id=${id} FOR JSON PATH,WITHOUT_ARRAY_WRAPPER;`);
    if (!dataset) throw httpError(404, 'Dataset tidak ditemukan.');
    if (dataset.dataset_kind === 'PPE_OBJECT') throw httpError(409, 'Dataset objek menggunakan paket YOLO di Dataset publik. Evaluasi VLM aman/bahaya membutuhkan dataset inspeksi yang telah dikurasi.');
    if (dataset.status !== 'APPROVED') throw httpError(409, 'Ajukan dan setujui dataset dahulu sebelum ekspor atau evaluasi.');
    const items = await jsonQuery(`SELECT di.dataset_item_id,di.image_id,di.split,di.overall_label,di.label_status,ia.file_uri,ia.mime_type,ia.file_size_bytes,ia.original_name,ia.checksum,ia.license_verified,ia.license_name,ia.license_url,ia.source_url,ia.author_name,ia.attribution_text,COALESCE(rwa.name,wa.name,N'Area dataset') AS area_name,COALESCE(rwa.area_type,wa.area_type,CASE WHEN r.source_kind='PDF' THEN 'RIG' ELSE 'KEDUANYA' END) AS area_type,p.source_analysis_id,p.source_model_name,p.source_predicted_status,p.source_result_status,p.source_feedback_id,p.source_feedback_label,p.source_feedback_notes,p.source_feedback_user_id,p.source_feedback_user_name,p.source_analysis_user_id,p.imported_by_user_id,COALESCE(r.curated_description,p.curated_description) AS curated_description,r.source_kind,r.source_group_key,r.source_metadata,CONVERT(varchar(36),p.source_live_session_id) AS source_live_session_id,${jsonDate('p.source_captured_at')} AS source_captured_at,JSON_QUERY((SELECT an.hazard_type_id,h.code,h.name,an.bbox_x AS x,an.bbox_y AS y,an.bbox_width AS width,an.bbox_height AS height,an.note FROM dbo.Annotation an JOIN dbo.HazardType h ON h.hazard_type_id=an.hazard_type_id WHERE an.dataset_item_id=di.dataset_item_id ORDER BY an.hazard_type_id,an.annotation_id FOR JSON PATH)) AS annotations FROM dbo.DatasetItem di JOIN dbo.ImageAsset ia ON ia.image_id=di.image_id LEFT JOIN dbo.WorkArea wa ON wa.work_area_id=ia.work_area_id LEFT JOIN dbo.DatasetItemProvenance p ON p.dataset_item_id=di.dataset_item_id LEFT JOIN dbo.DatasetTrainingReview r ON r.dataset_item_id=di.dataset_item_id LEFT JOIN dbo.WorkArea rwa ON rwa.work_area_id=r.work_area_id WHERE di.dataset_id=${id} AND di.is_excluded=0 ORDER BY di.dataset_item_id FOR JSON PATH;`) || [];
    if (!items.length) throw httpError(409, 'Dataset belum berisi foto.');
    const invalid = items.filter(item => item.label_status !== 'VERIFIED' || !item.license_verified || !text(item.license_name));
    if (invalid.length) throw httpError(409, `Verifikasi label dan izin penggunaan semua foto terlebih dahulu. Foto yang belum siap: ${invalid.slice(0, 12).map(item => item.dataset_item_id).join(', ')}.`);
    // Include preserved provenance and every currently known live session for a
    // reused image. Check all splits, not only TEST, to prevent session leakage.
    const sessions = await jsonQuery(`SELECT dataset_item_id,session_id,split FROM (SELECT di.dataset_item_id,CONVERT(varchar(36),p.source_live_session_id) AS session_id,di.split FROM dbo.DatasetItem di JOIN dbo.DatasetItemProvenance p ON p.dataset_item_id=di.dataset_item_id WHERE di.dataset_id=${id} AND di.is_excluded=0 AND p.source_live_session_id IS NOT NULL UNION SELECT di.dataset_item_id,preserved.session_id,di.split FROM dbo.DatasetItem di JOIN dbo.DatasetItemProvenance p ON p.dataset_item_id=di.dataset_item_id CROSS APPLY OPENJSON(p.source_live_sessions_json) WITH(session_id VARCHAR(36)) preserved WHERE di.dataset_id=${id} AND di.is_excluded=0 AND preserved.session_id IS NOT NULL UNION SELECT di.dataset_item_id,CONVERT(varchar(36),live.session_id),di.split FROM dbo.DatasetItem di JOIN dbo.Analysis a ON a.image_id=di.image_id JOIN dbo.AnalysisLiveEvidence live ON live.analysis_id=a.analysis_id WHERE di.dataset_id=${id} AND di.is_excluded=0) AS grouped ORDER BY session_id,dataset_item_id FOR JSON PATH;`) || [];
    const pdfGroups = new Map();
    for (const item of items) {
      if (!item.source_group_key) continue;
      if (pdfGroups.has(item.source_group_key) && pdfGroups.get(item.source_group_key) !== item.split) throw httpError(409, 'Foto satu kelompok pengambilan berada dalam beberapa pembagian. Perbaiki melalui PDF rig sebelum ekspor atau evaluasi.');
      pdfGroups.set(item.source_group_key, item.split);
      item.source_metadata = parseJson(item.source_metadata, null);
    }
    const sessionSplit = new Map();
    for (const session of sessions) {
      if (sessionSplit.has(session.session_id) && sessionSplit.get(session.session_id) !== session.split) throw httpError(409, 'Satu sesi kamera berada pada beberapa split. Satukan seluruh sesi ke TRAIN, VALIDATION, atau TEST sebelum melanjutkan.');
      sessionSplit.set(session.session_id, session.split);
    }
    for (const item of items) {
      item.annotations = parseJson(item.annotations, []);
      const invalidBox = () => httpError(409, `Kotak kategori pada foto ${item.dataset_item_id} berada di luar gambar. Periksa label sebelum ekspor atau evaluasi.`);
      if (!Array.isArray(item.annotations)) throw invalidBox();
      item.annotations = item.annotations.map(annotation => {
        if (!annotation || ![annotation.x, annotation.y, annotation.width, annotation.height].every(Number.isFinite) || annotation.x < 0 || annotation.y < 0 || annotation.x >= 1 || annotation.y >= 1 || annotation.width <= 0 || annotation.height <= 0 || annotation.x + annotation.width > 1 + storedBoxEdgeTolerance || annotation.y + annotation.height > 1 + storedBoxEdgeTolerance) throw invalidBox();
        // SQL REAL rounds each coordinate separately. Keep valid edge boxes
        // inside the image in every exported/evaluation snapshot.
        return { ...annotation, width: Math.min(annotation.width, 1 - annotation.x), height: Math.min(annotation.height, 1 - annotation.y) };
      });
      item.session_ids = [...new Set(sessions.filter(session => session.dataset_item_id === item.dataset_item_id).map(session => session.session_id))].sort();
      if (item.overall_label === 'RISK' && !item.annotations.length) throw httpError(409, `Foto berlabel bahaya ${item.dataset_item_id} belum memiliki kotak kategori.`);
      if (item.overall_label === 'NO_LISTED_HAZARD_VISIBLE' && item.annotations.length) throw httpError(409, `Foto ${item.dataset_item_id} berlabel tanpa bahaya tetapi mempunyai kotak bahaya. Periksa kembali labelnya.`);
      item.curated_description = text(item.curated_description) || `${item.overall_label === 'RISK' ? 'Indikasi bahaya terlihat' : item.overall_label === 'UNCERTAIN' ? 'Belum pasti berdasarkan foto' : 'Tidak tampak kategori bahaya yang dilabeli'}${item.annotations.length ? `: ${[...new Set(item.annotations.map(annotation => annotation.name))].join(', ')}` : '.'}`;
    }
    return { dataset, items, sessions };
  }

  async function promote(id, body, user) {
    allowed(user);
    const datasetId = intValue(body.dataset_id, 'Dataset');
    const candidate = body.candidate === true;
    const label = candidate ? 'UNCERTAIN' : String(body.overall_label || '').toUpperCase();
    const split = String(body.split || '').toUpperCase();
    if (!labels.includes(label) || !splits.includes(split)) throw httpError(400, 'Pilih label dan pembagian data yang valid.');
    if (body.license_confirmed !== true) throw httpError(400, 'Konfirmasi izin penggunaan foto untuk dataset terlebih dahulu.');
    const description = candidate ? 'Calon pelatihan: foto dan label belum ditinjau.' : text(body.description);
    if (!description) throw httpError(400, 'Tambahkan deskripsi foto yang sudah Anda tinjau.');
    if (!Array.isArray(body.annotations) || body.annotations.length > 80) throw httpError(400, 'Kotak anotasi tidak valid atau terlalu banyak.');
    if (candidate && body.annotations.length) throw httpError(400, 'Calon yang belum ditinjau tidak boleh memiliki anotasi acuan.');
    const boxes = body.annotations.map(annotation => {
      if (!annotation || typeof annotation !== 'object' || Array.isArray(annotation) || [annotation.x, annotation.y, annotation.width, annotation.height].some(value => value == null)) throw httpError(400, 'Lengkapi kategori dan empat koordinat pada setiap kotak.');
      const hazardId = intValue(annotation.hazard_type_id, 'Kategori bahaya');
      const x = Number(annotation.x), y = Number(annotation.y), width = Number(annotation.width), height = Number(annotation.height);
      if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 || y + height > 1) throw httpError(400, 'Kotak anotasi harus berada di dalam gambar, dengan koordinat relatif 0–1.');
      return { hazardId, x, y, width, height };
    });
    if (label === 'RISK' && !boxes.length) throw httpError(400, 'Foto berlabel bahaya memerlukan paling sedikit satu kotak kategori.');
    if (label === 'NO_LISTED_HAZARD_VISIBLE' && boxes.length) throw httpError(400, 'Label tanpa bahaya tidak boleh memiliki kotak bahaya.');
    const active = await jsonQuery(`SELECT hazard_type_id FROM dbo.HazardType WHERE is_active=1 FOR JSON PATH;`) || [];
    if (boxes.some(box => !active.some(hazard => hazard.hazard_type_id === box.hazardId))) throw httpError(400, 'Salah satu kategori anotasi sudah tidak aktif.');
    const inserted = await jsonQuery(`SET XACT_ABORT ON; BEGIN TRANSACTION;
DECLARE @datasetState VARCHAR(20),@imageId INT,@itemId INT,@found BIT=0,@duplicate BIT=0,@sessionConflict BIT=0,@session UNIQUEIDENTIFIER,@sessionsJson NVARCHAR(MAX),@captured DATETIME2(3),@feedbackId BIGINT,@feedbackLabel VARCHAR(32),@feedbackNotes NVARCHAR(1200),@feedbackUserId INT,@feedbackUserName NVARCHAR(120),@analysisUserId INT,@model NVARCHAR(120),@prediction VARCHAR(32),@result VARCHAR(32),@checksum CHAR(64);
SELECT @datasetState=status FROM dbo.Dataset WITH(UPDLOCK,HOLDLOCK) WHERE dataset_id=${datasetId} AND dataset_kind='HAZARD';
SELECT @found=1,@imageId=a.image_id,@result=a.result_status,@analysisUserId=a.created_by_user_id FROM dbo.Analysis a WITH(UPDLOCK,HOLDLOCK) WHERE a.analysis_id=${id} AND a.archived_at IS NULL;
IF @datasetState='DRAFT' AND @found=1 BEGIN
SELECT @checksum=checksum FROM dbo.ImageAsset WITH(UPDLOCK,HOLDLOCK) WHERE image_id=@imageId;
SELECT @session=session_id,@captured=captured_at FROM dbo.AnalysisLiveEvidence WHERE analysis_id=${id};
SELECT @sessionsJson=(SELECT DISTINCT CONVERT(varchar(36),live.session_id) AS session_id FROM dbo.Analysis a JOIN dbo.AnalysisLiveEvidence live ON live.analysis_id=a.analysis_id WHERE a.image_id=@imageId FOR JSON PATH);
IF EXISTS(SELECT 1 FROM OPENJSON(@sessionsJson) WITH(session_id VARCHAR(36)) incoming JOIN dbo.DatasetItem di ON di.dataset_id=${datasetId} AND di.split<>${sqlAscii(split)} LEFT JOIN dbo.DatasetItemProvenance p ON p.dataset_item_id=di.dataset_item_id WHERE CONVERT(varchar(36),p.source_live_session_id)=incoming.session_id OR EXISTS(SELECT 1 FROM OPENJSON(p.source_live_sessions_json) WITH(session_id VARCHAR(36)) preserved WHERE preserved.session_id=incoming.session_id) OR EXISTS(SELECT 1 FROM dbo.Analysis a JOIN dbo.AnalysisLiveEvidence live ON live.analysis_id=a.analysis_id WHERE a.image_id=di.image_id AND CONVERT(varchar(36),live.session_id)=incoming.session_id)) SET @sessionConflict=1;
IF EXISTS(SELECT 1 FROM dbo.DatasetItem WHERE dataset_id=${datasetId} AND image_id=@imageId) SET @duplicate=1;
IF @duplicate=0 AND @sessionConflict=0 BEGIN
UPDATE dbo.ImageAsset SET license_name=CASE WHEN NULLIF(LTRIM(RTRIM(license_name)),N'') IS NULL THEN N'Izin penggunaan dataset internal dikonfirmasi pengguna' ELSE license_name END,license_verified=1 WHERE image_id=@imageId;
SELECT @model=model_name,@prediction=predicted_status FROM dbo.AnalysisVlmPrediction WHERE analysis_id=${id};
SELECT TOP(1) @feedbackId=f.feedback_id,@feedbackLabel=f.corrected_label,@feedbackNotes=f.notes,@feedbackUserId=f.user_id,@feedbackUserName=u.full_name FROM dbo.AnalysisFeedback f JOIN dbo.AppUser u ON u.user_id=f.user_id WHERE f.analysis_id=${id} ORDER BY f.created_at DESC,f.feedback_id DESC;
INSERT dbo.DatasetItem(dataset_id,image_id,split,overall_label,label_status,labeled_by_user_id) VALUES(${datasetId},@imageId,${sqlAscii(split)},${sqlAscii(label)},'DRAFT',${user.user_id}); SET @itemId=SCOPE_IDENTITY();
INSERT dbo.DatasetItemProvenance(dataset_item_id,source_analysis_id,source_image_checksum,source_model_name,source_predicted_status,source_result_status,source_feedback_id,source_feedback_label,source_feedback_notes,source_feedback_user_id,source_feedback_user_name,source_analysis_user_id,source_live_session_id,source_live_sessions_json,source_captured_at,curated_description,imported_by_user_id) VALUES(@itemId,${id},@checksum,@model,@prediction,@result,@feedbackId,@feedbackLabel,@feedbackNotes,@feedbackUserId,@feedbackUserName,@analysisUserId,@session,COALESCE(@sessionsJson,N'[]'),@captured,${sqlText(description)},${user.user_id});
INSERT dbo.DatasetTrainingReview(dataset_item_id,source_kind,source_group_key,source_metadata,curated_description,reviewed_at,reviewed_by_user_id) VALUES(@itemId,'INSPECTION',CASE WHEN @session IS NOT NULL THEN 'camera:'+CONVERT(varchar(36),@session) ELSE 'image:'+@checksum END,${sqlText(JSON.stringify({source_analysis_id:id}))},${sqlText(description)},${candidate ? 'NULL' : 'SYSUTCDATETIME()'},${candidate ? 'NULL' : user.user_id});
${boxes.map(box => `INSERT dbo.Annotation(dataset_item_id,hazard_type_id,bbox_x,bbox_y,bbox_width,bbox_height) VALUES(@itemId,${box.hazardId},${box.x},${box.y},${box.width},${box.height});`).join('\n')}
INSERT dbo.AuditEvent(user_id,action_code,entity_type,entity_id,detail) VALUES(${user.user_id},'ANALYSIS_CURATED_TO_DATASET','DatasetItem',CONVERT(nvarchar(80),@itemId),${sqlText(`Asal analisis ${id}; dataset ${datasetId}; ${label}; ${split}; izin penggunaan dikonfirmasi.`)});
END; END; COMMIT TRANSACTION;
SELECT @found AS found,@datasetState AS dataset_status,@duplicate AS duplicate_item,@sessionConflict AS session_conflict,@itemId AS dataset_item_id FOR JSON PATH,WITHOUT_ARRAY_WRAPPER;`);
    if (!inserted?.found) throw httpError(404, 'Pemeriksaan aktif tidak ditemukan. Pulihkan arsip sebelum menjadikannya dataset.');
    if (inserted.dataset_status !== 'DRAFT') throw httpError(409, 'Pilih dataset yang masih berstatus DRAFT.');
    if (inserted.session_conflict) throw httpError(409, 'Sesi kamera ini sudah masuk split lain pada dataset tersebut. Gunakan split yang sama untuk seluruh sesi.');
    if (inserted.duplicate_item) throw httpError(409, 'Foto tersebut sudah ada di dataset ini.');
    if (!inserted.dataset_item_id) throw httpError(503, 'Hasil kurasi belum dapat dipastikan. Muat ulang dataset sebelum mencoba lagi.');
    return { dataset_item_id: inserted.dataset_item_id, dataset_id: datasetId, label_status: 'DRAFT', message: 'Foto dan koreksi masuk dataset. Verifikasi label sebelum mengajukan persetujuan.' };
  }

  async function buildExport(id, format, training = false) {
    if (!['jsonl', 'yolo'].includes(format)) throw httpError(400, 'Pilih format JSONL atau YOLO.');
    const snapshot = await datasetSnapshot(id);
    const catalog = await jsonQuery('SELECT hazard_type_id,code,name FROM dbo.HazardType ORDER BY hazard_type_id FOR JSON PATH;') || [];
    const trainedIds = new Set(snapshot.items.filter(item => item.split === 'TRAIN' && item.overall_label === 'RISK').flatMap(item => item.annotations.map(box => box.hazard_type_id)));
    const classes = (training ? catalog.filter(item => trainedIds.has(item.hazard_type_id)) : catalog).map((item, class_id) => ({ class_id, ...item }));
    if (training && (!classes.length || snapshot.items.some(item => item.overall_label === 'RISK' && item.annotations.some(box => !trainedIds.has(box.hazard_type_id))))) throw httpError(409, 'Setiap kategori yang akan diuji harus mempunyai kotak contoh pada TRAIN.');
    const classById = new Map(classes.map(item => [item.hazard_type_id, item.class_id]));
    const included = format === 'yolo' ? snapshot.items.filter(item => item.overall_label !== 'UNCERTAIN') : snapshot.items;
    if (!included.length) throw httpError(409, 'Tidak ada foto yang dapat diekspor pada format ini.');
    const excluded = snapshot.items.filter(item => !included.includes(item)).map(item => ({ dataset_item_id: item.dataset_item_id, reason: 'UNCERTAIN tidak menjadi contoh positif atau negatif detector.' }));
    const files = included.map(item => ({ item, name: `images/${item.split.toLowerCase()}/image_${item.image_id}_${item.checksum.slice(0, 12)}.${extension(item.mime_type)}` }));
    if (files.reduce((sum, file) => sum + Number(file.item.file_size_bytes || 0), 0) > 0xf0000000 || files.length + included.length + 5 >= 65535) throw httpError(413, 'Dataset melebihi batas ZIP. Pisahkan ke versi dataset yang lebih kecil.');
    for (const file of files) await imageBuffer(file.item); // Fail before sending headers.
    const manifest = { schema_version: 'lentera-dataset-1', format, dataset: snapshot.dataset, class_map: classes, coordinate_format: format === 'yolo' ? 'normalized_center_x_center_y_width_height' : 'normalized_top_left_x_y_width_height', splits: splits, session_split_policy: 'one_session_one_split_per_dataset', excluded, warnings: excluded.length ? ['Foto berlabel UNCERTAIN dikecualikan dari paket YOLO dan tetap tersedia melalui JSONL.'] : [], items: files.map(({ item, name }) => ({ ...item, archive_image: name, file_uri: undefined })) };
    manifest.snapshot_sha256 = digest(JSON.stringify(manifest));
    const entries = [{ name: 'manifest.json', buffer: Buffer.from(JSON.stringify(manifest, null, 2)) }];
    for (const file of files) entries.push({ name: file.name, load: () => imageBuffer(file.item) });
    if (format === 'jsonl') {
      entries.push({ name: 'dataset.jsonl', buffer: Buffer.from(files.map(({ item, name }) => JSON.stringify({ image: name, instruction: 'Jelaskan indikasi visual risiko K3 yang benar-benar tampak pada foto ini. Bila konteks tidak cukup, nyatakan belum pasti.', target: { label: item.overall_label, description: item.curated_description, annotations: item.annotations }, split: item.split, dataset_item_id: item.dataset_item_id, checksum: item.checksum, source_session_ids: item.session_ids })).join('\n') + '\n') });
    } else {
      entries.push({ name: 'data.yaml', buffer: Buffer.from(`path: .\ntrain: images/train\nval: images/validation\ntest: images/test\nnc: ${classes.length}\nnames: ${JSON.stringify(classes.map(item => item.name))}\n`) });
      for (const { item, name } of files) entries.push({ name: name.replace(/^images\//, 'labels/').replace(/\.[^.]+$/, '.txt'), buffer: Buffer.from(item.annotations.map(annotation => `${classById.get(annotation.hazard_type_id)} ${(annotation.x + annotation.width / 2).toFixed(8)} ${(annotation.y + annotation.height / 2).toFixed(8)} ${Number(annotation.width).toFixed(8)} ${Number(annotation.height).toFixed(8)}`).join('\n') + (item.annotations.length ? '\n' : '')) });
      for (const split of splits) entries.push({ name: `images/${split.toLowerCase()}/`, buffer: Buffer.alloc(0) }, { name: `labels/${split.toLowerCase()}/`, buffer: Buffer.alloc(0) });
    }
    return { manifest, entries, createdAt: snapshot.dataset.created_at };
  }

  async function exportDataset(id, body, user, response) {
    allowed(user);
    const { manifest, entries, createdAt } = await buildExport(id, body.format);
    const included = manifest.items;
    await audit(user.user_id, 'DATASET_EXPORTED', 'Dataset', id, `${body.format}; ${included.length} foto; snapshot ${manifest.snapshot_sha256}`);
    response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="lentera-dataset-${id}-${body.format}-${manifest.snapshot_sha256.slice(0, 12)}.zip"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Dataset-Snapshot': manifest.snapshot_sha256 });
    try { await writeZip(response, entries, createdAt); }
    catch (error) { console.error('[dataset] Archive download interrupted:', text(error.message, 240)); response.destroy(); }
  }

  // Evaluation implementation is below; its HTTP acknowledgement is separated
  // from the background model job, while the shared inference lock remains held.
  function metricsFor(items, total) {
    const successful = items.filter(item => item.status === 'COMPLETED');
    const failed = items.filter(item => item.status === 'FAILED');
    const risk = successful.filter(item => item.true_label === 'RISK');
    const clear = successful.filter(item => item.true_label === 'NO_LISTED_HAZARD_VISIBLE');
    const uncertainTruth = successful.filter(item => item.true_label === 'UNCERTAIN');
    const missed = risk.filter(item => item.predicted_status === 'TIDAK_TAMPAK_BAHAYA').length;
    const alarms = clear.filter(item => item.predicted_status === 'POTENSI_TIDAK_AMAN').length;
    const riskUnsure = risk.filter(item => item.predicted_status === 'TIDAK_PASTI').length;
    const unsure = successful.filter(item => item.predicted_status === 'TIDAK_PASTI').length;
    const durations = items.filter(item => ['COMPLETED', 'FAILED'].includes(item.status) && Number.isFinite(item.latency_ms)).map(item => item.latency_ms).sort((left, right) => left - right);
    const ratio = (numerator, denominator) => denominator ? numerator / denominator : null;
    const percentile = quantile => durations.length ? durations[Math.max(0, Math.ceil(durations.length * quantile) - 1)] : null;
    const confusion = labels.map(truth => ({ true_label: truth, unsafe: successful.filter(item => item.true_label === truth && item.predicted_status === 'POTENSI_TIDAK_AMAN').length, no_visible_hazard: successful.filter(item => item.true_label === truth && item.predicted_status === 'TIDAK_TAMPAK_BAHAYA').length, uncertain: successful.filter(item => item.true_label === truth && item.predicted_status === 'TIDAK_PASTI').length }));
    return { total_items: total, completed_items: successful.length + failed.length, successful_items: successful.length, failed_items: failed.length, cancelled_items: items.filter(item => item.status === 'CANCELLED').length, interrupted_items: items.filter(item => item.status === 'INTERRUPTED').length, pending_items: items.filter(item => ['PENDING', 'RUNNING'].includes(item.status)).length, known_truth_evaluated: risk.length + clear.length, risk_truth_evaluated: risk.length, no_hazard_truth_evaluated: clear.length, uncertain_truth_evaluated: uncertainTruth.length, missed_hazards: missed, false_alarms: alarms, risk_uncertain_predictions: riskUnsure, uncertain_predictions: unsure, hazard_detected: risk.filter(item => item.predicted_status === 'POTENSI_TIDAK_AMAN').length, missed_hazard_rate: ratio(missed, risk.length), false_alarm_rate: ratio(alarms, clear.length), uncertainty_rate: ratio(unsure, successful.length), failure_rate: ratio(failed.length, successful.length + failed.length), risk_detection_rate: ratio(risk.filter(item => item.predicted_status === 'POTENSI_TIDAK_AMAN').length, risk.length), latency: { sample_count: durations.length, median_ms: percentile(0.5), p95_ms: percentile(0.95), mean_ms: durations.length ? durations.reduce((sum, duration) => sum + duration, 0) / durations.length : null }, confusion, definitions: { missed_hazards: 'Kebenaran RISK dengan prediksi TIDAK_TAMPAK_BAHAYA. Prediksi ragu pada RISK dihitung terpisah.', false_alarms: 'Kebenaran NO_LISTED_HAZARD_VISIBLE dengan prediksi POTENSI_TIDAK_AMAN.', denominator: 'Rasio bahaya terlewat dan salah alarm memakai foto berkebenaran terkait yang berhasil dianalisis. Kegagalan model, pembatalan, dan kebenaran UNCERTAIN tidak masuk perbandingan biner.', uncertainty: 'Prediksi TIDAK_PASTI pada seluruh foto yang berhasil dianalisis, termasuk kebenaran UNCERTAIN.', latency: 'Waktu per item untuk membaca foto dan mencoba inferensi; sampel sukses maupun gagal, tanpa item dibatalkan.' } };
  }

  const runSelect = `SELECT evaluation_run_id,owner_user_id,dataset_id,dataset_name,dataset_version,model_name,prompt_version,status,total_items,completed_items,cancellation_requested,error_message,JSON_VALUE(dataset_snapshot,'$.snapshot_sha256') AS snapshot_sha256,${jsonDate('created_at')} AS created_at,${jsonDate('started_at')} AS started_at,${jsonDate('finished_at')} AS finished_at,JSON_QUERY(metrics_json) AS metrics FROM dbo.EvaluationRun`;
  async function getRun(id, user) {
    const run = await jsonQuery(`${runSelect} WHERE evaluation_run_id=${id} FOR JSON PATH,WITHOUT_ARRAY_WRAPPER;`);
    if (!run) throw httpError(404, 'Evaluasi tidak ditemukan.');
    owner(user, run); return run;
  }
  async function getEvaluationItems(id) {
    return await jsonQuery(`SELECT evaluation_item_id,ordinal,dataset_item_id,image_id,checksum,original_name,split,true_label,curated_description,CONVERT(varchar(36),source_live_session_id) AS source_live_session_id,status,predicted_status,summary,latency_ms,error_message,${jsonDate('completed_at')} AS completed_at FROM dbo.EvaluationItem WHERE evaluation_run_id=${id} ORDER BY ordinal FOR JSON PATH;`) || [];
  }

  async function createRun(snapshot, modelName, hazards, user) {
    const test = snapshot.items.filter(item => item.split === 'TEST');
    if (!test.length) throw httpError(409, 'Dataset ini belum memiliki foto TEST terverifikasi.');
    // Verify immutable photo content before acknowledging the background job.
    for (const item of test) await imageBuffer(item);
    const runSnapshot = { schema_version: 'lentera-evaluation-1', performance_profile: 'hemat', prompt_version: promptVersion, dataset: snapshot.dataset, items: test.map(item => ({ ...item, file_uri: undefined })), session_split_policy: 'one_session_one_split_per_dataset' };
    runSnapshot.snapshot_sha256 = digest(JSON.stringify(runSnapshot));
    const result = await jsonQuery(`SET XACT_ABORT ON; BEGIN TRANSACTION; DECLARE @id INT,@state VARCHAR(20);
SELECT @state=status FROM dbo.Dataset WITH(UPDLOCK,HOLDLOCK) WHERE dataset_id=${snapshot.dataset.dataset_id};
IF @state='APPROVED' BEGIN
INSERT dbo.EvaluationRun(owner_user_id,dataset_id,dataset_name,dataset_version,model_name,prompt_version,status,total_items,dataset_snapshot,hazard_catalog_json) VALUES(${user.user_id},${snapshot.dataset.dataset_id},${sqlText(snapshot.dataset.name)},${sqlAscii(snapshot.dataset.version)},${sqlText(modelName)},'${promptVersion}','QUEUED',${test.length},${sqlText(JSON.stringify(runSnapshot))},${sqlText(JSON.stringify(hazards))}); SET @id=SCOPE_IDENTITY();
${test.map((item, index) => `INSERT dbo.EvaluationItem(evaluation_run_id,ordinal,dataset_item_id,image_id,checksum,file_uri,image_mime_type,original_name,area_name,area_type,split,true_label,curated_description,annotation_snapshot,source_live_session_id,status) VALUES(@id,${index + 1},${item.dataset_item_id},${item.image_id},${sqlAscii(item.checksum)},${sqlText(item.file_uri)},${sqlAscii(item.mime_type)},${sqlText(item.original_name)},${sqlText(item.area_name)},${sqlAscii(item.area_type)},'TEST',${sqlAscii(item.overall_label)},${sqlText(item.curated_description)},${sqlText(JSON.stringify(item.annotations))},${item.source_live_session_id ? `CONVERT(uniqueidentifier,${sqlAscii(item.source_live_session_id)})` : 'NULL'},'PENDING');`).join('\n')}
INSERT dbo.AuditEvent(user_id,action_code,entity_type,entity_id,detail) VALUES(${user.user_id},'EVALUATION_STARTED','EvaluationRun',CONVERT(nvarchar(80),@id),${sqlText(`Dataset ${snapshot.dataset.dataset_id}; TEST ${test.length} foto; model ${modelName}; snapshot ${runSnapshot.snapshot_sha256}`)});
END; COMMIT TRANSACTION; SELECT @id AS evaluation_run_id,@state AS dataset_status FOR JSON PATH,WITHOUT_ARRAY_WRAPPER;`);
    if (!result?.evaluation_run_id) throw httpError(409, 'Dataset berubah atau tidak lagi disetujui. Muat ulang sebelum memulai evaluasi.');
    return { evaluation_run_id: result.evaluation_run_id, total_items: test.length, test, snapshot_sha256: runSnapshot.snapshot_sha256 };
  }

  async function processRun(run, modelName, hazards, state) {
    const id = run.evaluation_run_id;
    try {
      await writeSql(`UPDATE dbo.EvaluationRun SET status='RUNNING',started_at=SYSUTCDATETIME() WHERE evaluation_run_id=${id} AND status='QUEUED';`);
      for (let index = 0; index < run.test.length; index++) {
        const cancellation = await jsonQuery(`SELECT cancellation_requested FROM dbo.EvaluationRun WHERE evaluation_run_id=${id} FOR JSON PATH,WITHOUT_ARRAY_WRAPPER;`);
        if (state.cancelled || cancellation?.cancellation_requested) { state.cancelled = true; break; }
        const item = run.test[index]; const ordinal = index + 1;
        await writeSql(`UPDATE dbo.EvaluationItem SET status='RUNNING' WHERE evaluation_run_id=${id} AND ordinal=${ordinal};`);
        const started = Date.now(); let prediction = null, failure = '';
        try {
          const image = await imageBuffer(item);
          prediction = await analyzeWithOllama(image, modelName, { name: item.area_name, area_type: item.area_type }, hazards, { profile: 'hemat', signal: state.controller.signal, useExamples:false });
        } catch (error) { failure = text(error.message || 'Model belum dapat memeriksa foto.', 700); }
        if (state.cancelled || state.controller.signal.aborted) { state.cancelled = true; break; }
        const elapsed = Math.max(0, Date.now() - started);
        await writeSql(`SET XACT_ABORT ON; BEGIN TRANSACTION; UPDATE dbo.EvaluationItem SET status='${prediction ? 'COMPLETED' : 'FAILED'}',predicted_status=${prediction ? sqlAscii(prediction.status) : 'NULL'},summary=${prediction ? sqlText(text(prediction.summary)) : 'NULL'},latency_ms=${elapsed},error_message=${failure ? sqlText(failure) : 'NULL'},completed_at=SYSUTCDATETIME() WHERE evaluation_run_id=${id} AND ordinal=${ordinal}; UPDATE dbo.EvaluationRun SET completed_items=(SELECT COUNT(*) FROM dbo.EvaluationItem WHERE evaluation_run_id=${id} AND status IN('COMPLETED','FAILED')) WHERE evaluation_run_id=${id}; COMMIT TRANSACTION;`);
      }
      const cancellation = await jsonQuery(`SELECT cancellation_requested FROM dbo.EvaluationRun WHERE evaluation_run_id=${id} FOR JSON PATH,WITHOUT_ARRAY_WRAPPER;`);
      state.cancelled ||= Boolean(cancellation?.cancellation_requested);
      if (state.cancelled) await writeSql(`UPDATE dbo.EvaluationItem SET status='CANCELLED',error_message=N'Evaluasi dibatalkan pengguna.',completed_at=SYSUTCDATETIME() WHERE evaluation_run_id=${id} AND status IN('PENDING','RUNNING');`);
      const items = await getEvaluationItems(id); const metrics = metricsFor(items, run.total_items);
      await writeSql(`UPDATE dbo.EvaluationRun SET status='${state.cancelled ? 'CANCELLED' : 'COMPLETED'}',completed_items=${metrics.completed_items},metrics_json=${sqlText(JSON.stringify(metrics))},finished_at=SYSUTCDATETIME() WHERE evaluation_run_id=${id};`);
    } catch (error) {
      console.error('[evaluation] Background run stopped:', id, text(error.message, 240));
      try {
        await writeSql(`UPDATE dbo.EvaluationItem SET status='INTERRUPTED',error_message=N'Evaluasi berhenti sebelum item selesai.',completed_at=SYSUTCDATETIME() WHERE evaluation_run_id=${id} AND status IN('PENDING','RUNNING');`);
        const items = await getEvaluationItems(id); const metrics = metricsFor(items, run.total_items);
        await writeSql(`UPDATE dbo.EvaluationRun SET status='FAILED',error_message=${sqlText(text(error.message, 700))},completed_items=${metrics.completed_items},metrics_json=${sqlText(JSON.stringify(metrics))},finished_at=SYSUTCDATETIME() WHERE evaluation_run_id=${id};`);
      } catch (databaseError) { console.error('[evaluation] Pending state will be recovered on restart:', id, text(databaseError.message, 240)); }
    } finally { running.delete(id); }
  }

  async function startEvaluation(body, user) {
    allowed(user);
    const id = intValue(body.dataset_id, 'Dataset'); const modelName = text(body.model_name, 120);
    const models = await listOllamaVisionModels();
    if (!models.some(model => model.name === modelName)) throw httpError(400, 'Pilih model visi lokal yang tersedia.');
    const snapshot = await datasetSnapshot(id);
    const hazards = await jsonQuery("SELECT hazard_type_id,code,name,area_type,description,default_severity,recommended_action FROM dbo.HazardType WHERE is_active=1 OR code='POTENSI_LAINNYA' ORDER BY hazard_type_id FOR JSON PATH;") || [];
    if (!hazards.length) throw httpError(409, 'Katalog kategori bahaya belum tersedia.');
    let acknowledge, refuse;
    const accepted = new Promise((resolve, reject) => { acknowledge = resolve; refuse = reject; });
    try {
      const background = withInferenceLock(user.user_id, async () => {
        let run;
        try { run = await createRun(snapshot, modelName, hazards, user); }
        catch (error) { refuse(error); throw error; }
        const state = { cancelled: false, controller: new AbortController() }; running.set(run.evaluation_run_id, state);
        acknowledge({ evaluation_run_id: run.evaluation_run_id, status: 'QUEUED', total_items: run.total_items, completed_items: 0, snapshot_sha256: run.snapshot_sha256 });
        await processRun(run, modelName, hazards, state);
      });
      Promise.resolve(background).catch(error => { refuse(error); });
    } catch (error) { refuse(error); }
    return accepted;
  }

  async function handle(request, response, url, user) {
    const method = request.method, pathname = url.pathname; let match;
    if (method === 'POST' && (match = pathname.match(/^\/api\/analyses\/(\d+)\/dataset$/))) {
      sendJson(response, 201, await promote(intValue(match[1], 'Pemeriksaan'), await objectBody(request), user)); return true;
    }
    if (method === 'POST' && (match = pathname.match(/^\/api\/datasets\/(\d+)\/export$/))) {
      const id = intValue(match[1], 'Dataset');
      const exportJob = async () => exportDataset(id, await objectBody(request), user, response);
      if (ctx.withDatasetReadLock) await ctx.withDatasetReadLock(id, exportJob);
      else await exportJob();
      return true;
    }
    if (method === 'GET' && pathname === '/api/evaluations') {
      const runs = await jsonQuery(`${runSelect.replace('SELECT ', 'SELECT TOP(100) ')} ${user.role === 'admin' ? '' : `WHERE owner_user_id=${user.user_id}`} ORDER BY created_at DESC,evaluation_run_id DESC FOR JSON PATH;`) || [];
      sendJson(response, 200, { runs: runs.map(run => ({ ...run, metrics: parseJson(run.metrics, null) })) }); return true;
    }
    if (method === 'POST' && pathname === '/api/evaluations') {
      const body = await objectBody(request), id = intValue(body.dataset_id, 'Dataset');
      const evaluationJob = () => startEvaluation(body, user);
      const accepted = ctx.withDatasetReadLock ? await ctx.withDatasetReadLock(id, evaluationJob) : await evaluationJob();
      sendJson(response, 202, accepted); return true;
    }
    if (method === 'GET' && (match = pathname.match(/^\/api\/evaluations\/(\d+)$/))) {
      const id = intValue(match[1], 'Evaluasi'), run = await getRun(id, user), items = await getEvaluationItems(id);
      sendJson(response, 200, { run, items, metrics: parseJson(run.metrics, null) || metricsFor(items, run.total_items) }); return true;
    }
    if (method === 'POST' && (match = pathname.match(/^\/api\/evaluations\/(\d+)\/cancel$/))) {
      const id = intValue(match[1], 'Evaluasi'), run = await getRun(id, user);
      if (terminal.includes(run.status)) { sendJson(response, 200, { ok: true, status: run.status, cancel_requested: false }); return true; }
      await writeSql(`UPDATE dbo.EvaluationRun SET cancellation_requested=1 WHERE evaluation_run_id=${id} AND status IN('QUEUED','RUNNING');`);
      const state = running.get(id); if (state) { state.cancelled = true; state.controller.abort(); }
      await audit(user.user_id, 'EVALUATION_CANCEL_REQUESTED', 'EvaluationRun', id, 'Pengguna meminta penghentian evaluasi.');
      sendJson(response, 202, { ok: true, cancel_requested: true }); return true;
    }
    return false;
  }

  handle.recoverEvaluations = async () => {
    // Root calls once on startup, after migrations. Never resume a partially
    // completed benchmark silently with a changed model or test snapshot.
    await writeSql(`SET XACT_ABORT ON; BEGIN TRANSACTION; UPDATE i SET status=CASE WHEN r.cancellation_requested=1 THEN 'CANCELLED' ELSE 'INTERRUPTED' END,error_message=N'Server dimulai ulang sebelum evaluasi selesai.',completed_at=SYSUTCDATETIME() FROM dbo.EvaluationItem i JOIN dbo.EvaluationRun r ON r.evaluation_run_id=i.evaluation_run_id WHERE r.status IN('QUEUED','RUNNING') AND i.status IN('PENDING','RUNNING'); UPDATE dbo.EvaluationRun SET status=CASE WHEN cancellation_requested=1 THEN 'CANCELLED' ELSE 'INTERRUPTED' END,error_message=N'Server dimulai ulang. Mulai evaluasi baru untuk menjalankan snapshot TEST dari awal.',finished_at=SYSUTCDATETIME() WHERE status IN('QUEUED','RUNNING'); COMMIT TRANSACTION;`);
  };
  // The local training service uses the same frozen, verified export as downloads.
  // Destination paths are supplied by the service, never by an HTTP request.
  handle.prepareTrainingExport = async (id, destination, user) => {
    allowed(user);
    const { manifest, entries, createdAt } = await buildExport(id, 'yolo', true);
    const output = createWriteStream(destination, { flags: 'wx' });
    const completed = finished(output);
    completed.catch(() => {});
    try {
      await writeZip(output, entries, createdAt);
      await completed;
    } catch (error) { output.destroy(); await completed.catch(() => {}); throw error; }
    await audit(user.user_id, 'TRAINING_SNAPSHOT_CREATED', 'Dataset', id, manifest.snapshot_sha256);
    return manifest;
  };
  return handle;
}
