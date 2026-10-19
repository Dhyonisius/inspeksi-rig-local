// Run explicitly in an initialization Job using a dedicated database migration login.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createSqlClient, sqlText, sqlAscii } from './sql-client.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const migrateOnly = process.argv.includes('--migrate-only');
const email = String(process.env.BOOTSTRAP_ADMIN_EMAIL || '').trim().toLowerCase();
const password = process.env.BOOTSTRAP_ADMIN_PASSWORD || '';
if (!migrateOnly && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || password.length < 16 || password.length > 160 || password === 'K3-demo-2026')) {
  throw new Error('Isi BOOTSTRAP_ADMIN_EMAIL dan BOOTSTRAP_ADMIN_PASSWORD unik (16–160 karakter) melalui Secret.');
}
if (!process.env.SQL_SERVER || !process.env.SQL_USER || !process.env.SQL_PASSWORD) throw new Error('Konfigurasi SQL migrator belum lengkap.');
const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'rig-bootstrap-'));
try {
  const sql = createSqlClient({ executable: process.env.SQLCMD_EXE || '/opt/mssql-tools18/bin/sqlcmd', server: process.env.SQL_SERVER, tempDir: temporaryDirectory });
  const migrations = ['database.sql', 'live.sql', 'dataset-tools.sql', 'public-datasets.sql', 'dataset-delete.sql', 'rig-dataset.sql', 'learning-scope.sql', 'protect-curation.sql', 'annotation-learning.sql'];
  for (const file of migrations) {
    console.log(`Migrasi: ${file}`);
    await sql('', { file: path.join(root, 'sql', file) });
  }
  if (!migrateOnly) {
    const salt = crypto.randomBytes(24).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, 150000, 32, 'sha256').toString('hex');
    // Refuse to overwrite an existing account. Password rotation uses the normal admin workflow.
    await sql(`SET XACT_ABORT ON; BEGIN TRANSACTION;
    IF EXISTS (SELECT 1 FROM dbo.AppUser WHERE email=${sqlText(email)})
      THROW 51000, 'Akun bootstrap sudah ada. Jangan menimpa akun; gunakan alur admin.', 1;
    UPDATE dbo.AppUser SET is_active=0 WHERE password_hash LIKE 'k3-local-demo-salt-v1:%';
    INSERT dbo.AppUser(full_name,email,password_hash,role) VALUES (N'Administrator Inspeksi',${sqlText(email)},${sqlAscii(`${salt}:${hash}`)},'admin');
    COMMIT;`, { database: 'K3VisionLocal' });
    console.log('Migrasi dan pembuatan admin selesai. Akun dengan kata sandi demo dinonaktifkan.');
  } else console.log('Migrasi selesai. Akun admin yang ada tidak diubah.');
} finally {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
}
