// Explicit initialization Job only. The web Deployment never receives the sa password.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSqlClient, sqlText } from './sql-client.js';

const password = process.env.APP_SQL_PASSWORD || '';
if (password.length < 20 || password.length > 128 || /[\x00-\x1f\x7f]/.test(password) || password.startsWith('CHANGE_ME')) {
  throw new Error('APP_SQL_PASSWORD harus unik, 20–128 karakter, tanpa karakter kontrol.');
}
if (password === process.env.SQL_PASSWORD || password === process.env.BOOTSTRAP_ADMIN_PASSWORD) {
  throw new Error('Gunakan password berbeda untuk SQL sa, SQL aplikasi, dan admin aplikasi.');
}
const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'rig-company-bootstrap-'));
try {
  await import('./openshift-bootstrap.js');
  const sql = createSqlClient({ executable: process.env.SQLCMD_EXE || '/opt/mssql-tools18/bin/sqlcmd', server: process.env.SQL_SERVER, tempDir: temporaryDirectory });
  // QUOTENAME quotes the password as a SQL string; never interpolate it into DDL.
  // Existing logins are left unchanged so re-running migrations cannot rotate a credential.
  await sql(`
DECLARE @password nvarchar(128) = ${sqlText(password)};
IF NOT EXISTS (SELECT 1 FROM sys.sql_logins WHERE name = N'inspeksi_app')
BEGIN
  DECLARE @statement nvarchar(max) = N'CREATE LOGIN [inspeksi_app] WITH PASSWORD = ' + QUOTENAME(@password, '''') + N', CHECK_POLICY = ON, CHECK_EXPIRATION = OFF;';
  EXEC sys.sp_executesql @statement;
END;`, { database: 'master' });
  await sql(`
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'inspeksi_app')
  CREATE USER [inspeksi_app] FOR LOGIN [inspeksi_app];
IF IS_ROLEMEMBER(N'db_datareader', N'inspeksi_app') <> 1 ALTER ROLE db_datareader ADD MEMBER [inspeksi_app];
IF IS_ROLEMEMBER(N'db_datawriter', N'inspeksi_app') <> 1 ALTER ROLE db_datawriter ADD MEMBER [inspeksi_app];`, { database: 'K3VisionLocal' });
  // Verify the actual runtime credential without printing it or resetting an existing login.
  const runtimeSql = createSqlClient({ executable: process.env.SQLCMD_EXE || '/opt/mssql-tools18/bin/sqlcmd', server: process.env.SQL_SERVER, tempDir: temporaryDirectory, user: 'inspeksi_app', password });
  await runtimeSql('SELECT TOP (1) user_id FROM dbo.AppUser;', { database: 'K3VisionLocal' });
  console.log('Inisialisasi selesai: admin aplikasi tersedia, login SQL inspeksi_app tervalidasi.');
} catch {
  // SQL command output may contain values from initialization statements. Keep Job logs secret-free.
  console.error('Inisialisasi gagal. Periksa koneksi/TLS SQL, Secret, kebijakan password dan status migrasi. Password tidak diubah pada login yang sudah ada.');
  process.exitCode = 1;
} finally {
  await fs.rm(temporaryDirectory, { recursive: true, force: true });
}
