import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createInferenceImage } from './inference-profiles.js';
import { createVisionAnalyzer } from './vision-inference.js';
import { createVisionModelList } from './ollama-models.js';

const pbkdf2 = promisify(crypto.pbkdf2);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_IMAGE = 8 * 1024 * 1024;
const COOKIE = 'inspection_trial_session';
const AREAS = {
  rig: { name: 'Area rig', area_type: 'RIG' },
  kantor: { name: 'Area kantor', area_type: 'KANTOR' },
  umum: { name: 'Area kerja umum', area_type: 'KEDUANYA' },
};
const HAZARDS = [
  ['APD', 'Indikasi masalah APD', 'Perlengkapan yang tampak rusak atau pemakaian APD yang jelas keliru; jangan menebak kewajiban APD tanpa konteks.'],
  ['JATUH', 'Potensi jatuh atau tersandung', 'Tepi terbuka, lubang, penghalang jalur, atau kondisi ketinggian dengan bukti visual yang jelas.'],
  ['LISTRIK', 'Potensi bahaya listrik', 'Kabel terkelupas, sambungan terbuka atau kerusakan listrik yang tampak.'],
  ['MESIN', 'Potensi bahaya mesin', 'Bagian bergerak yang terbuka, potensi terjepit, atau kerusakan peralatan yang terlihat.'],
  ['KEBAKARAN', 'Potensi kebakaran', 'Api, asap atau sumber nyala dekat bahan mudah terbakar yang terlihat.'],
  ['AKSES', 'Akses atau tata letak bermasalah', 'Jalur akses terhalang atau penumpukan tidak stabil yang tampak.'],
  ['POTENSI_LAINNYA', 'Potensi bahaya lain', 'Bukti visual bahaya lain yang dapat dijelaskan secara spesifik.'],
].map(([code, name, description], i) => ({ code, name, description, hazard_type_id: i + 1, area_type: 'KEDUANYA', default_severity: 'SEDANG', recommended_action: 'Tinjau foto dan kondisi lapangan bersama petugas K3 sebelum mengambil tindakan.' }));

const clientScript = String.raw`
const $ = id => document.getElementById(id);
let previewUrl = '', busy = false, generation = 0;
function message(text) { $('message').textContent = text; }
async function call(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  const result = await response.json();
  if (!response.ok) { if (response.status === 401) showLogin(); throw new Error(result.error || 'Permintaan gagal.'); }
  return result;
}
function clearPhoto() {
  generation++;
  $('photo').value = '';
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = ''; $('preview').removeAttribute('src'); $('preview').hidden = true;
  $('result').hidden = true; $('findings').replaceChildren(); $('summary').textContent = '';
}
function showLogin() { $('login').hidden = false; $('inspection').hidden = true; clearPhoto(); }
async function showInspection() {
  $('login').hidden = true; $('inspection').hidden = false;
  $('analyze').disabled = true; $('modelStatus').textContent = 'Memeriksa layanan AI…';
  try {
    const data = await call('/api/models');
    $('model').replaceChildren();
    for (const item of data.models) { const option = document.createElement('option'); option.value = item.name; option.textContent = item.name; $('model').append(option); }
    $('modelStatus').textContent = data.models.length ? 'Model visi tersedia.' : 'Belum ada model visi di layanan AI. Foto belum dapat dianalisis.';
    $('analyze').disabled = !data.models.length;
  } catch (error) { $('modelStatus').textContent = error.message; }
}
$('login').addEventListener('submit', async event => {
  event.preventDefault(); $('loginButton').disabled = true; message('');
  try {
    await call('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: $('username').value, password: $('password').value }) });
    $('password').value = ''; await showInspection();
  } catch (error) { message(error.message); }
  finally { $('loginButton').disabled = false; }
});
$('photo').addEventListener('change', () => {
  generation++; $('result').hidden = true;
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = ''; $('preview').hidden = true;
  const file = $('photo').files[0];
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) { message('Ukuran foto maksimal 8 MiB.'); $('photo').value = ''; return; }
  previewUrl = URL.createObjectURL(file); $('preview').src = previewUrl; $('preview').hidden = false; message('');
});
$('inspection').addEventListener('submit', async event => {
  event.preventDefault(); if (busy) return;
  const file = $('photo').files[0]; if (!file) { message('Pilih foto terlebih dahulu.'); return; }
  const requestGeneration = generation;
  busy = true; $('analyze').disabled = true; $('photo').disabled = true; $('result').hidden = true;
  message('AI sedang memeriksa foto. Proses dapat memerlukan hingga tiga menit.');
  try {
    const data = await call('/api/inspect?area=' + encodeURIComponent($('area').value) + '&model=' + encodeURIComponent($('model').value), { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream' }, body: file });
    if (requestGeneration !== generation || $('inspection').hidden) return;
    const labels = { POTENSI_TIDAK_AMAN: 'Ada indikasi tidak aman', TIDAK_TAMPAK_BAHAYA: 'Tidak tampak indikasi bahaya', TIDAK_PASTI: 'Tidak dapat dipastikan dari foto' };
    $('verdict').textContent = labels[data.status] || labels.TIDAK_PASTI;
    $('summary').textContent = data.summary;
    $('findings').replaceChildren();
    for (const finding of data.findings) { const li = document.createElement('li'); li.textContent = finding.hazard_name + ': ' + finding.description; $('findings').append(li); }
    $('result').hidden = false; message('Pemeriksaan selesai. Foto dan hasil tidak disimpan sebagai riwayat.');
  } catch (error) { if (requestGeneration === generation) { $('result').hidden = true; message('Foto belum berhasil dinilai: ' + error.message); } }
  finally { busy = false; $('analyze').disabled = !$('model').options.length; $('photo').disabled = false; }
});
$('logout').addEventListener('click', async () => {
  try { await call('/api/logout', { method: 'POST' }); showLogin(); message('Anda sudah keluar.'); }
  catch (error) { message(error.message); }
});
$('refreshModels').addEventListener('click', () => { if (!busy) void showInspection(); });
call('/api/me').then(showInspection).catch(() => {});
`;

