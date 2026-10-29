// Uji jembatan memakai kode ASLI dari aplikasi (scripts/ollama-models.js),
// sehingga kompatibilitas terbukti, bukan diasumsikan.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createBridge } from './server.js';
import { createVisionModelList } from '../scripts/ollama-models.js';

const PUBLIC_MODEL = 'qwen-vl-internal';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

// Upstream palsu yang meniru gateway OpenAI-compatible.
function startUpstream() {
  const state = { calls: [], rejectSchema: false, content: '{"status":"TIDAK_TAMPAK_BAHAYA","findings":[],"summary":"aman"}' };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : {};
      state.calls.push({ path: req.url, body });
      if (req.url.startsWith('/v1/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ data: [{ id: PUBLIC_MODEL }, { id: 'teks-saja' }] }));
      }
      if (req.url.startsWith('/v1/chat/completions')) {
        if (state.rejectSchema && body.response_format?.type === 'json_schema') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'response_format json_schema tidak didukung' }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: state.content }, finish_reason: 'stop' }],
          usage: { completion_tokens: 42, prompt_tokens: 11 },
        }));
      }
      res.writeHead(404); res.end('{}');
    });
  });
  return { server, state };
}

async function setup() {
  const upstream = startUpstream();
  const upstreamPort = await listen(upstream.server);
  const bridge = createBridge({
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/v1`,
    upstreamModel: PUBLIC_MODEL,
    publicModel: PUBLIC_MODEL,
    log: false,
  });
  const bridgePort = await listen(bridge);
  const base = `http://127.0.0.1:${bridgePort}`;
  return { upstream, bridge, base, close: async () => { bridge.close(); upstream.server.close(); } };
}

test('aplikasi menemukan model vision lewat /api/tags + /api/show', async () => {
  const ctx = await setup();
  try {
    const listVisionModels = createVisionModelList({ baseUrl: ctx.base });
    const models = await listVisionModels();
    assert.equal(models.length, 1, 'harus tepat satu model vision terlihat');
    assert.equal(models[0].name, PUBLIC_MODEL);
    assert.equal(models[0].family, 'llm-bridge');
  } finally { await ctx.close(); }
});

test('/api/chat menerjemahkan gambar base64 ke format OpenAI', async () => {
  const ctx = await setup();
  try {
    const imageBase64 = Buffer.from('gambar-palsu').toString('base64');
    const schema = { type: 'object', properties: { status: { type: 'string' } }, required: ['status'] };
    const response = await fetch(`${ctx.base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: PUBLIC_MODEL,
        messages: [{ role: 'user', content: 'Periksa foto ini', images: [imageBase64] }],
        format: schema,
        options: { temperature: 0, num_ctx: 4096, num_predict: 1024 },
        stream: false,
        keep_alive: '5m',
      }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();

    // Bentuk jawaban harus persis yang dibaca aplikasi.
    assert.equal(typeof result.message.content, 'string');
    assert.deepEqual(JSON.parse(result.message.content), { status: 'TIDAK_TAMPAK_BAHAYA', findings: [], summary: 'aman' });
    assert.equal(result.eval_count, 42);
    assert.equal(result.done, true);

    const sent = ctx.upstream.state.calls.find(c => c.path.startsWith('/v1/chat/completions')).body;
    const parts = sent.messages[0].content;
    assert.ok(Array.isArray(parts), 'content harus berupa array untuk vision');
    assert.equal(parts[0].type, 'text');
    assert.equal(parts[1].type, 'image_url');
    assert.ok(parts[1].image_url.url.startsWith('data:image/jpeg;base64,'), 'gambar dikirim sebagai data URI');
    assert.equal(sent.temperature, 0);
    assert.equal(sent.max_tokens, 1024);
    assert.equal(sent.response_format.type, 'json_schema');
    assert.equal(sent.response_format.json_schema.schema.properties.status.type, 'string');
  } finally { await ctx.close(); }
});

test('turun ke json_object bila gateway menolak json_schema', async () => {
  const ctx = await setup();
  try {
    ctx.upstream.state.rejectSchema = true;
    const schema = { type: 'object', properties: { status: { type: 'string' } } };
    const response = await fetch(`${ctx.base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: PUBLIC_MODEL,
        messages: [{ role: 'user', content: 'Periksa', images: ['AAAA'] }],
        format: schema, options: { temperature: 0 }, stream: false,
      }),
    });
    assert.equal(response.status, 200);
    const attempts = ctx.upstream.state.calls.filter(c => c.path.startsWith('/v1/chat/completions'));
    assert.equal(attempts.length, 2, 'harus mencoba dua kali');
    assert.equal(attempts[0].body.response_format.type, 'json_schema');
    assert.equal(attempts[1].body.response_format.type, 'json_object');
    assert.ok(JSON.stringify(attempts[1].body.messages).includes('HANYA dengan satu objek JSON'), 'skema ditambahkan ke prompt');
  } finally { await ctx.close(); }
});

test('healthz melaporkan upstream dan model', async () => {
  const ctx = await setup();
  try {
    const response = await fetch(`${ctx.base}/healthz`);
    const body = await response.json();
    assert.equal(body.status, 'alive');
    assert.equal(body.model, PUBLIC_MODEL);
    assert.ok(body.upstream.includes('/v1'));
  } finally { await ctx.close(); }
});
