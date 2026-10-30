// DPoP (RFC 9449) untuk gateway yang mewajibkan proof of possession.
//
// Alur:
//   1. Buat pasangan kunci EC P-256, simpan kunci privat di disk (bertahan antar restart).
//   2. POST /devices/register dengan header "DPoP: <proof JWT>" -> device terdaftar untuk token.
//   3. Setiap request: Authorization: Bearer <token> + DPoP: <proof JWT> yang memuat ath.
//   4. Bila server membalas nonce (use_dpop_nonce), ulangi dengan klaim nonce.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const b64url = input => Buffer.from(input).toString('base64url');
const sha256 = value => crypto.createHash('sha256').update(value).digest();

// JWT DPoP: header memuat JWK publik, payload memuat htm/htu/iat/jti (+ ath, nonce).
function signProof(privateKey, publicJwk, payload) {
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: publicJwk };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${signature.toString('base64url')}`;
}

// htu: URL tanpa query/hash, sesuai RFC 9449.
function htuOf(url) {
  const parsed = new URL(url);
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

export function createDpop(options = {}) {
  const config = {
    storePath: options.storePath || '/data/dpop.json',
    deviceName: options.deviceName || 'llm-bridge',
    registerPath: options.registerPath || '/devices/register',
    includeAthOnRegister: options.includeAthOnRegister === true,
    log: options.log || (() => {}),
  };

  let privateKey = null;
  let publicJwk = null;
  let registeredAt = null;
  let nonce = null;

  async function load() {
    if (privateKey) return;
    try {
      const saved = JSON.parse(await fs.readFile(config.storePath, 'utf8'));
      privateKey = crypto.createPrivateKey({ key: saved.jwk, format: 'jwk' });
      const jwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' });
      publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
      registeredAt = saved.registered_at || null;
      config.log('kunci DPoP dimuat dari', config.storePath);
    } catch (error) {
      if (error.code !== 'ENOENT') config.log('gagal membaca kunci DPoP:', error.message);
      const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      privateKey = pair.privateKey;
      const jwk = pair.publicKey.export({ format: 'jwk' });
      publicJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y };
      await persist();
      config.log('kunci DPoP baru dibuat');
    }
  }

  async function persist() {
    const dir = path.dirname(config.storePath);
    await fs.mkdir(dir, { recursive: true }).catch(() => {});
    const body = JSON.stringify({
      jwk: privateKey.export({ format: 'jwk' }),
      registered_at: registeredAt,
      device_name: config.deviceName,
    }, null, 2);
    await fs.writeFile(config.storePath, body, { mode: 0o600 });
  }

  function proof({ method, url, accessToken, withAth }) {
    const payload = {
      jti: crypto.randomUUID(),
      htm: String(method || 'GET').toUpperCase(),
      htu: htuOf(url),
      iat: Math.floor(Date.now() / 1000),
    };
    if (withAth && accessToken) payload.ath = sha256(accessToken).toString('base64url');
    if (nonce) payload.nonce = nonce;
    return signProof(privateKey, publicJwk, payload);
  }

  function captureNonce(response) {
    const value = response.headers.get('dpop-nonce');
    if (value) nonce = value.trim();
  }

  // Satu request dengan header DPoP; bila server minta nonce, ulangi sekali.
  async function call(fetchImpl, url, init, { withAth = true } = {}) {
    await load();
    const attempt = async () => {
      const headers = new Headers(init.headers || {});
      headers.set('DPoP', proof({
        method: init.method || 'GET',
        url,
        accessToken: init.token,
        withAth,
      }));
      return fetchImpl(url, { ...init, headers });
    };

    let response = await attempt();
    captureNonce(response);
    if (response.status === 401 && nonce) {
      try { await response.body?.cancel(); } catch {}
      response = await attempt();
      captureNonce(response);
    }
    return response;
  }

  async function register(fetchImpl, baseUrl, token) {
    await load();
    if (registeredAt) return registeredAt;

    const url = `${baseUrl}${config.registerPath}`;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;

    let response = await call(fetchImpl, url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ device_name: config.deviceName }),
      token,
    }, { withAth: config.includeAthOnRegister });

    // Sebagian implementasi menolak ath pada registrasi; coba sekali tanpa ath.
    if (!response.ok && response.status >= 400 && response.status < 500) {
      try { await response.body?.cancel(); } catch {}
      response = await call(fetchImpl, url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ device_name: config.deviceName }),
        token,
      }, { withAth: false });
    }

    const text = await response.text();
    if (!response.ok) {
      throw Object.assign(new Error(`Registrasi device DPoP gagal (HTTP ${response.status}): ${text.slice(0, 300)}`), { status: 502 });
    }

    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}
    registeredAt = new Date().toISOString();
    await persist();
    config.log('device DPoP terdaftar:', parsed ? JSON.stringify(parsed).slice(0, 200) : '(tanpa body)');
    return registeredAt;
  }

  return {
    config,
    ensureKey: load,
    proof: ({ method, url, accessToken, withAth = true }) => { return proof({ method, url, accessToken, withAth }); },
    register,
    call,
    getPublicJwk: () => publicJwk,
    getNonce: () => nonce,
    isRegistered: () => Boolean(registeredAt),
  };
}
