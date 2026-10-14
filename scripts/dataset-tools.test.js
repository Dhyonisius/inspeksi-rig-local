import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createDatasetTools } from './dataset-tools.js';

const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY1sAAAAASUVORK5CYII=', 'base64');
const user = { user_id: 1, role: 'admin' };
const httpError = (status, message) => Object.assign(new Error(message), { status });

class ArchiveResponse extends EventEmitter {
  constructor() { super(); this.chunks = []; this.destroyed = false; }
  writeHead(status, headers) { this.status = status; this.headers = headers; }
  write(buffer) { this.chunks.push(buffer); return true; }
  end() { this.finished = true; }
  destroy() { this.destroyed = true; }
}

function zipEntries(response) {
  assert.equal(response.status, 200);
  assert.equal(response.finished, true);
  assert.equal(response.destroyed, false);
  const zip = Buffer.concat(response.chunks);
  const footer = zip.length - 22;
  assert.equal(zip.readUInt32LE(footer), 0x06054b50);
  const count = zip.readUInt16LE(footer + 10);
  let position = zip.readUInt32LE(footer + 16);
  const entries = new Map();
  for (let index = 0; index < count; index++) {
    assert.equal(zip.readUInt32LE(position), 0x02014b50);
    const size = zip.readUInt32LE(position + 24);
    const nameLength = zip.readUInt16LE(position + 28);
    const extraLength = zip.readUInt16LE(position + 30);
    const commentLength = zip.readUInt16LE(position + 32);
    const localOffset = zip.readUInt32LE(position + 42);
    const name = zip.toString('utf8', position + 46, position + 46 + nameLength);
    assert.equal(zip.readUInt32LE(localOffset), 0x04034b50);
    const dataOffset = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
    entries.set(name, zip.subarray(dataOffset, dataOffset + size));
    position += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function withDataset(annotation, work) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lentera-dataset-'));
  assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'lentera-dataset-'));
  try {
    const privateDir = path.join(root, 'data', 'private');
    const uploads = path.join(privateDir, 'uploads');
    await fs.mkdir(uploads, { recursive: true });
    await fs.writeFile(path.join(uploads, 'fixture.png'), image);
    const item = {
      dataset_item_id: 1, image_id: 1, split: 'TRAIN', overall_label: 'RISK',
      label_status: 'VERIFIED', license_verified: true, license_name: 'Internal',
      file_uri: 'uploads/fixture.png', file_size_bytes: image.length,
      mime_type: 'image/png', original_name: 'fixture.png',
      checksum: crypto.createHash('sha256').update(image).digest('hex'),
      annotations: [annotation],
    };
    let auditCount = 0;
    const handler = createDatasetTools({
      root, privateDir, httpError, intValue: Number,
      jsonBody: request => request.json(),
      audit: async () => { auditCount++; },
      jsonQuery: async sql => {
        if (sql.includes('FROM dbo.Dataset WHERE')) return { dataset_id: 1, name: 'Geometry', version: '1', status: 'APPROVED', dataset_kind: 'HAZARD', created_at: '2026-10-04T00:00:00' };
        if (sql.includes('FROM dbo.DatasetItem di JOIN dbo.ImageAsset')) return [structuredClone(item)];
        if (sql.includes('FROM dbo.HazardType ORDER BY')) return [{ hazard_type_id: 1, code: 'FIXTURE', name: 'Fixture hazard' }];
        if (sql.includes('AS grouped ORDER BY')) return [];
        throw new Error(`Unexpected SQL in isolated export test: ${sql.slice(0, 80)}`);
      },
      analyzeWithOllama: async () => { throw new Error('Export must not run inference'); },
    });
    const exportAs = async format => {
      const url = new URL('http://127.0.0.1/api/datasets/1/export');
      const request = new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ format }) });
      const response = new ArchiveResponse();
      await handler(request, response, url, user);
      return { response, entries: zipEntries(response) };
    };
    await work({ exportAs, auditCount: () => auditCount, item });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function box(overrides = {}) {
  return { hazard_type_id: 1, name: 'Fixture hazard', note: 'Keep metadata', x: .2, y: .6, width: .8, height: .4, ...overrides };
}

test('JSONL export accepts SQL REAL edge rounding and clamps the stored snapshot inside the image', async () => {
  const annotation = box({ x: Math.fround(.2), y: Math.fround(.6), width: Math.fround(.8), height: Math.fround(.4) });
  assert.ok(annotation.x + annotation.width > 1);
  assert.ok(annotation.y + annotation.height > 1);
  await withDataset(annotation, async ({ exportAs, auditCount }) => {
    const { entries } = await exportAs('jsonl');
    const manifest = JSON.parse(entries.get('manifest.json'));
    const jsonl = JSON.parse(entries.get('dataset.jsonl').toString().trim());
    const expected = { ...annotation, width: 1 - annotation.x, height: 1 - annotation.y };
    assert.deepEqual(manifest.items[0].annotations, [expected]);
    assert.deepEqual(jsonl.target.annotations, [expected]);
    assert.equal(expected.x + expected.width, 1);
    assert.equal(expected.y + expected.height, 1);
    assert.deepEqual(entries.get(jsonl.image), image);
    assert.equal(auditCount(), 1);
  });
});

test('YOLO export uses the clamped geometry for boxes touching right and bottom edges', async () => {
  await withDataset(box({ x: Math.fround(.2), y: Math.fround(.6), width: Math.fround(.8), height: Math.fround(.4) }), async ({ exportAs }) => {
    const { entries } = await exportAs('yolo');
    const manifest = JSON.parse(entries.get('manifest.json'));
    const label = entries.get(manifest.items[0].archive_image.replace(/^images\//, 'labels/').replace(/\.png$/, '.txt')).toString().trim();
    const [classId, centerX, centerY, width, height] = label.split(' ').map(Number);
    assert.equal(classId, 0);
    assert.ok(centerX - width / 2 >= 0);
    assert.ok(centerY - height / 2 >= 0);
    assert.ok(centerX + width / 2 <= 1);
    assert.ok(centerY + height / 2 <= 1);
  });
});

test('interior geometry and annotation metadata remain exact in JSONL export', async () => {
  const annotation = box({ x: .1, y: .2, width: .3, height: .4 });
  await withDataset(annotation, async ({ exportAs }) => {
    const { entries } = await exportAs('jsonl');
    const record = JSON.parse(entries.get('dataset.jsonl').toString().trim());
    assert.deepEqual(record.target.annotations, [annotation]);
  });
});

test('genuine overflow, zero area, invalid numbers, and edge origins still block export before an audit', async () => {
  for (const annotation of [box({ width: .80001 }), box({ height: .40001 }), box({ width: 0 }), box({ x: -.01 }), box({ width: Infinity }), box({ x: 1, width: 1e-9 }), null]) {
    await withDataset(annotation, async ({ exportAs, auditCount }) => {
      await assert.rejects(exportAs('jsonl'), error => error.status === 409 && /Kotak kategori/.test(error.message));
      assert.equal(auditCount(), 0);
    });
  }
});
