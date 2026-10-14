import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const SH17_CLASSES = Object.freeze(['person', 'ear', 'ear-mufs', 'face', 'face-guard', 'face-mask', 'foot', 'tool', 'glasses', 'gloves', 'helmet', 'hands', 'head', 'medical-suit', 'shoes', 'safety-suit', 'safety-vest']);
const abortError = () => Object.assign(new Error('Pemeriksaan detektor dibatalkan.'), { name: 'AbortError', code: 'DETECTOR_CANCELLED' });
const detectorError = (message, code) => Object.assign(new Error(message), { code });

export function validateDetectorManifest(manifest) {
  if (!manifest || manifest.schema_version !== 1 || manifest.architecture !== 'yolov8_raw' || manifest.scope !== 'objects_only' || manifest.input_size !== 640 || manifest.model_file !== 'model.onnx'
    || !/^[a-f0-9]{64}$/.test(manifest.sha256 || '') || !Array.isArray(manifest.class_names) || manifest.class_names.length !== SH17_CLASSES.length
    || manifest.class_names.some((name, index) => name !== SH17_CLASSES[index])) throw detectorError('Model belum sesuai dengan 17 kelas SH17.', 'DETECTOR_MANIFEST_INVALID');
  return manifest;
}

export function validateDetections(detections, classes = SH17_CLASSES) {
  if (!Array.isArray(detections) || detections.length > 20) throw detectorError('Keluaran detektor tidak valid.', 'DETECTOR_OUTPUT_INVALID');
  return detections.map(row => {
    if (!Number.isInteger(row?.class_id) || row.class_id < 0 || row.class_id >= classes.length || !Number.isFinite(row.confidence) || row.confidence < 0 || row.confidence > 1)
      throw detectorError('Kelas atau skor detektor tidak valid.', 'DETECTOR_OUTPUT_INVALID');
    const { x, y, width, height } = row.box || {};
    if (![x, y, width, height].every(Number.isFinite) || x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1.000002 || y + height > 1.000002)
      throw detectorError('Kotak detektor tidak valid.', 'DETECTOR_OUTPUT_INVALID');
    return { class_id: row.class_id, class_name: classes[row.class_id], confidence: row.confidence, box: { x, y, width, height } };
  });
}