const page = `<!doctype html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Inspeksi Foto</title>
<style>body{margin:0;background:#f1f5f5;color:#153238;font:16px system-ui,sans-serif}main{max-width:850px;margin:40px auto;padding:24px}header{margin-bottom:24px}h1{font-size:30px;margin-bottom:8px}section,form{background:white;border:1px solid #d7e3e4;border-radius:16px;padding:24px;margin-bottom:20px}label{display:block;font-weight:600;margin:16px 0 6px}input,select,button{box-sizing:border-box;font:inherit;border:1px solid #a8c1c5;border-radius:8px;padding:11px}input,select{width:100%}button{cursor:pointer;background:#006b70;color:white;margin-top:20px}button:disabled{opacity:.55;cursor:wait}.secondary{background:white;color:#006b70}img{display:block;max-width:100%;max-height:420px;margin-top:20px;border-radius:8px}.note{font-size:14px;color:#496166}#message{white-space:pre-wrap}li{margin:10px 0}[hidden]{display:none!important}</style></head>
<body><main><header><h1>Inspeksi Foto</h1><p>Unggah foto dan periksa indikasi visual risiko K3.</p><p class="note">Mode percobaan: foto dan hasil pemeriksaan tidak disimpan sebagai riwayat.</p></header>
<form id="login"><h2>Masuk</h2><label for="username">Nama pengguna</label><input id="username" autocomplete="username" required maxlength="80"><label for="password">Kata sandi</label><input id="password" type="password" autocomplete="current-password" required maxlength="160"><button id="loginButton">Masuk</button></form>
<form id="inspection" hidden><h2>Pemeriksaan baru</h2><label for="area">Area foto</label><select id="area"><option value="rig">Rig</option><option value="kantor">Kantor</option><option value="umum">Area kerja umum</option></select><label for="model">Model AI</label><select id="model"></select><p id="modelStatus" class="note"></p><button id="refreshModels" class="secondary" type="button">Periksa layanan AI</button><label for="photo">Foto JPG, PNG, atau WebP · maksimal 8 MiB</label><input id="photo" type="file" accept="image/jpeg,image/png,image/webp" required><img id="preview" alt="Foto yang dipilih" hidden><button id="analyze" disabled>Analisis foto</button> <button id="logout" type="button" class="secondary">Keluar</button></form>
<p id="message" role="status" aria-live="polite"></p><section id="result" hidden><h2 id="verdict"></h2><p id="summary"></p><ul id="findings"></ul><p class="note">Hasil adalah indikasi awal dari foto, bukan jaminan keselamatan atau keputusan kelayakan operasi. Kondisi yang tidak terlihat tetap memerlukan pemeriksaan petugas K3.</p></section></main><script src="/quick-inspection.js" defer></script></body></html>`;

