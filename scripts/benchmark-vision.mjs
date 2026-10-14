import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createInferenceImage } from './inference-profiles.js';
import { createVisionAnalyzer } from './vision-inference.js';
import { createVisionModelList } from './ollama-models.js';
import { createPerformanceMonitor } from './performance-monitor.js';
import { createDetectorRuntime } from './detector-runtime.js';

// Explicit developer measurement, never imported by the server. Credentials
// come from the caller's environment and are never written to the report.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const app = process.env.BENCHMARK_APP_URL || 'http://127.0.0.1:3180';
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(app)) throw new Error('Pengukuran hanya memakai aplikasi lokal.');
const email = process.env.BENCHMARK_EMAIL, password = process.env.BENCHMARK_PASSWORD;
if (!email || !password) throw new Error('Isi BENCHMARK_EMAIL dan BENCHMARK_PASSWORD untuk akun lokal.');
const login = await fetch(`${app}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
if (!login.ok) throw new Error(`Login pengukuran gagal HTTP${login.status}.`);
const cookie = login.headers.get('set-cookie')?.split(';')[0];
async function get(route) { const response = await fetch(`${app}${route}`, { headers: { cookie } }); if (!response.ok) throw new Error(`${route}: HTTP${response.status}`); return response.json(); }
const [dashboard, areaData, hazardData] = await Promise.all([get('/api/dashboard'), get('/api/areas'), get('/api/hazard-types')]);
const ids = process.argv.find(value => value.startsWith('--ids='))?.slice(6).split(',').map(Number);
const count = Math.max(1, Math.min(3, Number(process.argv.find(value => value.startsWith('--count='))?.slice(8)) || 2));
const photos = ids?.length ? ids.map(analysis_id => ({ analysis_id })) : dashboard.recent.slice(0, count);
const prepareImage = createInferenceImage({ root, python: process.env.PYTHON_EXE || 'python' });
const listModels = createVisionModelList({ baseUrl: 'http://127.0.0.1:11434' });
const model = (await listModels()).find(item => item.name === (process.env.BENCHMARK_MODEL || 'gemma3:4b'));
if (!model) throw new Error('Model pengukuran tidak tersedia.');
const monitor = createPerformanceMonitor(), detector = createDetectorRuntime({ root });
const analyze = createVisionAnalyzer({ baseUrl: 'http://127.0.0.1:11434', listModels, prepareImage, monitor });
const samples = [];
try {
  for (const photo of photos.slice(0, 3)) {
    const detail = await get(`/api/analyses/${photo.analysis_id}`);
    const asset = detail.analysis;
    const area = areaData.areas.find(row => row.name === asset.area_name && row.area_type === asset.area_type);
    if (!area) throw new Error('Area aktif untuk foto tidak ditemukan.');
    const response = await fetch(`${app}/api/media/${asset.image_id}`, { headers: { cookie } });
    if (!response.ok) throw new Error('Foto asli tidak tersedia.');
    const binary = Buffer.from(await response.arrayBuffer());
    const beforeChecksum = crypto.createHash('sha256').update(binary).digest('hex');
    for (const profile of ['hemat', 'detail']) {
      const started = Date.now(), before = await monitor.snapshot();
      try {
        const preparedImage = await prepareImage(binary, { profile });
        const objects = await detector.detect(preparedImage.buffer);
        const result = await analyze(binary, model.name, area, hazardData.hazards, { profile, preparedImage, validatedModel: model });
        const after = await monitor.snapshot({ detector: await detector.status() });
        const row = { analysis_id: asset.analysis_id, original_name: asset.original_name, profile, total_ms: Date.now() - started,
          ...result.performance, status: result.status, summary: result.summary, findings: result.findings,
          detector: { latency_ms: objects.latency_ms, runtime_bytes: objects.runtime_bytes, object_count: objects.detections.length },
          before: { system: before.system, gpu: before.gpu }, after: { system: after.system, gpu: after.gpu }, source_sha256: beforeChecksum };
        samples.push(row); console.log(JSON.stringify({ analysis_id: row.analysis_id, profile, total_ms: row.total_ms, inference_ms: row.inference_ms, status: row.status, image: row.image, model_load_ms: row.model_load_ms }));
      } catch (error) { const row = { analysis_id: asset.analysis_id, profile, total_ms: Date.now() - started, error: error.message, source_sha256: beforeChecksum }; samples.push(row); console.log(JSON.stringify(row)); }
    }
    if (crypto.createHash('sha256').update(binary).digest('hex') !== beforeChecksum) throw new Error('Salinan foto asli berubah selama pengukuran.');
  }
  const report = { recorded_at: new Date().toISOString(), model_name: model.name,
    note: 'Manual same-photo latency measurement, without human reference labels. Not an accuracy benchmark. Detector timings are separate; VLM samples omit detector prompt hints for a fair profile comparison. First model load may be cold. No inspection or dataset writes.', samples };
  const output = path.join(root, 'docs', 'performance-measurement.json');
  await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ report: output, samples: samples.length }));
} finally {
  detector.stop(); monitor.close();
  await fetch(`${app}/api/auth/logout`, { method: 'POST', headers: { cookie } }).catch(() => {});
}
