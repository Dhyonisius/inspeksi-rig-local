import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

// Keep user/model text on one script line so sqlcmd never interprets it as GO or a command.
function sqlLiteral(value, unicode) {
  if (value == null) return 'NULL';
  const prefix = unicode ? 'N' : '';
  const char = unicode ? 'NCHAR' : 'CHAR';
  const escaped = String(value).replaceAll('\0', '').replaceAll("'", "''")
    .replace(/\r/g, `' + ${char}(13) + ${prefix}'`)
    .replace(/\n/g, `' + ${char}(10) + ${prefix}'`);
  return `(${prefix}'${escaped}')`;
}

export const sqlText = value => sqlLiteral(value, true);
export const sqlAscii = value => sqlLiteral(value, false);

// Each sqlcmd invocation starts a new session. Filtered-index writes require
// these values in that session, including the DELETE of legacy review requests.
const sqlSessionPreamble = `SET NOCOUNT ON;
SET ANSI_NULLS ON;
SET ANSI_PADDING ON;
SET ANSI_WARNINGS ON;
SET ARITHABORT ON;
SET CONCAT_NULL_YIELDS_NULL ON;
SET QUOTED_IDENTIFIER ON;
SET NUMERIC_ROUNDABORT OFF;`;

export function runProcess(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(file, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...(options.env ? { env: options.env } : {}) }); }
    catch (error) { reject(error); return; }
    const stdout = [], stderr = [];
    let bytes = 0, failure = null;
    const limit = options.maxBuffer || 8 * 1024 * 1024;
    const collect = (chunks, chunk) => {
      bytes += chunk.length;
      if (bytes > limit) {
        failure ||= Object.assign(new Error('Output SQLCMD melewati batas ukuran.'), { code: 'OUTPUT_LIMIT' });
        child.kill();
      } else chunks.push(chunk);
    };
    const timer = setTimeout(() => {
      failure = Object.assign(new Error('SQLCMD melewati batas waktu.'), { code: 'SQL_TIMEOUT' });
      child.kill();
    }, options.timeout || 150000);
    child.stdout.on('data', chunk => collect(stdout, chunk));
    child.stderr.on('data', chunk => collect(stderr, chunk));
    child.stdin.on('error', () => {});
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      const result = { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
      if (!failure && code === 0) resolve(result);
      else reject(Object.assign(failure || new Error(result.stderr.trim() || result.stdout.trim() || `SQLCMD berhenti dengan kode ${code}.`), { ...result, exitCode: code }));
    });
    child.stdin.end();
  });
}

export function createSqlClient({ executable, server, tempDir, run = runProcess,
  user = process.env.SQL_USER, password = process.env.SQL_PASSWORD || process.env.SQLCMDPASSWORD,
  encrypt = process.env.SQL_ENCRYPT || (process.platform === 'win32' ? 'optional' : 'mandatory'),
  trustCertificate = process.env.SQL_TRUST_SERVER_CERTIFICATE === undefined ? process.platform === 'win32' : process.env.SQL_TRUST_SERVER_CERTIFICATE === 'true' }) {
  if (!['optional', 'mandatory', 'strict'].includes(encrypt)) throw new Error('SQL_ENCRYPT tidak valid.');
  if (user && !password) throw new Error('SQL_PASSWORD wajib diisi untuk SQL_USER.');
  return async (query, { file, database } = {}) => {
    let temporaryFile;
    try {
      if (!file) {
        await fs.mkdir(tempDir, { recursive: true });
        temporaryFile = path.join(tempDir, `${crypto.randomUUID()}.sql`);
        // sqlcmd detects the BOM. A file also avoids Windows' command-line length limit.
        await fs.writeFile(temporaryFile, Buffer.from(`\uFEFF${sqlSessionPreamble}\n${query}\n`, 'utf16le'), { flag: 'wx' });
        file = temporaryFile;
      }
      const args = ['-S', server, ...(user ? ['-U', user] : ['-E']), ...(trustCertificate ? ['-C'] : []), `-N${{ optional: 'o', mandatory: 'm', strict: 's' }[encrypt]}`, '-I', '-b', '-r', '1', '-x', '-X1', '-l', '30', '-t', '120', '-f', '65001', '-y', '0', '-w', '65535'];
      if (database) args.push('-d', database);
      args.push('-i', file);
      const { stdout } = await run(executable, args, { timeout: 150000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ...(user ? { SQLCMDPASSWORD: password } : {}) } });
      return stdout.replace(/^\uFEFF/, '').trim();
    } finally {
      if (temporaryFile) await fs.unlink(temporaryFile).catch(() => {});
    }
  };
}

export function sqlDiagnostic(error) {
  return String(error.stderr?.trim() || error.stdout?.trim() || error.message || 'Kesalahan SQLCMD tidak diketahui')
    .replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1600);
}

export function isConnectionError(error, diagnostic = sqlDiagnostic(error)) {
  return error.code === 'SQL_TIMEOUT' || /SQLCMD.*not found|ENOENT|ODBC Driver|SSPI|SSL Provider|login failed|login timeout|network-related|server.*not.*accessible|client unable to establish/i.test(diagnostic);
}
