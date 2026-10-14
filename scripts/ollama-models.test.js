import test from 'node:test';
import assert from 'node:assert/strict';
import { createVisionModelList } from './ollama-models.js';

const baseUrl = 'http://127.0.0.1:11434';
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function fixture(models, show = () => ({ capabilities: ['completion', 'vision'] })) {
  const calls = [];
  let time = 1000;
  let tags = models;
  const list = createVisionModelList({
    baseUrl, cacheMs: 100,
    now: () => time,
    fetch: async (url, options) => {
      assert.ok(options.signal instanceof AbortSignal);
      calls.push({ url, ...options });
      if (url === `${baseUrl}/api/tags`) return json({ models: tags });
      assert.equal(url, `${baseUrl}/api/show`);
      assert.equal(options.method, 'POST');
      assert.equal(options.headers['Content-Type'], 'application/json');
      const response = await show(JSON.parse(options.body).model);
      return response instanceof Response ? response : json(response);
    },
  });
  return { list, calls, setTime: value => { time = value; }, setTags: value => { tags = value; }, showCount: () => calls.filter(call => call.url.endsWith('/api/show')).length };
}

test('current tags capabilities select vision models without show calls', async () => {
  const f = fixture([
    { name: 'gemma3:4b', capabilities: ['completion', 'vision'], details: { family: 'gemma3', parameter_size: '4.3B' }, size: 123 },
    { name: 'text:latest', capabilities: ['completion'] },
    { model: 'vision:latest', capabilities: ['vision'] },
    null,
    {},
  ]);
  assert.deepEqual(await f.list(), [
    { name: 'gemma3:4b', family: 'gemma3', parameter_size: '4.3B', size: 123 },
    { name: 'vision:latest', family: '', parameter_size: '', size: 0 },
  ]);
  assert.equal(f.showCount(), 0);
});

test('legacy tags use show metadata and skip unavailable or text models', async () => {
  const f = fixture([
    { name: 'old-vision:latest', digest: 'v1' },
    { name: 'old-text:latest', digest: 't1' },
    { name: 'deleted:latest', digest: 'd1' },
    { name: 'no-capabilities:latest', digest: 'n1' },
    { name: 'failed:latest', digest: 'f1' },
  ], name => {
    if (name === 'old-text:latest') return { capabilities: ['completion'] };
    if (name === 'deleted:latest') return json({ error: 'missing' }, 404);
    if (name === 'no-capabilities:latest') return {};
    if (name === 'failed:latest') throw new Error('Local service unavailable');
    return { capabilities: ['completion', 'vision'] };
  });
  assert.deepEqual((await f.list()).map(model => model.name), ['old-vision:latest']);
  assert.equal(f.showCount(), 5);
});

test('show capabilities are reused before expiry and refreshed after expiry or model replacement', async () => {
  let capabilities = ['vision'];
  const f = fixture([{ name: 'local:latest', digest: 'first' }], () => ({ capabilities }));
  assert.equal((await f.list()).length, 1);
  f.setTime(1099);
  assert.equal((await f.list()).length, 1);
  assert.equal(f.showCount(), 1);
  f.setTime(1100);
  capabilities = ['completion'];
  assert.deepEqual(await f.list(), []);
  assert.equal(f.showCount(), 2);
  f.setTags([{ name: 'local:latest', digest: 'replacement' }]);
  capabilities = ['vision'];
  assert.equal((await f.list()).length, 1);
  assert.equal(f.showCount(), 3);
});

test('failed show requests are retried and never cached as a text-only result', async () => {
  let online = false;
  const f = fixture([{ name: 'local:latest', digest: 'same' }], () => online ? { capabilities: ['vision'] } : json({}, 503));
  assert.deepEqual(await f.list(), []);
  online = true;
  assert.equal((await f.list()).length, 1);
  assert.equal(f.showCount(), 2);
});

test('tag failures and malformed lists surface an error instead of an empty model list', async () => {
  for (const response of [json({}, 503), json({ models: null }), json({ models: {} })]) {
    const list = createVisionModelList({ baseUrl, fetch: async () => response });
    await assert.rejects(list(), /Ollama|Daftar model/);
  }
});
