// Jembatan Ollama -> OpenAI-compatible.
//
// Aplikasi "Inspeksi Visual" berbicara protokol Ollama:
//   GET  /api/tags   -> daftar model + capabilities (harus ada "vision")
//   POST /api/show   -> detail capabilities per model
//   POST /api/chat   -> { model, messages:[{role,content,images:[base64]}], format, options, stream:false }
// Jawaban dibaca dari result.message.content (string JSON).
//
// LLM internal perusahaan biasanya OpenAI-compatible (/v1/chat/completions,
// /v1/models). Modul ini menerjemahkan kedua arah tanpa dependensi npm.
import http from 'node:http';

const DEFAULTS = {
  port: 8080,
  upstreamBaseUrl: '',          // mis. https://llm.internal/v1
  upstreamApiKey: '',           // dikirim sebagai Authorization: Bearer
  upstreamModel: '',            // nama model di sisi LLM internal
  publicModel: '',              // nama yang dilihat aplikasi (default = upstreamModel)
  imageMime: 'image/jpeg',
  timeoutMs: 240000,
  maxBodyBytes: 32 * 1024 * 1024,
  chatPath: '/chat/completions',
  modelsPath: '/models',
  log: true,
};

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error('Badan permintaan terlalu besar.'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('JSON tidak valid.'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

// Ubah pesan gaya Ollama (images: [base64]) menjadi gaya OpenAI (content: [...]).
function toOpenAiMessages(messages, imageMime) {
  return (Array.isArray(messages) ? messages : []).map(message => {
    const role = message.role || 'user';
    const text = message.content == null ? '' : String(message.content);
    const images = Array.isArray(message.images) ? message.images.filter(Boolean) : [];
    if (!images.length) return { role, content: text };
    const parts = [{ type: 'text', text }];
    for (const image of images) {
      parts.push({ type: 'image_url', image_url: { url: `data:${imageMime};base64,${image}` } });
    }
    return { role, content: parts };
  });
}

const SCHEMA_HINT = '\n\nBalas HANYA dengan satu objek JSON valid yang sesuai skema berikut, tanpa teks lain:\n';

export function createBridge(overrides = {}) {
  const cfg = { ...DEFAULTS, ...overrides };
  if (!cfg.upstreamBaseUrl) throw new Error('UPSTREAM_BASE_URL wajib diisi.');
  if (!cfg.upstreamModel) throw new Error('UPSTREAM_MODEL wajib diisi.');
  const publicModel = cfg.publicModel || cfg.upstreamModel;

  const base = cfg.upstreamBaseUrl.replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.upstreamApiKey) headers.Authorization = `Bearer ${cfg.upstreamApiKey}`;

  const log = (...args) => { if (cfg.log) console.log('[bridge]', ...args); };

  async function upstream(path, body) {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    const text = await response.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    return { status: response.status, ok: response.ok, body: parsed, raw: text };
  }

  async function handleChat(body, res) {
    const options = body.options || {};
    const messages = toOpenAiMessages(body.messages, cfg.imageMime);
    const payload = {
      model: cfg.upstreamModel,
      messages,
      stream: false,
      temperature: Number.isFinite(Number(options.temperature)) ? Number(options.temperature) : 0,
    };
    if (Number.isFinite(Number(options.num_predict)) && Number(options.num_predict) > 0) {
      payload.max_tokens = Number(options.num_predict);
    }
    const schema = body.format && typeof body.format === 'object' ? body.format : null;
    if (schema) {
      payload.response_format = { type: 'json_schema', json_schema: { name: 'hasil', schema, strict: false } };
    }

    let result = await upstream(cfg.chatPath, payload);

    // Banyak gateway belum mendukung json_schema. Turunkan ke json_object + instruksi skema.
    if (schema && (result.status === 400 || result.status === 422)) {
      log('json_schema ditolak upstream, mencoba json_object');
      payload.response_format = { type: 'json_object' };
      const lastUser = [...payload.messages].reverse().find(m => m.role === 'user');
      const hint = SCHEMA_HINT + JSON.stringify(schema);
      if (typeof lastUser.content === 'string') lastUser.content += hint;
      else lastUser.content.push({ type: 'text', text: hint });
      result = await upstream(cfg.chatPath, payload);
    }

    if (!result.ok) {
      log('upstream gagal', result.status, String(result.raw).slice(0, 300));
      return json(res, 502, { error: `LLM internal menjawab HTTP ${result.status}` });
    }

    const choice = result.body?.choices?.[0];
    const content = choice?.message?.content;
    const usage = result.body?.usage || {};
    if (typeof content !== 'string' || !content.trim()) {
      return json(res, 502, { error: 'Jawaban LLM internal tidak berisi teks.' });
    }

    return json(res, 200, {
      model: publicModel,
      created_at: new Date().toISOString(),
      message: { role: 'assistant', content },
      done: true,
      done_reason: choice?.finish_reason || 'stop',
      eval_count: Number(usage.completion_tokens) || 0,
      prompt_eval_count: Number(usage.prompt_tokens) || 0,
      load_duration: 0,
      total_duration: 0,
    });
  }

  async function handleTags(res) {
    let entries = [];
    try {
      const models = await upstream(cfg.modelsPath);
      if (models.ok && Array.isArray(models.body?.data)) {
        entries = models.body.data.map(item => String(item.id || '')).filter(Boolean);
      }
    } catch (error) {
      log('daftar model upstream tidak terbaca:', error.message);
    }
    // Nama publik selalu didaftarkan sebagai vision agar aplikasi pasti menemukannya.
    const names = [publicModel, ...entries.filter(name => name !== publicModel)];
    return json(res, 200, {
      models: names.map((name, index) => ({
        name,
        model: name,
        modified_at: new Date().toISOString(),
        size: 0,
        digest: `bridge-${index}`,
        details: { family: 'llm-bridge', parameter_size: '', quantization_level: '' },
        capabilities: name === publicModel ? ['completion', 'vision'] : ['completion'],
      })),
    });
  }

  function handleShow(body, res) {
    const name = String(body.model || body.name || '');
    const isVision = !name || name === publicModel;
    return json(res, 200, {
      model: name || publicModel,
      details: { family: 'llm-bridge', parameter_size: '', quantization_level: '' },
      capabilities: isVision ? ['completion', 'vision'] : ['completion'],
      model_info: {},
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (req.method === 'GET' && (path === '/healthz' || path === '/livez')) {
        return json(res, 200, { status: 'alive', upstream: base, model: publicModel });
      }
      if (req.method === 'GET' && path === '/api/tags') return await handleTags(res);
      if (req.method === 'GET' && path === '/api/version') {
        return json(res, 200, { version: 'bridge-1.0' });
      }
      if (req.method === 'POST' && path === '/api/show') {
        return handleShow(await readJson(req, cfg.maxBodyBytes), res);
      }
      if (req.method === 'POST' && path === '/api/chat') {
        return await handleChat(await readJson(req, cfg.maxBodyBytes), res);
      }
      if (req.method === 'POST' && path === '/api/generate') {
        return json(res, 501, { error: 'Endpoint /api/generate belum didukung jembatan ini.' });
      }
      return json(res, 404, { error: `Tidak ada rute ${req.method} ${path}` });
    } catch (error) {
      const status = error.status || 502;
      log('error', error.message);
      return json(res, status, { error: error.message });
    }
  });

  server.bridgeConfig = cfg;
  return server;
}

// Jalankan langsung: node server.js
if (process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`) {
  const server = createBridge({
    port: Number(process.env.PORT) || 8080,
    upstreamBaseUrl: process.env.UPSTREAM_BASE_URL || '',
    upstreamApiKey: process.env.UPSTREAM_API_KEY || '',
    upstreamModel: process.env.UPSTREAM_MODEL || '',
    publicModel: process.env.PUBLIC_MODEL || '',
    timeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS) || DEFAULTS.timeoutMs,
    imageMime: process.env.IMAGE_MIME || DEFAULTS.imageMime,
    log: process.env.LOG !== '0',
  });
  server.listen(Number(process.env.PORT) || 8080, process.env.HOST || '0.0.0.0', () => {
    const cfg = server.bridgeConfig;
    console.log(`[bridge] mendengarkan di :${cfg.port} -> ${cfg.upstreamBaseUrl} (model: ${cfg.publicModel})`);
  });
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}
