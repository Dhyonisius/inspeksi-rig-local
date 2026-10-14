import test from 'node:test';
import assert from 'node:assert/strict';
import { createPerformanceMonitor } from './performance-monitor.js';

function fixture() {
  let time = 1000, polls = 0;
  const monitor = createPerformanceMonitor({ maxSamples: 10, gpuCacheMs: 10_000, now: () => time,
    readMemory: () => ({ rss: 100, heapUsed: 20, heapTotal: 30, external: 40 }), readSystem: () => ({ total: 1000, free: 400 }),
    queryGpu: async () => { polls++; return { available: true, name: 'test', memory_used_mb: 100, memory_total_mb: 4000, utilization_percent: 20 }; } });
  return { monitor, setTime: value => { time = value; }, polls: () => polls };
}

test('keeps only bounded samples and avoids storing photo or prompt content', async () => {
  const f = fixture();
  for (let index = 0; index < 15; index++) f.monitor.record({ duration_ms: index * 100, profile: 'hemat', image: 'private', prompt: 'private' });
  const state = await f.monitor.snapshot();
  assert.equal(state.inference.count, 10);
  assert.equal(state.inference.last_ms, 1400);
  assert.equal(state.inference.median_ms, 950);
  assert.equal(state.inference.p95_ms, 1400);
  assert.equal(JSON.stringify(state).includes('private'), false);
});

test('groups VLM by profile and separates detector or live duration', async () => {
  const f = fixture();
  f.monitor.record({ stage: 'vlm', profile: 'hemat', duration_ms: 100 });
  f.monitor.record({ stage: 'vlm', profile: 'detail', duration_ms: 200 });
  f.monitor.record({ stage: 'detector', duration_ms: 10 });
  const state = await f.monitor.snapshot({ detector: { ready: true } });
  assert.equal(state.inference.count, 2);
  assert.equal(state.inference.by_profile.hemat.last_ms, 100);
  assert.equal(state.inference.by_stage.detector.last_ms, 10);
  assert.equal(state.detector.ready, true);
});

test('errors and cancellations are counted but do not bias successful percentiles', async () => {
  const f = fixture();
  f.monitor.record({ duration_ms: 100 });
  f.monitor.record({ duration_ms: 10, outcome: 'cancelled' });
  f.monitor.record({ duration_ms: 999, outcome: 'error' });
  f.monitor.record({ duration_ms: -1 });
  const state = await f.monitor.snapshot();
  assert.equal(state.inference.count, 3);
  assert.equal(state.inference.success_count, 1);
  assert.equal(state.inference.cancelled_count, 1);
  assert.equal(state.inference.error_count, 1);
  assert.equal(state.inference.median_ms, 100);
});

test('GPU queries are cached and concurrent snapshots share one poll', async () => {
  const f = fixture();
  await Promise.all([f.monitor.snapshot(), f.monitor.snapshot(), f.monitor.snapshot()]);
  assert.equal(f.polls(), 1);
  f.setTime(2000); await f.monitor.snapshot(); assert.equal(f.polls(), 1);
  f.setTime(12000); await f.monitor.snapshot(); assert.equal(f.polls(), 2);
});

test('labels process and device scopes and tolerates an unavailable GPU', async () => {
  const monitor = createPerformanceMonitor({ queryGpu: async () => { throw new Error('not installed'); } });
  const snapshot = await monitor.snapshot();
  assert.equal(snapshot.process.scope, 'server_node');
  assert.ok(snapshot.process.rss_bytes > 0);
  assert.ok(snapshot.system.total_bytes > 0);
  assert.equal(snapshot.gpu.available, false);
  monitor.close();
});
