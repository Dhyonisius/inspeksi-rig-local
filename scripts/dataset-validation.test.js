import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDatasetAnnotations } from './dataset-validation.js';

const httpError = (status, message) => Object.assign(new Error(message), { status });
const intValue = value => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 2147483647) throw httpError(400, 'Kategori bahaya tidak valid.');
  return number;
};
const box = overrides => ({ hazard_type_id: 7, x: .2, y: .3, width: .4, height: .5, ...overrides });
const parse = (value, label = 'RISK') => parseDatasetAnnotations(JSON.stringify(value), label, intValue, httpError);
const invalid = error => error.status === 400;

test('valid annotations return numeric IDs and preserve normalized coordinates', () => {
  assert.deepEqual(parse([box({ hazard_type_id: '7' })]), [{ hazardId: 7, x: .2, y: .3, width: .4, height: .5 }]);
  assert.deepEqual(parse([], 'NO_LISTED_HAZARD_VISIBLE'), []);
  assert.deepEqual(parse([], 'UNCERTAIN'), []);
});

test('malformed JSON and nonarray annotation values produce localized input errors', () => {
  for (const raw of ['{', '[', 'null', '{}', '1', '"text"']) {
    assert.throws(() => parseDatasetAnnotations(raw, 'RISK', intValue, httpError), invalid);
  }
});

test('label constraints reject missing risk boxes and boxes on a no-hazard label', () => {
  assert.throws(() => parse([], 'RISK'), invalid);
  assert.throws(() => parse([box()], 'NO_LISTED_HAZARD_VISIBLE'), invalid);
});

test('null boxes, arrays, absent fields, and nonnumeric coordinate inputs produce 400', () => {
  for (const value of [null, [], {}, box({ x: null }), box({ y: undefined }), box({ width: '0.4' }), box({ height: false })]) {
    assert.throws(() => parse([value]), invalid);
  }
});

test('invalid hazard IDs and annotations exceeding the 80 box limit produce 400', () => {
  for (const hazard_type_id of [null, 0, -1, 1.5, 2147483648, 'bad']) assert.throws(() => parse([box({ hazard_type_id })]), invalid);
  assert.equal(parse(Array.from({ length: 80 }, () => box())).length, 80);
  assert.throws(() => parse(Array.from({ length: 81 }, () => box())), invalid);
});

test('rounding at right and bottom edges is clamped to valid positive dimensions', () => {
  const [edge] = parse([box({ x: .2, y: .3, width: .8000001, height: .7000001 })]);
  assert.equal(edge.x + edge.width, 1);
  assert.equal(edge.y + edge.height, 1);
  assert.ok(edge.width > 0 && edge.height > 0);
});

test('genuine overflow, nonpositive sizes, and negative origins produce 400', () => {
  for (const value of [box({ x: -.001 }), box({ y: -.001 }), box({ width: 0 }), box({ height: -1 }), box({ width: .80001 }), box({ height: .70001 })]) {
    assert.throws(() => parse([value]), invalid);
  }
});

test('origins on or beyond image edges are rejected before clamping would erase their area', () => {
  for (const value of [box({ x: 1, width: 1e-7 }), box({ y: 1, height: 1e-7 }), box({ x: 1.0000001, width: 1e-7 }), box({ y: 1.0000001, height: 1e-7 })]) {
    assert.throws(() => parse([value]), invalid);
  }
});
