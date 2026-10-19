import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createDetectorRuntime } from './detector-runtime.js';

const phases = new Set(['VALIDATING', 'TRAINING', 'EVALUATING', 'EVALUATING_PHOTOS', 'EXPORTING']);
const pending = new Set(['PREPARING', 'RUNNING']);
const jobPattern = /^\d{8}T\d{6}-[a-f0-9]{12}$/;
const splits = ['TRAIN', 'VALIDATION', 'TEST'];
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const parsed = (value, fallback) => { try { return typeof value === 'string' ? JSON.parse(value) : value ?? fallback; } catch { return fallback; } };

function validateRigManifest(value) {
  if (value?.schema_version !== 1 || value.architecture !== 'yolov8_raw' || value.scope !== 'rig_hazards' || value.input_size !== 640 || value.model_file !== 'model.onnx'
    || !/^[a-f0-9]{64}$/.test(value.sha256 || '') || !Array.isArray(value.class_names) || !value.class_names.length || value.class_names.length > 100
    || !Array.isArray(value.class_map) || value.class_map.length !== value.class_names.length
    || value.class_map.some((row, index) => row.class_id !== index || !Number.isSafeInteger(row.hazard_type_id) || row.hazard_type_id < 1 || row.name !== value.class_names[index]
      || typeof row.name !== 'string' || !row.name || row.name.length > 160)) throw new Error('Manifest model rig tidak valid.');
  return value;
}