export async function createInspectionServer({ env = process.env, analyze, listModels } = {}) {
  const username = String(env.INSPECTION_USERNAME || 'operator');
  const password = String(env.INSPECTION_PASSWORD || '');
  if (password.length < 16 || password.length > 160) throw new Error('INSPECTION_PASSWORD dari Secret wajib memiliki 16–160 karakter.');
  const appOrigin = new URL(env.APP_ORIGIN).origin;
  const production = env.NODE_ENV === 'production';
  if (production && !appOrigin.startsWith('https://')) throw new Error('APP_ORIGIN production wajib menggunakan HTTPS.');
  const baseUrl = String(env.OLLAMA_BASE_URL || '').replace(/\/$/, '');
  if (!baseUrl || !['http:', 'https:'].includes(new URL(baseUrl).protocol)) throw new Error('OLLAMA_BASE_URL wajib diisi dengan endpoint layanan AI.');
  const salt = crypto.randomBytes(16);
  const passwordHash = await pbkdf2(password, salt, 150000, 32, 'sha256');
  const sessions = new Map();
  let attempts = 0, resetAt = 0, loginBusy = false, inferenceBusy = false;
  listModels ||= createVisionModelList({ baseUrl });
  analyze ||= createVisionAnalyzer({ baseUrl, listModels, prepareImage: createInferenceImage({ root, python: env.PYTHON_EXE || 'python3' }) });
  const fail = (status, message) => Object.assign(new Error(message), { status });
  const headers = {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'; form-action 'self'",
  };
  function send(response, status, value, extra = {}) {
    if (response.destroyed || response.writableEnded) return;
    const data = typeof value === 'string' ? value : JSON.stringify(value);
    response.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8', ...extra }); response.end(data);
  }
  async function readBody(request, max) {
    const declared = Number(request.headers['content-length']);
    if (declared > max) { request.resume(); throw fail(413, 'Ukuran permintaan terlalu besar.'); }
    const parts = []; let size = 0;
    for await (const chunk of request) { size += chunk.length; if (size > max) throw fail(413, 'Ukuran permintaan terlalu besar.'); parts.push(chunk); }
    return Buffer.concat(parts, size);
  }
  const cookieValue = token => `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600${production ? '; Secure' : ''}`;
  function tokenFrom(request) { return String(request.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(COOKIE + '='))?.slice(COOKIE.length + 1) || ''; }
  const cleanup = setInterval(() => { for (const [key, expires] of sessions) if (expires < Date.now()) sessions.delete(key); }, 60000).unref();
  const server = http.createServer({ maxHeaderSize: 16384 }, async (request, response) => {
    try {
      const url = new URL(request.url, appOrigin), method = request.method;
      if (method === 'GET' && ['/livez', '/readyz'].includes(url.pathname)) return send(response, 200, { status: 'ready', mode: 'transient-inspection' });
      if (method === 'GET' && url.pathname === '/') return send(response, 200, page, { 'Content-Type': 'text/html; charset=utf-8' });
      if (method === 'GET' && url.pathname === '/quick-inspection.js') return send(response, 200, clientScript, { 'Content-Type': 'text/javascript; charset=utf-8' });
      if (method === 'POST' && request.headers.origin !== appOrigin) throw fail(403, 'Sumber permintaan tidak diizinkan.');
      if (method === 'POST' && url.pathname === '/api/login') {
        if (Date.now() >= resetAt) { attempts = 0; resetAt = Date.now() + 60000; }
        if (attempts >= 7 || loginBusy) throw fail(429, 'Terlalu banyak percobaan masuk. Tunggu satu menit.');
        attempts++; loginBusy = true;
        try {
          let body; try { body = JSON.parse((await readBody(request, 4096)).toString('utf8')); } catch (error) { if (error.status) throw error; throw fail(400, 'Permintaan login tidak valid.'); }
          if (!body || typeof body.password !== 'string' || body.password.length > 160 || typeof body.username !== 'string') throw fail(400, 'Isian login tidak valid.');
          const suppliedHash = await pbkdf2(body.password, salt, 150000, 32, 'sha256');
          const valid = crypto.timingSafeEqual(suppliedHash, passwordHash);
          if (!valid || body.username !== username) throw fail(401, 'Nama pengguna atau kata sandi tidak cocok.');
          if (sessions.size >= 64) throw fail(503, 'Terlalu banyak sesi aktif. Coba lagi nanti.');
          for (const [key, expires] of sessions) if (expires < Date.now()) sessions.delete(key);
          const token = crypto.randomBytes(32).toString('hex'); sessions.set(token, Date.now() + 3600000);
          return send(response, 200, { ok: true }, { 'Set-Cookie': cookieValue(token) });
        } finally { loginBusy = false; }
      }
      const token = tokenFrom(request);
      if (!sessions.has(token) || sessions.get(token) < Date.now()) throw fail(401, 'Silakan masuk terlebih dahulu.');
      if (method === 'GET' && url.pathname === '/api/me') return send(response, 200, { username });
      if (method === 'POST' && url.pathname === '/api/logout') {
        sessions.delete(token); return send(response, 200, { ok: true }, { 'Set-Cookie': cookieValue('').replace('Max-Age=3600', 'Max-Age=0') });
      }
      if (method === 'GET' && url.pathname === '/api/models') {
        try { return send(response, 200, { models: await listModels() }); }
        catch { throw fail(503, 'Layanan AI belum dapat dijangkau dari aplikasi.'); }
      }
      if (method === 'POST' && url.pathname === '/api/inspect') {
        if (inferenceBusy) { request.resume(); throw fail(409, 'AI sedang memeriksa foto lain. Coba lagi setelah selesai.'); }
        const areaKey = url.searchParams.get('area');
        if (!Object.hasOwn(AREAS, areaKey)) throw fail(400, 'Pilih area foto yang tersedia.');
        const area = AREAS[areaKey];
        inferenceBusy = true;
        const controller = new AbortController();
        response.once('close', () => { if (!response.writableEnded) controller.abort(); });
        try {
          const installed = await listModels().catch(() => { throw fail(503, 'Layanan AI belum dapat dijangkau. Foto belum dinilai.'); });
          const model = installed.find(x => x.name === url.searchParams.get('model'));
          if (!model) throw fail(503, 'Model visi yang dipilih belum tersedia.');
          const image = await readBody(request, MAX_IMAGE);
          if (!image.length) throw fail(400, 'Pilih foto terlebih dahulu.');
          let result;
          try { result = await analyze(image, model.name, area, HAZARDS, { profile: 'hemat', validatedModel: model, useExamples: false, signal: controller.signal }); }
          catch (error) { if (error.status === 400) throw error; throw fail(503, 'Analisis AI gagal atau melebihi waktu tunggu. Foto belum dinilai.'); }
          if (!['POTENSI_TIDAK_AMAN', 'TIDAK_TAMPAK_BAHAYA', 'TIDAK_PASTI'].includes(result?.status) || !Array.isArray(result.findings) || typeof result.summary !== 'string' || !result.summary.trim()) throw fail(503, 'Hasil AI tidak lengkap. Foto belum dapat dinilai.');
          return send(response, 200, { status: result.status, summary: result.summary, findings: result.findings, persisted: false });
        } finally { inferenceBusy = false; }
      }
      throw fail(404, 'Halaman tidak ditemukan.');
    } catch (error) {
      send(response, error.status || 500, { error: error.status ? error.message : 'Aplikasi belum dapat memproses permintaan.', assessed: false });
    }
  });
  server.requestTimeout = 210000;
  server.on('close', () => clearInterval(cleanup));
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = await createInspectionServer();
  server.listen(Number(process.env.PORT || 8080), process.env.HOST || '0.0.0.0', () => console.log('Inspeksi foto sementara aktif; tanpa database dan tanpa riwayat foto.'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 10000).unref(); });
}
