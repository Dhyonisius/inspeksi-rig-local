import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTimedCache, createTaskLimiter, inferenceProfile, createInferenceImage } from './inference-profiles.js';
import { createVisionAnalyzer } from './vision-inference.js';

test('profile bounds and invalid names', () => {
  assert.equal(inferenceProfile().max_edge, 768); assert.equal(inferenceProfile('detail').max_edge, 1024);
  assert.throws(() => inferenceProfile('other'), { code: 'PERFORMANCE_PROFILE' });
});
test('cache deduplicates concurrent reads and expires', async () => {
  let now = 0, calls = 0; const cache = createTimedCache({ ttlMs: 10, now: () => now });
  const read = async () => ++calls;
  assert.deepEqual(await Promise.all([cache.get('key', read), cache.get('key', read)]), [1, 1]);
  assert.equal(await cache.get('key', read), 1); now = 11; assert.equal(await cache.get('key', read), 2);
});
test('invalidation blocks stale in-flight results and errors do not cache', async () => {
  const cache = createTimedCache(); let finish;
  const first = cache.get('key', () => new Promise(resolve => { finish = resolve; }));
  await Promise.resolve(); cache.invalidate(); finish('old'); await first;
  assert.equal(await cache.get('key', () => 'new'), 'new');
  await assert.rejects(cache.get('fail', () => { throw Error('broken'); }));
  assert.equal(await cache.get('fail', () => 'fixed'), 'fixed');
});
test('work queue caps concurrent work, propagates errors, and rejects excess', async () => {
  const run = createTaskLimiter({ concurrency: 1, maxPending: 1 }); let release;
  const first = run(() => new Promise(resolve => { release = resolve; }));
  const second = run(() => { throw Error('expected'); });
  await assert.rejects(run(() => 'excess'), { code: 'DATABASE_BUSY' });
  const rejected = assert.rejects(second, /expected/); release('done'); assert.equal(await first, 'done'); await rejected;
  assert.equal(await run(() => 'next'), 'next');
});
test('Pillow prepares distinct profile sizes and preserves original binary', async t => {
  const python = process.env.PYTHON_EXE;
  if (!python) return t.skip('Set PYTHON_EXE for the local decoder measurement.');
  const fixture = spawnSync(python, ['-c', 'from PIL import Image; import sys; Image.new("RGB", (1600,900), "blue").save(sys.stdout.buffer, format="PNG")']);
  assert.equal(fixture.status, 0); const original = Buffer.from(fixture.stdout);
  const prepare = createInferenceImage({ root: fileURLToPath(new URL('..', import.meta.url)), python });
  const small = await prepare(original, { profile: 'hemat' }), detail = await prepare(original, { profile: 'detail' });
  assert.equal(small.width, 768); assert.equal(detail.width, 1024); assert.deepEqual(original, fixture.stdout);
  const controller = new AbortController(); controller.abort(); assert.throws(() => prepare(original, { signal: controller.signal }), { name: 'AbortError' });
});
const hazards = [{ hazard_type_id: 1, code: 'POTENSI_LAINNYA', name: 'Lainnya', area_type: 'KANTOR', description: 'Bukti visual', default_severity: 'SEDANG', recommended_action: 'Periksa' }];
const result = parsed => ({ ok: true, json: async () => ({ message: { content: JSON.stringify(parsed) }, eval_count: 20, load_duration: 1000000 }) });
test('vision sends bounded copies and preserves uncertain object context', async t => {
  let body; t.mock.method(globalThis, 'fetch', async (url, options) => { body = JSON.parse(options.body); return result({ status: 'TIDAK_TAMPAK_BAHAYA', summary: 'Bersih', findings: [] }); });
  const rows = [], analyze = createVisionAnalyzer({ baseUrl: 'http://127.0.0.1:11434', listModels: async () => [{ name: 'gemma3:4b' }],
    prepareImage: async () => ({ buffer: Buffer.from('jpeg'), width: 768, height: 432 }), monitor: { record: row => rows.push(row) } });
  const output = await analyze(Buffer.from('original'), 'gemma3:4b', { name: 'Kantor', area_type: 'KANTOR' }, hazards,
    { detector: { enabled: true, detections: [{ class_name: 'helmet', confidence: .8, box: { x: 0, y: 0, width: .1, height: .1 } }] } });
  assert.equal(body.options.num_predict, 768); assert.equal(body.options.num_ctx, 4096); assert.equal(body.messages[0].images[0], Buffer.from('jpeg').toString('base64'));
  assert.match(body.messages[0].content, /bukan label keselamatan/); assert.equal(output.performance.image.width, 768); assert.equal(rows[0].outcome, 'ok');
});
test('contradictory hazard-free label is normalized to uncertain', async t => {
  t.mock.method(globalThis, 'fetch', async () => result({ status: 'TIDAK_TAMPAK_BAHAYA', summary: 'Ada kabel', findings: [{ code: 'POTENSI_LAINNYA', evidence: 'Kabel terkelupas', severity: 'TINGGI', confidence: 1.5 }] }));
  const analyze = createVisionAnalyzer({ baseUrl: 'http://127.0.0.1:11434', listModels: async () => [{ name: 'gemma3:4b' }], prepareImage: async () => ({ buffer: Buffer.from('jpeg'), width: 10, height: 10 }) });
  const output = await analyze(Buffer.from('original'), 'gemma3:4b', { name: 'Kantor', area_type: 'KANTOR' }, hazards);
  assert.equal(output.status, 'TIDAK_PASTI'); assert.equal(output.findings[0].confidence, 1);
});