export function createRigTrainingApi(ctx, datasetTools) {
  const { root, privateDir, jsonQuery, sqlAscii, intValue, httpError, jsonBody, sendJson, audit, withInferenceLock, withDatasetReadLock, sanitizePhotoBinary } = ctx;
  const directory = path.join(privateDir, 'rig-training');
  const python = process.env.RIG_TRAINING_PYTHON_EXE || path.join(privateDir, 'detector-export-env', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const activePath = path.join(directory, 'active-model.json');
  let current = null, active = null, activeRuntime = null, changingModel = false;
  const allowed = user => { if (!['operator', 'admin'].includes(user.role)) throw httpError(403, 'Akun tidak dapat mengelola pelatihan.'); };
  const admin = user => { if (user.role !== 'admin') throw httpError(403, 'Pemilihan model aktif hanya tersedia untuk admin.'); };
  const jobDirectory = id => { if (!jobPattern.test(id || '')) throw httpError(400, 'ID pelatihan tidak valid.'); return path.join(directory, id); };
  const objectBody = async request => { const body = await jsonBody(request); if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'Isi permintaan harus berupa objek JSON.'); return body; };
  async function readJson(file) {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024) throw new Error('Berkas pelatihan tidak valid.');
    return JSON.parse(await fs.readFile(file, 'utf8'));
  }
  async function writeJson(file, value) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = file + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    await fs.writeFile(temp, JSON.stringify(value, null, 2), { flag: 'wx' });
    await fs.rename(temp, file);
  }
  async function save(job) { await writeJson(path.join(jobDirectory(job.id), 'job.json'), job); }
  async function getJob(id, user) {
    let job;
    try { job = await readJson(path.join(jobDirectory(id), 'job.json')); }
    catch (error) { if (error.status) throw error; throw httpError(404, 'Pelatihan tidak ditemukan.'); }
    if (job.id !== id || (user && user.role !== 'admin' && job.owner_user_id !== user.user_id)) throw httpError(404, 'Pelatihan tidak ditemukan.');
    return job;
  }
  const exposed = job => ({ id: job.id, dataset_id: job.dataset_id, dataset_name: job.dataset_name, owner_user_id: job.owner_user_id,
    status: job.status, stage: job.stage, epochs: job.epochs, progress: job.progress, created_at: job.created_at, finished_at: job.finished_at,
    error: job.error, metrics: job.metrics, per_class_metrics: job.per_class_metrics, photo_metrics: job.photo_metrics,
    class_map: job.class_map, split_counts: job.split_counts, snapshot_sha256: job.snapshot_sha256, active: active?.job_id === job.id });

  async function readiness(id) {
    const dataset = await jsonQuery(`SELECT dataset_id,name,version,status,dataset_kind FROM dbo.Dataset WHERE dataset_id=${id} FOR JSON PATH,WITHOUT_ARRAY_WRAPPER;`);
    if (!dataset || dataset.dataset_kind !== 'HAZARD') throw httpError(404, 'Dataset inspeksi tidak ditemukan.');
    const items = await jsonQuery(`SELECT di.dataset_item_id,di.split,di.overall_label,di.label_status,ia.license_verified,ia.license_name,ia.checksum,r.source_group_key,
      JSON_QUERY((SELECT an.hazard_type_id,h.name FROM dbo.Annotation an JOIN dbo.HazardType h ON h.hazard_type_id=an.hazard_type_id WHERE an.dataset_item_id=di.dataset_item_id FOR JSON PATH)) AS annotations
      FROM dbo.DatasetItem di JOIN dbo.ImageAsset ia ON ia.image_id=di.image_id LEFT JOIN dbo.DatasetTrainingReview r ON r.dataset_item_id=di.dataset_item_id WHERE di.dataset_id=${id} AND di.is_excluded=0 FOR JSON PATH;`) || [];
    const blockers = [], warnings = [], counts = Object.fromEntries(splits.map(split => [split, { photos: 0, risk: 0, normal: 0, boxes: 0 }]));
    const classes = new Map(), groups = new Map(), photos = new Map();
    const unverified = items.filter(item => item.label_status !== 'VERIFIED' || !item.license_verified || !String(item.license_name || '').trim()).length;
    if (!items.length) blockers.push('Dataset belum berisi foto.');
    if (dataset.status !== 'APPROVED') blockers.push('Dataset perlu diajukan untuk tinjauan dan disetujui.');
    if (unverified) blockers.push(`${unverified} foto perlu label dan izin yang terverifikasi.`);
    let uncertain = 0, invalid = 0, groupConflict = false;
    for (const item of items) {
      const annotations = parsed(item.annotations, []);
      const group = item.source_group_key || item.checksum;
      if ((groups.has(group) && groups.get(group) !== item.split) || (photos.has(item.checksum) && photos.get(item.checksum) !== item.split)) groupConflict = true;
      groups.set(group, item.split); photos.set(item.checksum, item.split);
      if (item.overall_label === 'UNCERTAIN') { uncertain++; continue; }
      if (!counts[item.split] || !Array.isArray(annotations)) { invalid++; continue; }
      counts[item.split].photos++;
      if (item.overall_label === 'RISK') { counts[item.split].risk++; if (!annotations.length) invalid++; }
      else if (item.overall_label === 'NO_LISTED_HAZARD_VISIBLE') { counts[item.split].normal++; if (annotations.length) invalid++; }
      else invalid++;
      for (const box of annotations) {
        counts[item.split].boxes++;
        if (!classes.has(box.hazard_type_id)) classes.set(box.hazard_type_id, { hazard_type_id: box.hazard_type_id, name: box.name, TRAIN: 0, VALIDATION: 0, TEST: 0 });
        classes.get(box.hazard_type_id)[item.split]++;
      }
    }
    if (invalid) blockers.push(`${invalid} foto memiliki label yang tidak sesuai dengan kotak bahaya.`);
    if (groupConflict) blockers.push('Satu kelompok atau foto identik masuk ke beberapa pembagian. Satukan melalui PDF & kelompok rig.');
    for (const split of splits) {
      if (!counts[split].photos || !counts[split].risk || !counts[split].boxes) blockers.push(`${split} perlu foto bahaya terverifikasi dengan kotak penanda.`);
      if (!counts[split].normal) warnings.push(`${split} belum mempunyai foto tanpa indikasi bahaya; pengukuran alarm keliru menjadi terbatas.`);
    }
    for (const category of classes.values()) {
      if (!category.TRAIN) blockers.push(`${category.name}: belum ada kotak pada TRAIN.`);
      if (!category.VALIDATION || !category.TEST) warnings.push(`${category.name}: belum dapat dinilai pada semua pembagian.`);
      if (category.TRAIN < 20) warnings.push(`${category.name}: baru ${category.TRAIN} kotak TRAIN. Jumlah ini belum membuktikan kecukupan data.`);
    }
    if (uncertain) warnings.push(`${uncertain} foto Belum pasti dikecualikan dari pelatihan YOLO.`);
    const runtimeInstalled = await fs.access(python).then(() => true, () => false);
    const weightInstalled = await fs.access(path.join(root, 'models/sh17-yolov8n/source-yolo8n.pt')).then(() => true, () => false);
    if (!runtimeInstalled || !weightInstalled) blockers.push('Runtime atau bobot awal pelatihan lokal belum tersedia.');
    return { dataset, total: items.length, verified: items.length - unverified, excluded_uncertain: uncertain,
      split_counts: counts, categories: [...classes.values()], blockers, warnings, can_train: blockers.length === 0, device: 'cpu' };
  }

  async function loadCandidate(id) {
    const run = jobDirectory(id), modelDir = path.join(run, 'runtime');
    const manifest = validateRigManifest(await readJson(path.join(modelDir, 'manifest.json')));
    const realDirectory = await fs.realpath(modelDir), realRoot = await fs.realpath(directory);
    const relative = path.relative(realRoot, realDirectory);
    if (relative !== path.join(id, 'runtime')) throw httpError(409, 'Lokasi model tidak valid.');
    const artifact = path.join(modelDir, 'model.onnx'), info = await fs.lstat(artifact);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 1024 || info.size > 32 * 1024 * 1024 || digest(await fs.readFile(artifact)) !== manifest.sha256) throw httpError(409, 'Berkas model berubah atau tidak valid.');
    return { manifest, modelDir };
  }

  async function runTraining(job, user, state) {
    try {
      const run = jobDirectory(job.id);
      const ready = await readiness(job.dataset_id);
      if (!ready.can_train) throw httpError(409, ready.blockers.join(' '));
      job.dataset_name = ready.dataset.name;
      job.split_counts = ready.split_counts;
      await save(job);
      const archive = path.join(run, 'dataset-export.zip');
      const snapshot = await withDatasetReadLock(job.dataset_id, () => datasetTools.prepareTrainingExport(job.dataset_id, archive, user));
      job.snapshot_sha256 = snapshot.snapshot_sha256;
      job.class_map = snapshot.class_map;
      if (state.cancelled) throw httpError(409, 'Pelatihan dibatalkan.');
      job.status = 'RUNNING'; job.stage = 'VALIDATING'; await save(job);
      await audit(user.user_id, 'RIG_TRAINING_STARTED', 'Dataset', job.dataset_id, `${job.id}; ${job.epochs} epoch; ${job.snapshot_sha256}`);
      await new Promise((resolve, reject) => {
        const child = spawn(python, [path.join(root, 'scripts/train-rig-model.py'), archive, '--epochs', String(job.epochs), '--run-dir', run, '--json-events', '--parent-pid', String(process.pid)],
          { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1', YOLO_AUTOINSTALL: 'False', CUDA_VISIBLE_DEVICES: '', OMP_NUM_THREADS: '2', MKL_NUM_THREADS: '2' } });
        state.child = child;
        let buffer = '', tail = '';
        const retain = text => { tail = (tail + text).slice(-6000); };
        child.stdout.on('data', chunk => {
          buffer += chunk.toString('utf8');
          if (buffer.length > 131072) buffer = buffer.slice(-65536);
          let newline;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
            if (!line.startsWith('RIG_EVENT ')) { retain(line + '\n'); continue; }
            const update = parsed(line.slice(10), null);
            if (!update || !phases.has(update.stage)) continue;
            job.stage = update.stage;
            job.progress = { epoch: update.epoch ?? job.progress?.epoch ?? 0, epochs: job.epochs, completed: update.completed ?? null, total: update.total ?? null };
            // Serialize journal writes; never overwrite a terminal status with a late epoch.
            state.writes = state.writes.then(() => save(job)).catch(() => {});
          }
        });
        child.stderr.on('data', chunk => retain(chunk.toString('utf8')));
        child.once('error', reject);
        child.once('close', code => {
          state.child = null;
          if (state.cancelled) reject(httpError(409, 'Pelatihan dibatalkan oleh pengguna.'));
          else if (code !== 0) reject(new Error(`Pelatihan berhenti (kode ${code}). ${tail.replace(/\u001b\[[0-9;]*m/g, '').trim().slice(-1300)}`));
          else resolve();
        });
      });
      await state.writes;
      const model = await readJson(path.join(jobDirectory(job.id), 'model-version.json'));
      const candidate = await loadCandidate(job.id);
      if (model.runtime_sha256 !== candidate.manifest.sha256 || model.dataset_snapshot !== job.snapshot_sha256) throw new Error('Hasil model tidak cocok dengan snapshot pelatihan.');
      job.metrics = model.metrics; job.per_class_metrics = model.per_class_metrics; job.photo_metrics = model.photo_metrics;
      job.status = 'COMPLETED'; job.stage = 'CANDIDATE'; job.finished_at = new Date().toISOString();
    } catch (error) {
      await state.writes;
      job.status = state.cancelled ? 'CANCELLED' : 'FAILED'; job.error = String(error.message).slice(0, 1600); job.finished_at = new Date().toISOString();
    } finally {
      await save(job).catch(error => console.error('[training] Status belum dapat disimpan:', error.message));
      if (current === state) current = null;
    }
  }

  async function handle(request, response, url, user) {
    let match;
    if (!url.pathname.startsWith('/api/rig-training')) return false;
    allowed(user);
    if (request.method === 'GET' && url.pathname === '/api/rig-training') {
      const names = await fs.readdir(directory).catch(() => []), jobs = [];
      for (const id of names.filter(name => jobPattern.test(name)).sort().reverse().slice(0, 100)) {
        try { jobs.push(exposed(await getJob(id, user))); } catch { /* Do not expose another user's jobs. */ }
      }
      sendJson(response, 200, { jobs, active_model: active ? { job_id: active.job_id, name: active.model_name, activated_at: active.activated_at, class_map: active.class_map } : null, training_busy: Boolean(current), device: 'cpu' }); return true;
    }
    if (request.method === 'GET' && (match = url.pathname.match(/^\/api\/rig-training\/readiness\/(\d+)$/))) {
      sendJson(response, 200, await readiness(intValue(match[1], 'Dataset'))); return true;
    }
    if (request.method === 'POST' && url.pathname === '/api/rig-training') {
      const body = await objectBody(request), id = intValue(body.dataset_id, 'Dataset'), epochs = intValue(body.epochs ?? 20, 'Epoch', 1, 200);
      if (body.confirm_training !== true) throw httpError(400, 'Konfirmasi pelatihan lokal diperlukan.');
      if (current || changingModel) throw httpError(409, 'Ada proses pelatihan atau pergantian model yang berjalan.');
      const ready = await readiness(id);
      if (!ready.can_train) throw httpError(409, ready.blockers.join(' '));
      const job = { id: new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + '-' + crypto.randomBytes(6).toString('hex'), owner_user_id: user.user_id,
        dataset_id: id, dataset_name: ready.dataset.name, epochs, status: 'PREPARING', stage: 'PREPARING', created_at: new Date().toISOString(), progress: { epoch: 0, epochs } };
      const state = { job, cancelled: false, child: null, writes: Promise.resolve() };
      await fs.mkdir(jobDirectory(job.id), { recursive: true }); await save(job);
      try {
        const background = withInferenceLock(user.user_id, async () => {
          if (current) throw httpError(409, 'Pelatihan lain sudah dimulai.');
          current = state;
          await runTraining(job, user, state);
        });
        void background.catch(async error => { job.status = 'FAILED'; job.error = error.message; job.finished_at = new Date().toISOString(); await save(job).catch(() => {}); });
      } catch (error) { job.status = 'FAILED'; job.error = error.message; await save(job); throw error; }
      sendJson(response, 202, exposed(job)); return true;
    }
    if (request.method === 'POST' && (match = url.pathname.match(/^\/api\/rig-training\/([\w-]+)\/cancel$/))) {
      const job = await getJob(match[1], user);
      if (current?.job.id === job.id && pending.has(job.status)) { current.cancelled = true; current.child?.kill(); }
      sendJson(response, 202, { ok: true, cancel_requested: current?.job.id === job.id }); return true;
    }
    if (request.method === 'POST' && (match = url.pathname.match(/^\/api\/rig-training\/([\w-]+)\/activate$/))) {
      admin(user);
      const body = await objectBody(request), job = await getJob(match[1], user);
      if (body.review_confirmed !== true) throw httpError(400, 'Periksa metrik dan konfirmasikan model untuk percobaan lokal.');
      if (job.status !== 'COMPLETED') throw httpError(409, 'Pelatihan belum selesai.');
      if (changingModel) throw httpError(409, 'Model sedang diganti.');
      changingModel = true;
      try {
        await withInferenceLock(user.user_id, async () => {
          const { manifest, modelDir } = await loadCandidate(job.id);
          const runtime = createDetectorRuntime({ root, modelDirectory: modelDir, validateManifest: validateRigManifest, scope: 'rig_hazards' });
          try { await runtime.load(); }
          catch (error) { runtime.stop(); throw httpError(409, error.message); }
          const selection = { job_id: job.id, model_name: manifest.model_name, sha256: manifest.sha256, class_map: manifest.class_map,
            activated_at: new Date().toISOString(), activated_by_user_id: user.user_id, purpose: 'LOCAL_TRIAL' };
          try {
            await audit(user.user_id, 'RIG_MODEL_SELECTED', 'Dataset', job.dataset_id, job.id + '; percobaan lokal');
            await writeJson(activePath, selection);
          } catch (error) { runtime.stop(); throw error; }
          activeRuntime?.stop(); activeRuntime = runtime; active = selection;
        });
      } finally { changingModel = false; }
      sendJson(response, 200, { active_model: active, purpose: 'LOCAL_TRIAL' }); return true;
    }
    if (request.method === 'POST' && url.pathname === '/api/rig-training/scan') {
      if (!active || !activeRuntime || changingModel) throw httpError(409, 'Pilih model yang sudah dilatih untuk percobaan lokal terlebih dahulu.');
      const form = await request.formData(), photo = await sanitizePhotoBinary(form.get('image'));
      const selection = active;
      const result = await withInferenceLock(user.user_id, () => activeRuntime.detect(photo.buffer));
      const detections = result.detections.map(row => ({ ...row, hazard_type_id: selection.class_map[row.class_id].hazard_type_id }));
      sendJson(response, 200, { model_name: selection.model_name, job_id: selection.job_id, status: detections.length ? 'POTENSI_TIDAK_AMAN' : 'TIDAK_PASTI',
        summary: detections.length ? 'Model mendeteksi kategori bahaya yang dilatih. Periksa kotaknya dan konfirmasi di lokasi.' : 'Tidak ada deteksi pada kategori yang dilatih. Hasil ini belum membuktikan foto aman.',
        detections, latency_ms: result.latency_ms, image_saved: false, dataset_added: false }); return true;
    }
    return false;
  }

  handle.initialize = async () => {
    await fs.mkdir(directory, { recursive: true });
    for (const id of (await fs.readdir(directory)).filter(name => jobPattern.test(name))) {
      const job = await getJob(id).catch(() => null);
      if (job && pending.has(job.status)) { job.status = 'INTERRUPTED'; job.error = 'Server dimulai ulang. Mulai pelatihan baru dari snapshot yang disetujui.'; job.finished_at = new Date().toISOString(); await save(job); }
    }
    const selection = await readJson(activePath).catch(() => null);
    if (selection) {
      try {
        const job = await getJob(selection.job_id);
        if (job.status !== 'COMPLETED') throw new Error('Pelatihan belum selesai.');
        const { manifest, modelDir } = await loadCandidate(job.id);
        if (selection.sha256 !== manifest.sha256) throw new Error('Checksum model aktif berubah.');
        active = { ...selection, class_map: manifest.class_map, model_name: manifest.model_name };
        activeRuntime = createDetectorRuntime({ root, modelDirectory: modelDir, validateManifest: validateRigManifest, scope: 'rig_hazards' });
      } catch (error) { console.error('[training] Model lokal belum dapat dipakai:', error.message); }
    }
  };
  handle.stop = () => { if (current) { current.cancelled = true; current.child?.kill(); } activeRuntime?.stop(); };
  handle.modelStatus = () => ({ available: Boolean(active && activeRuntime && !changingModel), model_name: active?.model_name || null });
  // Caller already holds the inference lock; never reacquire it here.
  handle.detect = async (buffer, hazards, options = {}) => {
    if (!active || !activeRuntime || changingModel) return { available: false, note: 'Model rig terlatih belum dipilih; Gemma tetap dapat digunakan.' };
    const selection = active;
    const ids = new Set(hazards.map(h => h.hazard_type_id));
    const trained=selection.class_map.map(row=>row.hazard_type_id).filter(id=>ids.has(id));
    if(!trained.length)return {available:false,note:'Model rig belum dilatih untuk kategori di area ini; usulan menggunakan Gemma.'};
    const result = await activeRuntime.detect(buffer,options);
    const detections = result.detections.map(row => ({ ...row, hazard_type_id: selection.class_map[row.class_id]?.hazard_type_id })).filter(row => ids.has(row.hazard_type_id));
    return { available: true, model_name: selection.model_name, job_id: selection.job_id, trained_hazard_ids:trained, detections, latency_ms: result.latency_ms };
  };
  return handle;
}