// Status probes and model checks are cached. The ONNX session starts only on
// detect(), uses CPU, and is released after two minutes without a request.
export function createDetectorRuntime({ root, python = process.env.DETECTOR_PYTHON_EXE, modelDirectory, validateManifest = validateDetectorManifest, scope = 'objects_only', idleMs = 120_000, requestTimeoutMs = 20_000, now = Date.now } = {}) {
  if (!root) throw new Error('Folder proyek dibutuhkan untuk detektor.');
  const projectRoot = path.resolve(root);
  const pythonExe = python || path.join(projectRoot, 'data', 'private', 'detector-runtime', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const modelDir = modelDirectory || path.join(projectRoot, 'models', 'sh17-yolov8n');
  const manifestPath = path.join(modelDir, 'manifest.json');
  const workerPath = path.join(projectRoot, 'scripts', 'detector_worker.py');
  let cachedModel = null, modelStamp = null, probeUntil = 0, probeResult = null, statusPending = null;
  let child = null, loaded = false, busy = false, idleTimer = null, serial = 0, initPromise = null, initResolve = null, initReject = null, pending = null;
  let runtimeBytes = null, lastError = null;
  const base = () => ({ ready: false, model_name: scope === 'rig_hazards' ? 'Detektor rig' : 'SH17 YOLOv8n', device: 'cpu', scope, loaded, busy, runtime_bytes: runtimeBytes });

  async function checkModel() {
    const info = await fs.stat(manifestPath);
    if (info.size > 32_768) throw detectorError('Manifest model terlalu besar.', 'DETECTOR_MANIFEST_INVALID');
    const artifact = path.join(modelDir, 'model.onnx');
    const artifactInfo = await fs.stat(artifact);
    if (artifactInfo.size < 1024 || artifactInfo.size > 32 * 1024 * 1024) throw detectorError('Ukuran model tidak sesuai dengan detektor kecil.', 'DETECTOR_MODEL_INVALID');
    const realDir = await fs.realpath(modelDir), realModel = await fs.realpath(artifact);
    if (path.dirname(realModel) !== realDir || path.relative(projectRoot, realModel).startsWith('..')) throw detectorError('Lokasi model detektor tidak valid.', 'DETECTOR_MODEL_INVALID');
    const stamp = `${info.mtimeMs}:${info.size}:${artifactInfo.mtimeMs}:${artifactInfo.size}`;
    if (cachedModel && modelStamp === stamp) return cachedModel;
    const manifest = validateManifest(JSON.parse(await fs.readFile(manifestPath, 'utf8')));
    const checksum = crypto.createHash('sha256').update(await fs.readFile(artifact)).digest('hex');
    if (checksum !== manifest.sha256) throw detectorError('Checksum model berubah. Siapkan ulang detektor.', 'DETECTOR_MODEL_INVALID');
    cachedModel = { ...manifest, model_bytes: artifactInfo.size }; modelStamp = stamp;
    return cachedModel;
  }

  async function probe() {
    if (probeResult && now() < probeUntil) return probeResult;
    probeResult = await new Promise(resolve => {
      execFile(pythonExe, [workerPath, '--probe'], { windowsHide: true, timeout: 5000, maxBuffer: 16_384, env: { ...process.env, CUDA_VISIBLE_DEVICES: '' } }, (error, stdout) => {
        if (error) return resolve({ ready: false, reason: 'Runtime CPU detektor belum tersedia. Jalankan persiapan detektor.', code: 'DETECTOR_RUNTIME_MISSING' });
        try { const value = JSON.parse(String(stdout).trim()); resolve(value.ready ? { ready: true, versions: value.versions } : { ready: false, reason: 'Dependensi detektor belum tersedia.', code: 'DETECTOR_RUNTIME_MISSING' }); }
        catch { resolve({ ready: false, reason: 'Runtime CPU detektor belum dapat diperiksa.', code: 'DETECTOR_RUNTIME_MISSING' }); }
      });
    });
    probeUntil = now() + (probeResult.ready ? 60_000 : 10_000);
    return probeResult;
  }

  async function status() {
    if (statusPending) return statusPending;
    statusPending = (async () => {
      try {
        const manifest = await checkModel();
        const runtime = await probe();
        return { ...base(), ...runtime, model_name: manifest.model_name, model_bytes: manifest.model_bytes, reason: runtime.ready ? (loaded ? 'Detektor objek/APD CPU siap.' : 'Model tersedia; dimuat saat diaktifkan.') : runtime.reason,
          last_error: lastError, input_size: manifest.input_size, class_count: manifest.class_names.length, source_url: manifest.source_url, sha256: manifest.sha256 };
      } catch (error) {
        return { ...base(), code: error.code === 'ENOENT' ? 'DETECTOR_MODEL_MISSING' : (error.code || 'DETECTOR_MODEL_INVALID'), reason: error.code === 'ENOENT' ? 'Model detektor belum disiapkan.' : 'Model detektor belum valid. Jalankan persiapan detektor.' };
      }
    })();
    try { return await statusPending; } finally { statusPending = null; }
  }

  function stop(reason = detectorError('Detektor dihentikan.', 'DETECTOR_STOPPED')) {
    clearTimeout(idleTimer); idleTimer = null;
    const old = child; child = null; loaded = false; runtimeBytes = null;
    if (initReject) initReject(reason);
    initResolve = null; initReject = null; initPromise = null;
    if (pending) { const oldPending = pending; pending = null; oldPending.reject(reason); }
    if (old) { old.stdin.destroy(); old.kill(); }
  }

  function scheduleIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (!busy) stop(); }, idleMs);
    idleTimer.unref();
  }

  async function ensureWorker(signal) {
    if (signal?.aborted) throw abortError();
    if (loaded && child) return;
    if (!initPromise) {
      initPromise = new Promise((resolve, reject) => { initResolve = resolve; initReject = reject; });
      const instance = spawn(pythonExe, [workerPath, '--manifest', manifestPath], { cwd: projectRoot, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, CUDA_VISIBLE_DEVICES: '', PYTHONUNBUFFERED: '1' } });
      child = instance;
      let output = '';
      const fail = () => { if (child === instance) { lastError = 'Runtime detektor berhenti; dapat dicoba ulang.'; stop(detectorError(lastError, 'DETECTOR_RUNTIME_ERROR')); } };
      instance.on('error', fail);
      instance.on('exit', fail);
      instance.stdin.on('error', fail);
      instance.stderr.on('data', () => {}); // Drain without retaining private content.
      instance.stdout.on('data', chunk => {
        output += chunk.toString('utf8');
        if (output.length > 65_536) return fail();
        let newline;
        while ((newline = output.indexOf('\n')) >= 0) {
          const line = output.slice(0, newline).trim(); output = output.slice(newline + 1);
          let message;
          try { message = JSON.parse(line); } catch { return fail(); }
          if (message.event === 'ready') {
            loaded = true; runtimeBytes = Number.isFinite(message.runtime_bytes) ? message.runtime_bytes : null;
            initResolve?.(); initResolve = null; initReject = null; lastError = null;
          } else if (message.event === 'error') return fail();
          else if (pending && message.id === pending.id) {
            const current = pending; pending = null;
            runtimeBytes = Number.isFinite(message.runtime_bytes) ? message.runtime_bytes : runtimeBytes;
            if (message.error) current.reject(detectorError('Foto belum dapat diperiksa detektor.', 'DETECTOR_IMAGE_INVALID'));
            else current.resolve(message);
          }
        }
      });
    }
    const timeout = setTimeout(() => stop(detectorError('Detektor terlalu lama dimuat.', 'DETECTOR_TIMEOUT')), requestTimeoutMs);
    const cancelled = () => stop(abortError());
    signal?.addEventListener('abort', cancelled, { once: true });
    try { await initPromise; } finally { clearTimeout(timeout); signal?.removeEventListener('abort', cancelled); }
  }

  async function detect(buffer, { signal } = {}) {
    if (signal?.aborted) throw abortError();
    if (!Buffer.isBuffer(buffer) || buffer.length < 1 || buffer.length > 8 * 1024 * 1024) throw detectorError('Foto detektor harus berukuran maksimal 8 MB.', 'DETECTOR_IMAGE_INVALID');
    if (busy) throw detectorError('Detektor sedang memeriksa foto lain.', 'DETECTOR_BUSY');
    busy = true; clearTimeout(idleTimer);
    try {
      const available = await status();
      if (!available.ready) throw detectorError(available.reason, available.code);
      await ensureWorker(signal);
      if (signal?.aborted) throw abortError();
      const id = ++serial;
      const message = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => stop(detectorError('Detektor melewati batas waktu.', 'DETECTOR_TIMEOUT')), requestTimeoutMs);
        const cancelled = () => stop(abortError());
        const finish = callback => value => { clearTimeout(timeout); signal?.removeEventListener('abort', cancelled); callback(value); };
        pending = { id, resolve: finish(resolve), reject: finish(reject) };
        signal?.addEventListener('abort', cancelled, { once: true });
        child.stdin.write(`${JSON.stringify({ id, image: buffer.toString('base64') })}\n`, error => { if (error) stop(detectorError('Foto belum dapat dikirim ke detektor.', 'DETECTOR_RUNTIME_ERROR')); });
      });
      const detections = validateDetections(message.detections, cachedModel.class_names);
      if (!Number.isFinite(message.latency_ms) || message.latency_ms < 0) throw detectorError('Waktu detektor tidak valid.', 'DETECTOR_OUTPUT_INVALID');
      return { enabled: true, model_name: available.model_name, device: 'cpu', scope, detections, latency_ms: message.latency_ms, runtime_bytes: runtimeBytes };
    } finally { busy = false; if (child && loaded) scheduleIdle(); }
  }
  async function load() {
    if (busy) throw detectorError('Detektor sedang digunakan.', 'DETECTOR_BUSY');
    busy = true;
    try {
      const available = await status();
      if (!available.ready) throw detectorError(available.reason, available.code);
      await ensureWorker();
      return available;
    } finally { busy = false; if (child && loaded) scheduleIdle(); }
  }
  return { status, detect, stop, load };
}
