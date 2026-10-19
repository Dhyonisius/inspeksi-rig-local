import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnnotationProposer, normalizeAnnotationProposal } from './annotation-proposals.js';

const hazards = [{ hazard_type_id: 9, code: 'CABLE', name: 'Kabel rusak', description: 'Isolasi terkelupas', area_type: 'GUDANG' }];
const box = { code: 'CABLE', x: .1, y: .2, width: .3, height: .4, confidence: .8 };
const output = (overrides = {}) => ({ label: 'RISK', description: 'Isolasi kabel tampak terkelupas.', boxes: [box], ...overrides });

test('valid suggestions retain boxes as unreviewed proposals', () => {
  const result = normalizeAnnotationProposal(output(), hazards);
  assert.equal(result.overall_label, 'RISK');
  assert.equal(result.annotations[0].hazard_type_id, 9);
  assert.equal(result.human_reviewed, false);
});

test('out-of-image, nonnumeric, weak, and unknown hazard boxes cannot support RISK', () => {
  for (const patch of [{ code: 'UNKNOWN' }, { x: -.1 }, { width: 1 }, { width: 0 }, { confidence: .5 }, { x: '0.1' }, { confidence: NaN }]) {
    const result = normalizeAnnotationProposal(output({ boxes: [{ ...box, ...patch }] }), hazards);
    assert.equal(result.overall_label, 'UNCERTAIN');
    assert.deepEqual(result.annotations, []);
  }
  assert.equal(normalizeAnnotationProposal(output({ boxes: [] }), hazards).overall_label, 'UNCERTAIN');
});

test('non-risk proposals have no hazard boxes and malformed replies are rejected', () => {
  for (const label of ['NO_LISTED_HAZARD_VISIBLE', 'UNCERTAIN']) assert.deepEqual(normalizeAnnotationProposal(output({ label }), hazards).annotations, []);
  for (const patch of [{ label: 'SAFE' }, { description: ' ' }, { boxes: null }]) assert.throws(() => normalizeAnnotationProposal(output(patch), hazards));
});

test('conflicting no-hazard label and boxes becomes uncertain, retaining the model label for review',()=>{
  const result=normalizeAnnotationProposal(output({label:'NO_LISTED_HAZARD_VISIBLE'}),hazards);
  assert.equal(result.overall_label,'UNCERTAIN');assert.equal(result.model_label,'NO_LISTED_HAZARD_VISIBLE');
  assert.ok(result.review_flags.includes('LABEL_BOX_CONFLICT'));assert.deepEqual(result.annotations,[]);assert.equal(result.human_reviewed,false);
});

test('empty no-hazard reply stays no-hazard, while risk without valid boxes carries a review reason',()=>{
  assert.equal(normalizeAnnotationProposal(output({label:'NO_LISTED_HAZARD_VISIBLE',boxes:[]}),hazards).overall_label,'NO_LISTED_HAZARD_VISIBLE');
  const result=normalizeAnnotationProposal(output({boxes:[{...box,width:2}]}),hazards);
  assert.equal(result.overall_label,'UNCERTAIN');assert.ok(result.review_flags.includes('NO_VALID_HAZARD_BOX'));assert.ok(result.review_flags.includes('BOXES_FILTERED'));
});

test('local model receives only the image and area-appropriate categories', async () => {
  let request;
  const propose = createAnnotationProposer({ listModels: async () => [{ name: 'other-vision' }, { name: 'gemma3:4b' }],
    prepareImage: async () => ({ buffer: Buffer.from('prepared-image') }),
    fetchImpl: async (url, options) => { request = { url, ...JSON.parse(options.body) }; return { ok: true, json: async () => ({ message: { content: JSON.stringify(output()) } }) }; } });
  const result = await propose(Buffer.from('photo'), { work_area_id: 7, name: 'Rig', area_type: 'GUDANG' },
    [...hazards, { hazard_type_id: 10, code: 'OFFICE_ONLY', area_type: 'KANTOR' }]);
  assert.equal(request.url, 'http://127.0.0.1:11434/api/chat');
  assert.equal(request.model, 'gemma3:4b');
  assert.equal(request.messages.length, 1);
  assert.deepEqual(request.messages[0].images, [Buffer.from('prepared-image').toString('base64')]);
  assert.doesNotMatch(request.messages[0].content, /OFFICE_ONLY/);
  assert.equal(result.work_area_id, 7);
  assert.equal(result.human_reviewed, false);
});

test('missing vision model and invalid model replies fail without inventing labels', async () => {
  const dependencies = { listModels: async () => [], prepareImage: async () => ({ buffer: Buffer.from('image') }) };
  await assert.rejects(createAnnotationProposer(dependencies)(Buffer.from('photo'), {}, hazards), { status: 503 });
  for (const content of ['bad json', '{}', JSON.stringify(output({ label: 'SAFE' }))]) {
    const propose = createAnnotationProposer({ ...dependencies, listModels: async () => [{ name: 'gemma3:4b' }],
      fetchImpl: async () => ({ ok: true, json: async () => ({ message: { content } }) }) });
    await assert.rejects(propose(Buffer.from('photo'), { area_type: 'GUDANG' }, hazards), { status: 503 });
  }
});
