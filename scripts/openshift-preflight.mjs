// Explicit OpenShift diagnostics only. Never starts the app, migrates SQL,
// downloads models, performs inference, or changes existing inspection files.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSqlClient, runProcess } from './sql-client.js';
import { createVisionModelList } from './ollama-models.js';

export async function checkStorage(directory) {
  // mkdtemp owns this new directory exclusively; cleanup never targets data.
  const scratch = await fs.mkdtemp(path.join(directory, '.preflight-'));
  try {
    const initial = path.join(scratch, 'probe.tmp');
    const renamed = path.join(scratch, 'probe.txt');
    await fs.writeFile(initial, 'preflight', { flag: 'wx' });
    await fs.rename(initial, renamed);
    if (await fs.readFile(renamed, 'utf8') !== 'preflight') throw new Error('Storage read failed');
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

export async function checkOllama(baseUrl) {
  const endpoint = new URL(baseUrl);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new Error('Use an HTTP(S) Ollama endpoint without embedded credentials');
  }
  const models = await createVisionModelList({ baseUrl: baseUrl.replace(/\/$/, '') })();
  if (!models.length) throw new Error('Ollama has no discoverable vision model');
  // The API calls inspect metadata only. They do not pull or run models.
}

export async function main(args = process.argv.slice(2)) {
  const allowed = new Set(['--package-only', '--services', '--training']);
  if (args.some(arg => !allowed.has(arg))) throw new Error('Unknown diagnostic option');
  if (args.includes('--package-only') && args.includes('--services')) throw new Error('Choose one mode');
  let failures = 0;
  const check = async (name, action) => {
    try { await action(); console.log(`PASS ${name}`); }
    catch (error) {
      failures++;
      // Do not print process output, connection strings, passwords or URLs.
      const code = typeof error.code === 'string' && /^[A-Z_]+$/.test(error.code) ? ` (${error.code})` : '';
      console.error(`FAIL ${name}${code}; inspect this dependency with the platform team`);
    }
  };
  await check('Ubuntu 22.04 / Linux amd64 / Node 22', async () => {
    const release = await fs.readFile('/etc/os-release', 'utf8');
    if (process.platform !== 'linux' || process.arch !== 'x64' || process.versions.node.split('.')[0] !== '22' ||
        !/^ID=ubuntu$/m.test(release) || !/^VERSION_ID="22\.04"$/m.test(release)) throw new Error('Wrong runtime');
  });
  const python = process.env.PYTHON_EXE || '/opt/venv/bin/python';
  const sqlcmd = process.env.SQLCMD_EXE || '/opt/mssql-tools18/bin/sqlcmd';
  await check('Python media/PDF dependencies', () => runProcess(python, ['-c', 'import PIL, fitz, pypdf, pdfplumber, ssl; assert ssl.create_default_context().cert_store_stats()["x509_ca"] > 0'], { timeout: 30000 }));
  await check('Microsoft sqlcmd executable', () => runProcess(sqlcmd, ['-?'], { timeout: 30000 }));
  if (args.includes('--training')) {
    await check('CPU training / ONNX operators', () => runProcess(process.env.RIG_TRAINING_PYTHON_EXE || '/opt/training/bin/python',
      [fileURLToPath(new URL('./container-smoke.py', import.meta.url)), '--training'], { timeout: 120000 }));
  }
  if (args.includes('--services')) {
    await check('Non-root / automatic migrations disabled / SQL TLS', async () => {
      if (process.getuid?.() === 0 || process.env.SQL_MIGRATE_ON_START !== 'false' ||
          process.env.SQL_ENCRYPT !== 'mandatory' || process.env.SQL_TRUST_SERVER_CERTIFICATE !== 'false') throw new Error('Unsafe settings');
    });
    for (const directory of ['/tmp', '/app/data/private', '/app/models']) {
      await check(`Storage ${directory}`, () => checkStorage(directory));
    }
    await check('SQL login and existing application schema (read-only)', async () => {
      for (const key of ['SQL_SERVER', 'SQL_USER', 'SQL_PASSWORD']) if (!process.env[key]) throw new Error('Missing SQL setting');
      const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'rig-preflight-sql-'));
      try {
        const sql = createSqlClient({ executable: sqlcmd, server: process.env.SQL_SERVER, tempDir: scratch, encrypt: 'mandatory', trustCertificate: false });
        await sql("SET NOCOUNT ON; IF OBJECT_ID(N'dbo.AppUser', N'U') IS NULL THROW 51000, 'Application schema unavailable', 1; SELECT TOP (0) user_id FROM dbo.AppUser; SELECT 1;", { database: 'K3VisionLocal' });
      } finally { await fs.rm(scratch, { recursive: true, force: true }); }
    });
    await check('Ollama endpoint and vision model metadata', async () => {
      if (!process.env.OLLAMA_BASE_URL) throw new Error('Missing Ollama endpoint');
      await checkOllama(process.env.OLLAMA_BASE_URL);
    });
    await check('HTTPS application origin', async () => {
      const origin = new URL(process.env.APP_ORIGIN || '');
      if (origin.protocol !== 'https:' || origin.origin !== process.env.APP_ORIGIN || origin.hostname.endsWith('.invalid')) throw new Error('Invalid APP_ORIGIN');
    });
  }
  console.log(`Preflight complete: ${failures} failed. No database migrations or inference performed.`);
  return failures ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(() => { console.error('Invalid preflight invocation'); process.exitCode = 1; });
}
