import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createDetectorRuntime, SH17_CLASSES, validateDetectorManifest, validateDetections } from './detector-runtime.js';

const manifest = () => ({ schema_version: 1, architecture: 'yolov8_raw', scope: 'objects_only', input_size: 640, model_file: 'model.onnx', sha256: 'a'.repeat(64), class_names: [...SH17_CLASSES] });
const object = () => ({ class_id: 10, class_name: 'ignored', confidence: 0.9, box: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } });

test('requires the full official ordered SH17 class map, not generic COCO', () => {
  assert.equal(validateDetectorManifest(manifest()).class_names[10], 'helmet');
  assert.throws(() => validateDetectorManifest({ ...manifest(), class_names: ['person', 'car'] }), /SH17/);
  const wrong = manifest(); [wrong.class_names[10], wrong.class_names[12]] = [wrong.class_names[12], wrong.class_names[10]];
  assert.throws(() => validateDetectorManifest(wrong), /SH17/);
});

test('requires a static640 raw output ONNX model with checksum and object-only scope', () => {
  for (const patch of [{ input_size: 320 }, { scope: 'safety' }, { model_file: '../other.onnx' }, { sha256: 'broken' }, { architecture: 'yolov10' }])
    assert.throws(() => validateDetectorManifest({ ...manifest(), ...patch }), /SH17/);
});

test('normalizes canonical class names and permits a valid empty result', () => {
  assert.equal(validateDetections([object()])[0].class_name, 'helmet');
  assert.deepEqual(validateDetections([]), []);
});

test('rejects invalid scores, classes, boxes and overlarge responses', () => {
  for (const row of [{ ...object(), class_id: 80 }, { ...object(), confidence: NaN }, { ...object(), confidence: 1.1 }, { ...object(), box: { x: -0.1, y: 0, width: 0.2, height: 0.2 } },
    { ...object(), box: { x: 0.9, y: 0, width: 0.2, height: 0.2 } }, { ...object(), box: { x: 0, y: 0, width: 0, height: 0.2 } }]) assert.throws(() => validateDetections([row]));
  assert.throws(() => validateDetections(Array.from({ length: 21 }, object)));
});

test('missing model returns a clear unavailable status without launching Python', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'k3-detector-test-'));
  const runtime = createDetectorRuntime({ root: folder, python: 'python-that-must-not-run' });
  try {
    const status = await runtime.status();
    assert.equal(status.ready, false);
    assert.equal(status.loaded, false);
    assert.equal(status.device, 'cpu');
    assert.equal(status.code, 'DETECTOR_MODEL_MISSING');
  } finally { runtime.stop(); await fs.rmdir(folder); }
});

test('rejects an aborted or oversized input before loading any model', async () => {
  const runtime = createDetectorRuntime({ root: os.tmpdir() });
  await assert.rejects(runtime.detect(Buffer.from('x'), { signal: AbortSignal.abort() }), { name: 'AbortError' });
  await assert.rejects(runtime.detect(Buffer.alloc(8 * 1024 * 1024 + 1)), { code: 'DETECTOR_IMAGE_INVALID' });
  runtime.stop();
});
