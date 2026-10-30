// Uji DPoP (RFC 9449) dengan gateway tiruan yang MEMVERIFIKASI tanda tangan,
// htm, htu, ath, dan alur nonce. Bukan sekadar memeriksa header ada.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { createBridge } from './server.js';

const TOKEN = 'urbg_test_token_123';
const MODEL = 'urbuddy-qwen38-27b-fp8';

const b64url = v => Buffer.from(v).toString('base64url');
const athOf = token => crypto.createHash('sha256').update(token).digest('base64url');

function decodeJwt(jwt) {
  const [h, p, s] = jwt.split('.');
  return {
    header: JSON.parse(Buffer.from(h, 'base64url').toString('utf8')),
    payload: JSON.parse(Buffer.from(p, 'base64url').toString('utf8')),
    signingInput: `${h}.${p}`,
    signature: Buffer.from(s, 'base64url'),
  };
}

// Verifikasi proof seperti yang dilakukan server: tanda tangan, htm, htu, iat, ath.
export function verifyProof(jwt, { method, url, token, requireAth }) {
  const { header, payload, signingInput, signature } = decodeJwt(jwt);
  assert.equal(header.typ, 'dpop+jwt');
  assert.equal(header.alg, 'ES256');
  assert.ok(header.jwk && header.jwk.kty === 'EC' && header.jwk.crv === 'P-256', 'jwk publik ada di header');

  const key = crypto.createPublicKey({ key: header.jwk, format: 'jwk' });
  const valid = crypto.verify('sha256', Buffer.from(signingInput), { key, dsaEncoding: 'ieee-p1363' }, signature);
  assert.equal(valid, true, 'tanda tangan ES256 valid');

  assert.equal(payload.htm, method);
  const expectedHtu = new URL(url);
  expectedHtu.search = '';
  expectedHtu.hash = '';
  assert.equal(payload.htu, expectedHtu.toString());
  assert.ok(Math.abs(Date.now() / 1000 - payload.iat) < 120, 'iat masuk akal');
  assert.ok(payload.jti, 'jti ada');

  if (requireAth) assert.equal(payload.ath, athOf(token), 'ath = sha256(token)');
  return payload;
}

function startGateway() {
  const state = { registers: [], chatProofs: [], nonceIssued: false, expectedNonce: 'nonce-abc-123' };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', c => { raw += c; });
    req.on('end', async () => {
      const url = new URL(req.url, 'http://localhost');
      const jwt = req.headers.dpop;
      const auth = req.headers.authorization || '';
      const send = (code, body, extra = {}) => {
        res.writeHead(code, { 'Content-Type': 'application/json', ...extra });
        res.end(JSON.stringify(body));
      };

      try {
        if (url.pathname === '/v1/devices/register') {
          assert.equal(auth, `Bearer ${TOKEN}`, 'registrasi membawa Bearer token');
          verifyProof(jwt, { method: 'POST', url: `http://${req.headers.host}${req.url}`, token: TOKEN, requireAth: false });
          state.registers.push({ body: JSON.parse(raw || '{}'), jwk: decodeJwt(jwt).header.jwk });
          return send(200, { device_id: 'dev-1', status: 'active' });
        }

        if (url.pathname === '/v1/models') {
          assert.equal(auth, `Bearer ${TOKEN}`);
          verifyProof(jwt, { method: 'GET', url: `http://${req.headers.host}${req.url}`, token: TOKEN, requireAth: true });
          return send(200, { data: [{ id: MODEL }] });
        }

        if (url.pathname === '/v1/chat/completions') {
          const proof = verifyProof(jwt, { method: 'POST', url: `http://${req.headers.host}${req.url}`, token: TOKEN, requireAth: true });
          state.chatProofs.push(proof);
          // Nonce challenge: permintaan pertama ditolak, harus diulang dengan nonce.
          if (!state.nonceIssued) {
            state.nonceIssued = true;
            return send(401, { detail: 'use_dpop_nonce' }, { 'DPoP-Nonce': state.expectedNonce });
          }
          assert.equal(proof.nonce, state.expectedNonce, 'permintaan kedua membawa nonce yang diminta');
          return send(200, {
            choices: [{ message: { role: 'assistant', content: '{"status":"TIDAK_TAMPAK_BAHAYA","findings":[],"summary":"ok"}' }, finish_reason: 'stop' }],
            usage: { completion_tokens: 5, prompt_tokens: 7 },
          });
        }

        return send(404, { error: 'not found' });
      } catch (error) {
        return send(500, { error: String(error.message) });
      }
    });
  });
  return { server, state };
}

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

async function setup() {
  const gateway = startGateway();
  const port = await listen(gateway.server);
  const store = path.join(os.tmpdir(), `dpop-${crypto.randomUUID()}`, 'dpop.json');
  const bridge = createBridge({
    upstreamBaseUrl: `http://127.0.0.1:${port}/v1`,
    upstreamApiKey: TOKEN,
    upstreamModel: MODEL,
    publicModel: MODEL,
    dpop: true,
    dpopStorePath: store,
    log: false,
  });
  const bridgePort = await listen(bridge);
  return {
    gateway, store,
    base: `http://127.0.0.1:${bridgePort}`,
    close: async () => { bridge.close(); gateway.server.close(); },
  };
}

test('registrasi device sekali, proof valid, ath benar', async () => {
  const ctx = await setup();
  try {
    const response = await fetch(`${ctx.base}/api/tags`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.models.some(m => m.name === MODEL && m.capabilities.includes('vision')));

    assert.equal(ctx.gateway.state.registers.length, 1, 'registrasi dipanggil sekali');
    assert.equal(ctx.gateway.state.registers[0].body.device_name, 'llm-bridge');
  } finally { await ctx.close(); }
});

test('nonce diminta server lalu diulang dengan klaim nonce', async () => {
  const ctx = await setup();
  try {
    const response = await fetch(`${ctx.base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: 'uji', images: [Buffer.from('x').toString('base64')] }],
        stream: false,
      }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.message.content.includes('TIDAK_TAMPAK_BAHAYA'), true);

    assert.equal(ctx.gateway.state.chatProofs.length, 2, 'dua percobaan: tanpa nonce, lalu dengan nonce');
    assert.equal(ctx.gateway.state.chatProofs[0].nonce, undefined);
    assert.equal(ctx.gateway.state.chatProofs[1].nonce, 'nonce-abc-123');
  } finally { await ctx.close(); }
});

test('kunci privat disimpan dan dipakai ulang (tidak registrasi ulang)', async () => {
  const ctx = await setup();
  try {
    await (await fetch(`${ctx.base}/api/tags`)).json();
    const firstJwk = ctx.gateway.state.registers[0].jwk;
    const saved = JSON.parse(await fs.readFile(ctx.store, 'utf8'));
    assert.ok(saved.jwk.d, 'kunci privat tersimpan');

    // Instance baru dengan store yang sama: tidak boleh registrasi lagi.
    const bridge2 = createBridge({
      upstreamBaseUrl: `http://127.0.0.1:${ctx.gateway.server.address().port}/v1`,
      upstreamApiKey: TOKEN, upstreamModel: MODEL, publicModel: MODEL,
      dpop: true, dpopStorePath: ctx.store, log: false,
    });
    const port2 = await listen(bridge2);
    try {
      await (await fetch(`http://127.0.0.1:${port2}/api/tags`)).json();
      assert.equal(ctx.gateway.state.registers.length, 1, 'tidak registrasi ulang setelah restart');
    } finally { bridge2.close(); }
  } finally { await ctx.close(); }
});
