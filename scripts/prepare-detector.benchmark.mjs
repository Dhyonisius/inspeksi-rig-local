import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createDetectorRuntime } from './detector-runtime.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const argumentsList = process.argv.slice(2);
const count = Math.max(1, Math.min(10, Number(argumentsList.find(value => value.startsWith('--count='))?.split('=')[1]) || 3));
const repeats = Math.max(1, Math.min(5, Number(argumentsList.find(value => value.startsWith('--repeats='))?.split('=')[1]) || 2));
const sourceList = path.join(root, 'data/private/public-datasets/sh17/prepared/training/validation.txt');
const paths = (await fs.readFile(sourceList, 'utf8')).split(/\r?\n/).map(value => value.trim()).filter(Boolean).slice(0, count);
const detector = createDetectorRuntime({ root });
const results = [];
try {
  const status = await detector.status();
  if (!status.ready) throw new Error(status.reason);
  for (let repeat = 0; repeat < repeats; repeat++) {
    for (const image of paths) {
      const bytes = await fs.readFile(image);
      const started = performance.now();
      const result = await detector.detect(bytes);
      results.push({ sample: path.basename(image), repeat: repeat + 1, total_ms: Math.round(performance.now() - started), latency_ms: result.latency_ms,
        runtime_bytes: result.runtime_bytes, object_count: result.detections.length, classes: [...new Set(result.detections.map(row => row.class_name))] });
    }
  }
  const report = { recorded_at: new Date().toISOString(), model_name: status.model_name, sha256: status.sha256, device: 'cpu', input_size: 640, threads: 2,
    note: 'Sample runtime timings only; not an accuracy benchmark or a safety decision.', samples: results };
  const output = path.join(root, 'models/sh17-yolov8n/benchmark.json');
  await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(report, null, 2));
} finally { detector.stop(); }
