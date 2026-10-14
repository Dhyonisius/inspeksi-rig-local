import { spawn } from 'node:child_process';
import path from 'node:path';

export const inferenceProfiles = Object.freeze({
  hemat: Object.freeze({ name: 'hemat', max_edge: 768, num_predict: 768, max_findings: 4, timeout_ms: 180000 }),
  detail: Object.freeze({ name: 'detail', max_edge: 1024, num_predict: 1280, max_findings: 8, timeout_ms: 180000 }),
});

export function inferenceProfile(value = 'hemat') {
  const name = String(value || 'hemat').toLowerCase();
  if (!Object.hasOwn(inferenceProfiles, name)) throw Object.assign(new Error('Pilih profil Hemat atau Detail.'), { status: 400, code: 'PERFORMANCE_PROFILE' });
  return inferenceProfiles[name];
}

export function createInferenceImage({ root, python }) {
  return function prepare(buffer, { profile = 'hemat', signal } = {}) {
    const settings = inferenceProfile(profile);
    if (!Buffer.isBuffer(buffer) || buffer.length < 1 || buffer.length > 12 * 1024 * 1024) throw Object.assign(new Error('Foto AI tidak valid atau terlalu besar.'), { status: 400 });
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawn(python, [path.join(root, 'scripts', 'prepare_inference.py'), String(settings.max_edge)], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      const chunks = [], errors = []; let bytes = 0, settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value);
      };
      const abort = () => { child.kill(); finish(signal.reason || new DOMException('Dibatalkan', 'AbortError')); };
      const timer = setTimeout(() => { child.kill(); finish(Object.assign(new Error('Pemrosesan salinan foto AI terlalu lama.'), { status: 503, code: 'IMAGE_TIMEOUT' })); }, 15000);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) { child.kill(); finish(new Error('Salinan foto AI terlalu besar.')); } else chunks.push(chunk); });
      child.stderr.on('data', chunk => { if (errors.reduce((sum, value) => sum + value.length, 0) < 4096) errors.push(chunk); });
      child.stdin.on('error', () => {});
      child.on('error', error => finish(error));
      child.on('close', code => {
        if (settled) return;
        if (code !== 0) return finish(Object.assign(new Error(Buffer.concat(errors).toString('utf8').trim().slice(0, 220) || 'Foto belum dapat disiapkan untuk AI.'), { status: 400 }));
        try {
          const output = Buffer.concat(chunks), split = output.indexOf(10);
          if (split < 0 || split > 1024) throw new Error('Metadata foto AI belum dapat dibaca.');
          const metadata = JSON.parse(output.subarray(0, split).toString('utf8')), image = output.subarray(split + 1);
          if (!Number.isSafeInteger(metadata.width) || !Number.isSafeInteger(metadata.height) || metadata.width < 1 || metadata.height < 1 || Math.max(metadata.width, metadata.height) > settings.max_edge || image[0] !== 255 || image[1] !== 216) throw new Error('Salinan foto AI belum sesuai profil.');
          finish(null, { buffer: image, width: metadata.width, height: metadata.height, profile: settings.name });
        } catch (error) { finish(error); }
      });
      child.stdin.end(buffer);
    });
  };
}

export function createTimedCache({ ttlMs = 30000, now = Date.now } = {}) {
  const cache = new Map(), pending = new Map(); let generation = 0;
  return {
    get(key, load) {
      const entry = cache.get(key);
      if (entry && entry.until > now()) return Promise.resolve(entry.value);
      if (pending.has(key)) return pending.get(key);
      const version = generation;
      const promise = Promise.resolve().then(load).then(value => {
        if (generation === version) cache.set(key, { value, until: now() + ttlMs });
        return value;
      }).finally(() => { if (pending.get(key) === promise) pending.delete(key); });
      pending.set(key, promise); return promise;
    },
    invalidate() { generation++; cache.clear(); pending.clear(); },
  };
}

// Bound child-process work so a page of thumbnails cannot spawn 24 sqlcmds.
export function createTaskLimiter({ concurrency = 3, maxPending = 96 } = {}) {
  const queue = []; let running = 0;
  function drain() {
    while (running < concurrency && queue.length) {
      const { job, resolve, reject } = queue.shift(); running++;
      Promise.resolve().then(job).then(resolve, reject).finally(() => { running--; drain(); });
    }
  }
  return function run(job) {
    if (queue.length >= maxPending) return Promise.reject(Object.assign(new Error('Penyimpanan lokal sedang sibuk. Tunggu sebentar lalu coba lagi.'), { status: 503, code: 'DATABASE_BUSY' }));
    return new Promise((resolve, reject) => { queue.push({ job, resolve, reject }); drain(); });
  };
}
