import { execFile } from 'node:child_process';
import os from 'node:os';

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  if (fraction === 0.5 && sorted.length % 2 === 0) return Math.round((sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2);
  return Math.round(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]);
}

function summarize(rows) {
  const successful = rows.filter(row => row.outcome === 'ok');
  const durations = successful.map(row => row.duration_ms);
  return { count: rows.length, success_count: successful.length, error_count: rows.filter(row => row.outcome === 'error').length,
    cancelled_count: rows.filter(row => row.outcome === 'cancelled').length,
    last_ms: rows.length ? rows.at(-1).duration_ms : null, median_ms: percentile(durations, 0.5), p95_ms: percentile(durations, 0.95) };
}

// Measures the Node server, machine memory, and NVIDIA device. It does not
// mislabel Node RSS as the RAM used by Ollama or the detector child process.
export function createPerformanceMonitor({ maxSamples = 100, gpuCacheMs = 10_000, now = Date.now, readMemory = process.memoryUsage,
  readSystem = () => ({ total: os.totalmem(), free: os.freemem() }), queryGpu } = {}) {
  const limit = Math.max(10, Math.min(300, Math.trunc(maxSamples) || 100));
  const samples = [];
  let gpu = { available: false, reason: 'Belum diukur.' };
  let gpuUntil = 0;
  let gpuPending = null;
  let closed = false;
  const getGpu = queryGpu || (() => new Promise(resolve => {
    execFile('nvidia-smi', ['--query-gpu=name,memory.used,memory.total,utilization.gpu', '--format=csv,noheader,nounits'],
      { windowsHide: true, timeout: 2000, maxBuffer: 16_384 }, (error, stdout) => {
        if (error) return resolve({ available: false, reason: 'Metrik NVIDIA tidak tersedia.' });
        const values = String(stdout).trim().split('\n')[0]?.split(',').map(value => value.trim());
        if (!values || values.length !== 4) return resolve({ available: false, reason: 'Metrik NVIDIA belum dapat dibaca.' });
        const [name, used, total, utilization] = values;
        const memory_used_mb = Number(used), memory_total_mb = Number(total), utilization_percent = Number(utilization);
        if (![memory_used_mb, memory_total_mb, utilization_percent].every(Number.isFinite)) return resolve({ available: false, reason: 'Metrik NVIDIA belum dapat dibaca.' });
        resolve({ available: true, name: name.slice(0, 120), memory_used_mb, memory_total_mb, utilization_percent, scope: 'seluruh_perangkat' });
      });
  }));

  function record(input = {}) {
    if (closed || !Number.isFinite(input.duration_ms) || input.duration_ms < 0) return;
    const outcome = ['ok', 'error', 'cancelled'].includes(input.outcome) ? input.outcome : 'ok';
    samples.push({ at: new Date(now()).toISOString(), stage: String(input.stage || 'vlm').slice(0, 30), profile: String(input.profile || 'default').slice(0, 30),
      model: String(input.model || '').slice(0, 120), duration_ms: Math.round(input.duration_ms), outcome,
      image_width: Number.isInteger(input.image_width) ? input.image_width : null, image_height: Number.isInteger(input.image_height) ? input.image_height : null });
    if (samples.length > limit) samples.splice(0, samples.length - limit);
  }

  async function snapshot({ detector = null } = {}) {
    if (!closed && now() >= gpuUntil) {
      if (!gpuPending) gpuPending = Promise.resolve().then(getGpu).catch(() => ({ available: false, reason: 'Metrik NVIDIA tidak tersedia.' })).then(value => {
        gpu = { ...value, sampled_at: new Date(now()).toISOString() }; gpuUntil = now() + gpuCacheMs; return gpu;
      }).finally(() => { gpuPending = null; });
      await gpuPending;
    }
    const memory = readMemory();
    const system = readSystem();
    const vlm = samples.filter(row => row.stage === 'vlm');
    const by_profile = Object.fromEntries([...new Set(vlm.map(row => row.profile))].map(profile => [profile, summarize(vlm.filter(row => row.profile === profile))]));
    const by_stage = Object.fromEntries([...new Set(samples.map(row => row.stage))].map(stage => [stage, summarize(samples.filter(row => row.stage === stage))]));
    return { sampled_at: new Date(now()).toISOString(), sample_limit: limit,
      process: { rss_bytes: memory.rss, heap_used_bytes: memory.heapUsed, heap_total_bytes: memory.heapTotal, external_bytes: memory.external, scope: 'server_node' },
      system: { total_bytes: system.total, available_bytes: system.free, used_bytes: Math.max(0, system.total - system.free) },
      gpu: { ...gpu }, inference: { ...summarize(vlm), by_profile, by_stage, recent: samples.slice(-20).map(row => ({ ...row })) }, detector };
  }
  return { record, snapshot, close: () => { closed = true; samples.length = 0; } };
}
