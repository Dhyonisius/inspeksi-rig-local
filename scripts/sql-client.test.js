import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createSqlClient, sqlText, sqlAscii, sqlDiagnostic, isConnectionError, runProcess } from './sql-client.js';

async function withTempDir(work) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'lentera-sql-'));
  assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir()) + path.sep + 'lentera-sql-'));
  try { await work(dir); }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}

test('long VLM response and Unicode reach a BOM input file, never the process command line', async () => {
  await withTempDir(async tempDir => {
    const summary = `Jalur terhalang, “hati-hati” 🧯 日本語 ${'"\\'.repeat(25000)}`;
    const query = `SELECT ${sqlText(summary)} AS summary FOR JSON PATH;`;
    assert.ok(query.length > 32767);
    const client = createSqlClient({ executable: 'sqlcmd.exe', server: '.\\SQLEXPRESS', tempDir,
      run: async (exe, args) => {
        assert.equal(exe, 'sqlcmd.exe');
        assert.equal(args.includes('-Q'), false);
        assert.ok(args.join(' ').length < 2000);
        assert.equal(args[args.indexOf('-d') + 1], 'K3VisionLocal');
        assert.ok(args.includes('-x'));
        const input = await fs.readFile(args[args.indexOf('-i') + 1]);
        assert.equal(input.readUInt16LE(0), 0xfeff);
        assert.equal(input.subarray(2).toString('utf16le'), `SET NOCOUNT ON;\nSET ANSI_NULLS ON;\nSET ANSI_PADDING ON;\nSET ANSI_WARNINGS ON;\nSET ARITHABORT ON;\nSET CONCAT_NULL_YIELDS_NULL ON;\nSET QUOTED_IDENTIFIER ON;\nSET NUMERIC_ROUNDABORT OFF;\n${query}\n`);
        return { stdout: '\uFEFF[{"summary":"Jalur terhalang 🧯"}]\r\n', stderr: '' };
      } });
    assert.equal(await client(query, { database: 'K3VisionLocal' }), '[{"summary":"Jalur terhalang 🧯"}]');
    assert.deepEqual(await fs.readdir(tempDir), []);
  });
});

test('parallel queries use different files and remove them even when SQLCMD fails', async () => {
  await withTempDir(async tempDir => {
    const files = new Set();
    const client = createSqlClient({ executable: 'sqlcmd.exe', server: '.', tempDir,
      run: async (_exe, args) => {
        const file = args[args.indexOf('-i') + 1];
        assert.equal(files.has(file), false);
        files.add(file);
        await fs.readFile(file);
        throw Object.assign(new Error('query failed'), { stderr: 'Msg 208, Level 16\r\nInvalid object name dbo.AnalysisVlmPrediction.' });
      } });
    const results = await Promise.allSettled([client('SELECT 1;'), client('SELECT 2;')]);
    assert.ok(results.every(result => result.status === 'rejected'));
    assert.equal(files.size, 2);
    assert.deepEqual(await fs.readdir(tempDir), []);
  });
});

test('bootstrap input stays intact after execution', async () => {
  await withTempDir(async tempDir => {
    const file = path.join(tempDir, 'schema.sql');
    await fs.writeFile(file, 'USE master;\nGO\nSELECT 1;');
    const client = createSqlClient({ executable: 'sqlcmd.exe', server: '.', tempDir,
      run: async (_exe, args) => {
        assert.equal(args[args.indexOf('-i') + 1], file);
        return { stdout: '', stderr: '' };
      } });
    await client('', { file });
    assert.equal(await fs.readFile(file, 'utf8'), 'USE master;\nGO\nSELECT 1;');
  });
});

test('quotes and multiline model/user text cannot become sqlcmd script commands', () => {
  const literal = sqlText("foto O'Brien\r\nGO\n:r file.sql\n$(SQLCMDINI)\0");
  assert.equal(literal.includes('\n'), false);
  assert.equal(literal.includes('\r'), false);
  assert.ok(literal.includes("O''Brien"));
  assert.ok(literal.includes('NCHAR(13)'));
  assert.ok(literal.includes('NCHAR(10)'));
  assert.equal(sqlAscii(null), 'NULL');
  assert.equal(sqlAscii('OLLAMA'), "('OLLAMA')");
});

test('SQL errors retain stdout diagnostics and are distinct from connection failures', () => {
  const queryError = { stderr: '', stdout: 'Msg 208, Level 16\r\nInvalid object name dbo.AnalysisVlmPrediction.', message: 'exit 1' };
  assert.match(sqlDiagnostic(queryError), /Invalid object name/);
  assert.equal(isConnectionError(queryError), false);
  assert.equal(isConnectionError({ stderr: 'Microsoft ODBC Driver 18: SSL Provider: No credentials are available in the security package' }), true);
  assert.equal(isConnectionError({ code: 'SQL_TIMEOUT', message: 'timeout' }), true);
});

test('native process output, stderr, and timeout are handled without losing diagnostics', async () => {
  const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("hasil 🧯");'], { timeout: 5000 });
  assert.equal(result.stdout, 'hasil 🧯');
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.stdout.write("SQL constraint detail"); process.exit(1);']), error => /SQL constraint detail/.test(sqlDiagnostic(error)));
  await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000);'], { timeout: 100 }), error => error.code === 'SQL_TIMEOUT');
});
