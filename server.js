import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createSqlClient, sqlText, sqlAscii, sqlDiagnostic, isConnectionError, runProcess } from './scripts/sql-client.js';
import { archiveListScope, archiveState, archiveTransaction, analysisVisibilityCondition, imageVisibilityCondition } from './scripts/analysis-archive.js';
import { requirePermanentDelete, deletePermissions, permanentDeleteTransaction, cleanupOrphanPhoto } from './scripts/analysis-delete.js';
import { requireDatasetDelete, datasetDeletePermissions, datasetDeleteTransaction, cleanupDatasetOrphans } from './scripts/dataset-delete.js';
import { createDatasetTools } from './scripts/dataset-tools.js';
import { createVisionModelList } from './scripts/ollama-models.js';
import { parseDatasetAnnotations } from './scripts/dataset-validation.js';
import { datasetStatusTransaction, datasetUploadTransaction } from './scripts/dataset-write.js';
import { sessionCookieValue, jsonObjectBody } from './scripts/request-validation.js';
import { createInferenceImage, createTimedCache, createTaskLimiter, inferenceProfile } from './scripts/inference-profiles.js';
import { createVisionAnalyzer } from './scripts/vision-inference.js';
import { createPerformanceMonitor } from './scripts/performance-monitor.js';
import { createMediaPreview } from './scripts/media-preview.js';
import { createRigDataset } from './scripts/rig-dataset.js';
import { createLearningApi } from './scripts/learning-api.js';
import { createVerifiedMemory } from './scripts/verified-memory.js';
import { createRigTrainingApi } from './scripts/rig-training-api.js';
import { createAnnotationLearning } from './scripts/annotation-learning.js';
import { createAnnotationJobs } from './scripts/annotation-jobs.js';
import { createProtectCurationApi } from './scripts/protect-curation-api.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const privateDir = path.join(root, 'data', 'private');
const uploadDir = path.join(privateDir, 'uploads');
const schemaFile = path.join(root, 'sql', 'database.sql');
const featureSchemaFiles = ['live.sql', 'dataset-tools.sql', 'public-datasets.sql', 'dataset-delete.sql', 'rig-dataset.sql','learning-scope.sql','protect-curation.sql','annotation-learning.sql'].map(name => path.join(root, 'sql', name));
const sanitizerFile = path.join(root, 'scripts', 'sanitize_image.py');
const port = Number(process.env.PORT || 3180);
const host = '127.0.0.1';
const maxUploadBytes = 8 * 1024 * 1024;
const maxRequestBytes = maxUploadBytes + 512 * 1024;
const sessionCookie = 'lentera_session';
const sessionHours = 8;
const sessions = new Map();
const loginAttempts = new Map();
const sqlcmd = process.env.SQLCMD_EXE || 'C:\\Program Files\\Microsoft SQL Server\\Client SDK\\ODBC\\180\\Tools\\Binn\\SQLCMD.EXE';
const sqlServer = process.env.SQL_SERVER || '.\\SQLEXPRESS';
const databaseName = 'K3VisionLocal';
const ollamaBaseUrl = 'http://127.0.0.1:11434';
const discoverOllamaVisionModels = createVisionModelList({ baseUrl: ollamaBaseUrl });
const python = process.env.PYTHON_EXE || 'python';
const modelListCache = createTimedCache({ ttlMs: 10000 });
const inspectionConfigCache = createTimedCache({ ttlMs: 30000 });
const prepareInferenceImage = createInferenceImage({ root, python });
const performanceMonitor = createPerformanceMonitor();
const mediaPreview = createMediaPreview({ projectRoot: root, privateDir, uploadDir, python });
const listOllamaVisionModels = (options = {}) => {
  if (options.refresh) modelListCache.invalidate();
  return modelListCache.get('vision-models', discoverOllamaVisionModels);
};
let runtimeAccount = 'tidak diketahui';
try { runtimeAccount = (await runProcess(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'whoami.exe'), [], { timeout: 5000 })).stdout.trim() || runtimeAccount; }
catch { /* An optional account diagnostic must not stop the application. */ }
let databaseReady = false;
let databaseHealth = { database: 'unavailable', error: 'Koneksi SQL Server sedang disiapkan.' };
const logFile = path.join(privateDir, 'logs', 'database-errors.log');
const querySql = createSqlClient({ executable: sqlcmd, server: sqlServer, tempDir: path.join(privateDir, 'sql-temp') });
const runSqlTask = createTaskLimiter();

const intValue = (value, label, min = 1, max = 2147483647) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw httpError(400, `${label} tidak valid.`);
  return number;
};
const boolValue = value => value === '1' || value === 'true' || value === true;
const httpError = (status, message, code = '') => Object.assign(new Error(message), { status, code });
const safeEmail = value => String(value || '').trim().toLowerCase().slice(0, 254);
const datasetDeletions = new Set();
const datasetReaders = new Map();
function withDatasetReadLock(id, job) {
  if (datasetDeletions.has(id)) throw httpError(409, 'Dataset sedang dihapus. Tunggu proses selesai, lalu muat ulang halaman.', 'DATASET_DELETE_BUSY');
  datasetReaders.set(id, (datasetReaders.get(id) || 0) + 1);
  return Promise.resolve().then(job).finally(() => {
    const remaining = (datasetReaders.get(id) || 1) - 1;
    if (remaining) datasetReaders.set(id, remaining);
    else datasetReaders.delete(id);
  });
}
let inferenceActive = null;
async function withDatasetMutationLock(id, job) {
  if (datasetDeletions.has(id) || datasetReaders.has(id)) throw httpError(409, 'Dataset sedang digunakan. Tunggu ekspor, impor, atau peninjauan selesai sebelum kurasi.');
  datasetDeletions.add(id);
  try { return await job(); } finally { datasetDeletions.delete(id); }
}
function withInferenceLock(userId, job) {
  if (inferenceActive) throw httpError(409, 'AI lokal sedang memproses pemeriksaan atau evaluasi lain. Tunggu proses selesai, lalu coba lagi.', 'AI_BUSY');
  const reservation = { userId };
  inferenceActive = reservation;
  return Promise.resolve().then(job).finally(() => { if (inferenceActive === reservation) inferenceActive = null; });
}

async function executeSql(query, options = {}) {
  try {
    return await runSqlTask(() => querySql(query, options));
  } catch (error) {
    if (error.code === 'DATABASE_BUSY') throw error;
    const diagnostic = sqlDiagnostic(error);
    const connectionFailed = isConnectionError(error, diagnostic);
    console.error('[db] SQL Server request failed:', diagnostic);
    await fs.promises.mkdir(path.dirname(logFile), { recursive: true }).then(() => fs.promises.appendFile(logFile, `${new Date().toISOString()} | ${runtimeAccount} | ${connectionFailed ? 'CONNECTION' : 'QUERY'} | ${diagnostic}\n`)).catch(() => {});
    if (connectionFailed) {
      databaseReady = false;
      databaseHealth = { database: 'unavailable', error: `SQL Server belum tersambung: ${diagnostic}` };
    }
    throw httpError(connectionFailed ? 503 : 500, `SQL Server ${connectionFailed ? 'belum tersambung' : 'gagal menyimpan atau membaca data'}: ${diagnostic}`, connectionFailed ? 'DATABASE_UNAVAILABLE' : 'DATABASE_QUERY_FAILED');
  }
}

async function jsonQuery(query) {
  const output = await executeSql(query, { database: databaseName });
  const start = output.search(/[\[{]/);
  if (start < 0) return null;
  const end = Math.max(output.lastIndexOf(']'), output.lastIndexOf('}'));
  try { return JSON.parse(output.slice(start, end + 1).replace(/\r?\n/g, '')); }
  catch { console.error('[db] SQL Server returned non-JSON output:', output.slice(start, start + 200)); throw httpError(503, 'Respons basis data belum dapat dibaca. Periksa konfigurasi SQL Server lokal.', 'DATABASE_RESPONSE'); }
}

const requiredTables = ['AppUser', 'WorkArea', 'HazardType', 'ImageAsset', 'ModelVersion', 'Analysis', 'Finding', 'AnalysisVlmPrediction', 'AnalysisFeedback', 'AuditEvent', 'Dataset', 'DatasetItem', 'Annotation', 'AnalysisLiveEvidence', 'DatasetItemProvenance', 'EvaluationRun', 'EvaluationItem', 'DatasetExternalSource', 'DatasetExternalItem', 'DatasetObjectClass', 'DatasetObjectAnnotation', 'DatasetImportSuppression','DatasetTrainingReview','RigPdfImport','RigPdfItemSuppression','DatasetAiProposal'];
const storagePermissions = [['ImageAsset','INSERT'], ['ImageAsset','UPDATE'], ['ModelVersion','INSERT'], ['ModelVersion','UPDATE'], ['Analysis','INSERT'], ['Analysis','UPDATE'], ['Finding','INSERT'], ['AnalysisVlmPrediction','INSERT'], ['AnalysisFeedback','INSERT'], ['AuditEvent','INSERT'], ['AnalysisLiveEvidence','INSERT'], ['DatasetItem','INSERT'], ['Annotation','INSERT'], ['DatasetItemProvenance','INSERT'], ['EvaluationRun','INSERT'], ['EvaluationRun','UPDATE'], ['EvaluationItem','INSERT'], ['EvaluationItem','UPDATE']];

async function checkDatabaseHealth() {
  try {
    const tables = await jsonQuery(`SELECT name,CASE WHEN OBJECT_ID(N'dbo.'+name,N'U') IS NULL THEN 0 ELSE 1 END AS present FROM (VALUES ${requiredTables.map(name => `(${sqlText(name)})`).join(',')}) AS required(name) FOR JSON PATH;`) || [];
    const missing = tables.filter(table => !table.present).map(table => table.name);
    const archiveColumns = await jsonQuery(`SELECT name,CASE WHEN COL_LENGTH(N'dbo.Analysis',name) IS NULL THEN 0 ELSE 1 END AS present FROM (VALUES (N'archived_at'),(N'archived_by_user_id')) AS required(name) FOR JSON PATH;`) || [];
    const missingColumns = archiveColumns.filter(column => !column.present).map(column => `Analysis.${column.name}`);
    databaseReady = false;
    if (tables.length !== requiredTables.length || missing.length || archiveColumns.length !== 2 || missingColumns.length) {
      databaseHealth = {
        database: 'schema_pending',
        error: `Struktur database belum lengkap${missing.length || missingColumns.length ? `: ${[...missing, ...missingColumns].join(', ')}` : ''}. Mulai ulang aplikasi untuk migrasi otomatis, atau jalankan sql/database.sql, sql/live.sql, sql/dataset-tools.sql, sql/public-datasets.sql, dan sql/dataset-delete.sql secara berurutan di SSMS.`,
      };
    } else {
      const denied = await jsonQuery(`SELECT name,permission FROM (VALUES ${storagePermissions.map(([name,permission]) => `(${sqlText(name)},${sqlAscii(permission)})`).join(',')}) AS needed(name,permission) WHERE ISNULL(HAS_PERMS_BY_NAME(N'dbo.'+name,'OBJECT',permission),0)<>1 FOR JSON PATH;`) || [];
      databaseReady = !denied.length;
      databaseHealth = databaseReady ? { database: 'ready' } : {
        database: 'permission_denied',
        error: `SQL Server tersambung, tetapi akun Windows ${runtimeAccount} belum memiliki izin penyimpanan: ${denied.map(item => `${item.name} (${item.permission})`).join(', ')}. Jalankan server dengan akun Windows yang memiliki akses tulis di database K3VisionLocal.`,
      };
    }
  } catch (error) {
    databaseReady = false;
    databaseHealth = { database: 'unavailable', error: error.message };
  }
  return { ...databaseHealth, sql_server: sqlServer, database_name: databaseName, runtime_account: runtimeAccount };
}

async function ensureInspectionDatabase() {
  let health = await checkDatabaseHealth();
  if (health.database === 'schema_pending') {
    await executeSql('', { file: schemaFile });
    for (const file of featureSchemaFiles) await executeSql('', { file });
    health = await checkDatabaseHealth();
  }
  if (health.database !== 'ready') throw httpError(503, health.error || 'Database belum siap menyimpan pemeriksaan.', 'DATABASE_UNAVAILABLE');
}

async function bootstrapDatabase() {
  await fs.promises.mkdir(uploadDir, { recursive: true });
  try {
    await executeSql('', { file: schemaFile });
    for (const file of featureSchemaFiles) await executeSql('', { file });
    await datasetTools.recoverEvaluations();
    const health = await checkDatabaseHealth();
    if (health.database !== 'ready') throw httpError(503, health.error, 'DATABASE_UNAVAILABLE');
    console.log(`[db] Connected to ${sqlServer}; database ${databaseName} is ready.`);
    void rigDataset.initialize().catch(error => console.error('[rig-pdf]',error.message));
  } catch (error) {
    databaseReady = false;
    databaseHealth = { database: 'unavailable', error: error.message };
    console.error(`[db] Bootstrap is pending. ${error.message}`);
  }
}

function decodeCookie(header = '') {
  return sessionCookieValue(header, sessionCookie);
}

function currentUser(request) {
  const token = decodeCookie(request.headers.get('cookie') || '');
  const session = sessions.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) { sessions.delete(token); return null; }
  session.expiresAt = Date.now() + sessionHours * 60 * 60 * 1000;
  return session.user;
}

function requireUser(request) {
  const user = currentUser(request);
  if (!user) throw httpError(401, 'Sesi masuk berakhir. Masuk kembali untuk melanjutkan.');
  return user;
}
function requireRole(user, roles) {
  if (!roles.includes(user.role)) throw httpError(403, 'Aksi ini tidak tersedia untuk akun ini.');
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  response.end(body);
}
function sendJson(response, status, body, headers = {}) {
  send(response, status, JSON.stringify(body), { 'Content-Type': 'application/json; charset=utf-8', ...headers });
}
function sendError(response, error) {
  const status = error.status || 500;
  if (status >= 500) console.error('[api]', error.stack || error.message);
  sendJson(response, status, { error: error.message || 'Terjadi kesalahan pada server lokal.', code: error.code || undefined });
}

async function requestBody(incoming) {
  const chunks = [];
  let total = 0;
  for await (const chunk of incoming) {
    total += chunk.length;
    if (total > maxRequestBytes) throw httpError(413, 'Berkas terlalu besar. Batas unggahan adalah 8 MB.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function requestFrom(incoming) {
  const body = await requestBody(incoming);
  const headers = new Headers();
  for (const key of ['cookie','content-type','origin','accept']) {
    const value = incoming.headers[key];
    if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  const method = incoming.method || 'GET';
  return new Request(`http://${host}:${port}${incoming.url || '/'}`, { method, headers, ...(method === 'GET' || method === 'HEAD' ? {} : { body }) });
}

function jsonBody(request) {
  return jsonObjectBody(request, httpError);
}

function cleanImageName(value) {
  const safe = path.basename(String(value || 'foto')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
  return (safe || 'foto').slice(0, 255);
}

async function sanitizePhotoBinary(file) {
  if (!file || typeof file.arrayBuffer !== 'function') throw httpError(400, 'Pilih foto JPG, PNG, atau WebP.');
  if (!file.size || file.size > maxUploadBytes) throw httpError(400, 'Foto harus berukuran antara 1 byte dan 8 MB.');
  const input = Buffer.from(await file.arrayBuffer());
  return await new Promise((resolve, reject) => {
    const child = spawn(python, [sanitizerFile], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const output = [], errors = []; let size = 0;
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 12 * 1024 * 1024) child.kill(); else output.push(chunk); });
    child.stderr.on('data', chunk => errors.push(chunk));
    child.on('error', error => reject(httpError(500, `Pemroses foto tidak tersedia: ${error.message}`)));
    child.on('close', code => {
      if (code !== 0 || size === 0 || size > 12 * 1024 * 1024) return reject(httpError(400, Buffer.concat(errors).toString('utf8').trim().slice(0, 220) || 'Foto tidak dapat dibaca sebagai gambar yang valid.'));
      const buffer = Buffer.concat(output);
      const jpeg = buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
      const png = buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
      const webp = buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
      const mime = jpeg ? 'image/jpeg' : png ? 'image/png' : webp ? 'image/webp' : '';
      if (!mime) return reject(httpError(400, 'Format foto tidak didukung. Pilih JPG, PNG, atau WebP.'));
      resolve({ buffer, mime, extension: jpeg ? 'jpg' : png ? 'png' : 'webp', inputSize: input.length });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function audit(userId, action, entity, id, detail = null) {
  await executeSql(`INSERT dbo.AuditEvent(user_id,action_code,entity_type,entity_id,detail) VALUES (${userId},${sqlAscii(action)},${sqlAscii(entity)},${id == null ? 'NULL' : sqlText(id)},${detail == null ? 'NULL' : sqlText(detail)});`, { database: databaseName });
}

async function fetchAreas(includeInactive = false) {
  return inspectionConfigCache.get(`areas-${includeInactive}`, async () => await jsonQuery(`SELECT work_area_id,name,area_type,description,is_active,scope_key FROM dbo.WorkArea ${includeInactive ? '' : "WHERE is_active=1 AND scope_key='CRSSC-20261005'"} ORDER BY area_type,name FOR JSON PATH;`) || []);
}

async function fetchInspectionConfig(areaId) {
  const [areas, hazards] = await Promise.all([
    fetchAreas(false),
    inspectionConfigCache.get('inference-hazards', async () => await jsonQuery(`SELECT hazard_type_id,code,name,area_type,description,default_severity,recommended_action FROM dbo.HazardType WHERE is_active=1 OR code='POTENSI_LAINNYA' ORDER BY name FOR JSON PATH;`) || []),
  ]);
  return { area: areas.find(area => area.work_area_id === areaId) || null, hazards };
}

async function getOllamaStatus() {
  try {
    const visionModels = await listOllamaVisionModels();
    return { available: true, endpoint: ollamaBaseUrl, vision_models: visionModels, rig_model:rigTrainingApi.modelStatus(), text_only_note: 'Model tanpa kemampuan vision tidak ditampilkan.' };
  } catch (error) {
    return { available: false, endpoint: ollamaBaseUrl, vision_models: [], error: String(error.message || 'Ollama belum tersedia.').slice(0, 240) };
  }
}

const verifiedExamples = createVerifiedMemory({ jsonQuery, uploadDir, prepareImage: prepareInferenceImage });
const areaCatalog = JSON.parse(await fs.promises.readFile(path.join(root,'docs','work-area-catalog.json'),'utf8'));
const areaInScope = (name,type) => areaCatalog.some(a => a.name===name && a.area_type===type);
const analyzeWithOllama = createVisionAnalyzer({ baseUrl: ollamaBaseUrl, listModels: listOllamaVisionModels, prepareImage: prepareInferenceImage, monitor: performanceMonitor, getExamples: verifiedExamples });

const featureContext = { jsonQuery, executeSql, databaseName, sqlText, sqlAscii, intValue, httpError, jsonBody, sendJson, send, sanitizePhotoBinary, analyzeWithOllama, listOllamaVisionModels, uploadDir, privateDir, root, audit, withInferenceLock, withDatasetReadLock, fetchInspectionConfig, prepareInferenceImage, performanceMonitor, isDatasetDeletionActive: () => datasetDeletions.size > 0 };
const protectCurationApi = createProtectCurationApi({ ...featureContext, withDatasetMutationLock });
const datasetTools = createDatasetTools(featureContext);
const rigTrainingApi = createRigTrainingApi(featureContext, datasetTools);
featureContext.detectRig = (...args) => rigTrainingApi.detect(...args);
featureContext.rigModelStatus = () => rigTrainingApi.modelStatus();
const annotationLearning = createAnnotationLearning(featureContext);
featureContext.annotationLearning = annotationLearning;
const annotationJobs = createAnnotationJobs(featureContext, annotationLearning);
const rigDataset = createRigDataset(featureContext);
const learningApi = createLearningApi(featureContext);


async function handleApi(request, response, url) {
  const method = request.method;
  const pathname = url.pathname;
  let match;
  if (method === 'GET' && pathname === '/api/health') {
    return sendJson(response, 200, { app: 'Inspeksi Visual', host, api_version: 15, ...await checkDatabaseHealth() });
  }
  const user = pathname === '/api/auth/login' ? null : requireUser(request);
  if (user && await protectCurationApi(request, response, url, user)) return;
  if (user && await rigTrainingApi(request, response, url, user)) return;
  if (user && await annotationJobs(request, response, url, user)) return;
  if (user && await learningApi(request, response, url, user)) return;
  if (user && await rigDataset(request, response, url, user)) return;
  if (user && await datasetTools(request, response, url, user)) return;
  if (method === 'POST' && pathname === '/api/auth/login') {
    const ip = 'loopback';
    const attempt = loginAttempts.get(ip) || { count: 0, blockedUntil: 0 };
    if (attempt.blockedUntil > Date.now()) throw httpError(429, 'Terlalu banyak percobaan masuk. Tunggu sebentar lalu coba lagi.');
    const body = await jsonBody(request); const email = safeEmail(body.email); const password = String(body.password || '').slice(0, 160);
    const account = await jsonQuery(`SELECT user_id,full_name,email,password_hash,role,is_active FROM dbo.AppUser WHERE email=${sqlText(email)} AND is_active=1 FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;`);
    let valid = false;
    if (account?.password_hash) {
      const [salt, expected] = account.password_hash.split(':');
      if (salt && /^[a-f0-9]{64}$/i.test(expected || '')) {
        const actual = crypto.pbkdf2Sync(password, salt, 150000, 32, 'sha256').toString('hex');
        valid = crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
      }
    }
    if (!valid) {
      attempt.count += 1; if (attempt.count >= 7) { attempt.count = 0; attempt.blockedUntil = Date.now() + 60_000; }
      loginAttempts.set(ip, attempt); throw httpError(401, 'Email atau kata sandi tidak cocok.');
    }
    loginAttempts.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    const sessionUser = { user_id: account.user_id, full_name: account.full_name, email: account.email, role: account.role === 'k3' ? 'operator' : account.role };
    sessions.set(token, { user: sessionUser, expiresAt: Date.now() + sessionHours * 60 * 60 * 1000 });
    await audit(account.user_id, 'LOGIN', 'AppUser', account.user_id);
    return sendJson(response, 200, { user: sessionUser }, { 'Set-Cookie': `${sessionCookie}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionHours * 3600}` });
  }
  if (method === 'GET' && pathname === '/api/auth/me') return sendJson(response, 200, { user });
  if (method === 'GET' && pathname === '/api/ai/status') return sendJson(response, 200, await getOllamaStatus());
  if (method === 'POST' && pathname === '/api/auth/logout') {
    const token = decodeCookie(request.headers.get('cookie') || ''); sessions.delete(token);
    await audit(user.user_id, 'LOGOUT', 'AppUser', user.user_id);
    return send(response, 204, '', { 'Set-Cookie': `${sessionCookie}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
  }
  if (method === 'GET' && pathname === '/api/users') {
    requireRole(user, ['admin']);
    const users = await jsonQuery(`SELECT user_id,full_name,email,role,is_active,CONVERT(varchar(33),created_at,126) AS created_at FROM dbo.AppUser ORDER BY is_active DESC,role,full_name FOR JSON PATH;`);
    return sendJson(response, 200, { users: users || [] });
  }
  if (method === 'POST' && pathname === '/api/users') {
    requireRole(user, ['admin']); const body = await jsonBody(request);
    const name = String(body.full_name || '').trim().slice(0,120), email = safeEmail(body.email), role = String(body.role || '').toLowerCase(), password = String(body.password || '');
    if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400,'Nama dan alamat email yang valid wajib diisi.');
    if (!['operator','admin'].includes(role)) throw httpError(400,'Peran pengguna tidak valid.');
    if (password.length < 12 || password.length > 128) throw httpError(400,'Kata sandi harus memiliki 12–128 karakter.');
    const exists = await jsonQuery(`SELECT user_id FROM dbo.AppUser WHERE email=${sqlText(email)} FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;`); if (exists) throw httpError(409,'Email sudah terdaftar.');
    const salt = crypto.randomBytes(16).toString('hex'); const hash = crypto.pbkdf2Sync(password,salt,150000,32,'sha256').toString('hex');
    const created = await jsonQuery(`DECLARE @id INT; INSERT dbo.AppUser(full_name,email,password_hash,role) VALUES (${sqlText(name)},${sqlText(email)},${sqlAscii(`${salt}:${hash}`)},${sqlAscii(role)}); SET @id=SCOPE_IDENTITY(); INSERT dbo.AuditEvent(user_id,action_code,entity_type,entity_id,detail) VALUES (${user.user_id},'USER_CREATED','AppUser',CONVERT(nvarchar(80),@id),${sqlText(`${email}; ${role}`)}); SELECT (SELECT @id AS user_id FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS result;`);
    return sendJson(response,201,{user_id:created.user_id});
  }
  const userAccount = pathname.match(/^\/api\/users\/(\d+)$/);
  if (method === 'PATCH' && userAccount) {
    requireRole(user,['admin']); const id=intValue(userAccount[1],'ID pengguna'); const body=await jsonBody(request); const active=Boolean(body.is_active);
    const target=await jsonQuery(`SELECT user_id,role,is_active FROM dbo.AppUser WHERE user_id=${id} FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;`); if (!target) throw httpError(404,'Pengguna tidak ditemukan.');
    if (!active && id===user.user_id) throw httpError(400,'Admin tidak dapat menonaktifkan akunnya sendiri.');
    if (!active && target.role==='admin') { const otherAdmins=await jsonQuery(`SELECT COUNT(*) AS total FROM dbo.AppUser WHERE role='admin' AND is_active=1 AND user_id<>${id} FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;`); if (!otherAdmins?.total) throw httpError(400,'Pertahankan sedikitnya satu akun admin aktif.'); }
    await executeSql(`UPDATE dbo.AppUser SET is_active=${active?1:0} WHERE user_id=${id}; INSERT dbo.AuditEvent(user_id,action_code,entity_type,entity_id,detail) VALUES (${user.user_id},'USER_STATUS_CHANGED','AppUser',${sqlText(id)},${sqlText(active?'aktif':'nonaktif')});`,{database:databaseName});
    if (!active) for (const [token,session] of sessions) if (session.user.user_id===id) sessions.delete(token);
    return sendJson(response,200,{ok:true});
  }
  if (method === 'GET' && pathname === '/api/area-catalog') return sendJson(response,200,{areas:areaCatalog});
  if (method === 'GET' && pathname === '/api/areas') return sendJson(response, 200, { areas: await fetchAreas(user.role === 'admin' && url.searchParams.get('include_inactive') === '1') });
  if (method === 'POST' && pathname === '/api/areas') {
    requireRole(user,['admin']); const body=await jsonBody(request); const name=String(body.name||'').trim().slice(0,120), type=String(body.area_type||'').toUpperCase(), description=String(body.description||'').slice(0,500);
    if (!areaInScope(name,type)) throw httpError(400,'Pilihan area dibatasi bagian PDF CRSSC dan Ruangan Kantor.');
    const created=await jsonQuery(`DECLARE @id INT; IF EXISTS(SELECT 1 FROM dbo.WorkArea WHERE name=${sqlText(name)} AND area_type=${sqlAscii(type)}) THROW 51000,'Area sudah tersedia. Aktifkan melalui konfigurasi.',1; INSERT dbo.WorkArea(name,area_type,description,scope_key) VALUES (${sqlText(name)},${sqlAscii(type)},${sqlText(description)},'CRSSC-20261005'); SET @id=SCOPE_IDENTITY(); INSERT dbo.AuditEvent(user_id,action_code,entity_type,entity_id,detail) VALUES (${user.user_id},'WORK_AREA_CREATED','WorkArea',CONVERT(nvarchar(80),@id),${sqlText(name)}); SELECT (SELECT @id AS work_area_id FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS result;`);
    inspectionConfigCache.invalidate();
    return sendJson(response,201,{work_area_id:created.work_area_id});
  }
  const areaConfig=pathname.match(/^\/api\/areas\/(\d+)$/);
  if (method === 'PATCH' && areaConfig) {
    requireRole(user,['admin']); const id=intValue(areaConfig[1],'ID area'); const body=await jsonBody(request); const name=String(body.name||'').trim().slice(0,120),type=String(body.area_type||'').toUpperCase(),description=String(body.description||'').slice(0,500),active=Boolean(body.is_active);
    if (!areaInScope(name,type)) throw httpError(400,'Pilihan area dibatasi bagian PDF CRSSC dan Ruangan Kantor.');
    const exists=await jsonQuery(`SELECT work_area_id FROM dbo.WorkArea WHERE work_area_id=${id} FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;`); if (!exists) throw httpError(404,'Area kerja tidak ditemukan.');
    await executeSql(`UPDATE dbo.WorkArea SET name=${sqlText(name)},area_type=${sqlAscii(type)},description=${sqlText(description)},is_active=${active?1:0} WHERE work_area_id=${id}; INSERT dbo.AuditEvent(user_id,action_code,entity_type,entity_id,detail) VALUES (${user.user_id},'WORK_AREA_UPDATED','WorkArea',${sqlText(id)},${sqlText(name)});`,{database:databaseName});
    inspectionConfigCache.invalidate();
    return sendJson(response,200,{ok:true});
  }
  if (method === 'GET' && pathname === '/api/hazard-types') {
    const includeInactive = user.role === 'admin' && url.searchParams.get('include_inactive') === '1';
    const hazards = await jsonQuery(`SELECT hazard_type_id,code,name,area_type,description,default_severity,recommended_action,is_active FROM dbo.HazardType ${includeInactive ? '' : 'WHERE is_active=1'} ORDER BY area_type,name FOR JSON PATH;`);
    return sendJson(response, 200, { hazards: hazards || [] });
  }
  if (method === 'POST' && pathname === '/api/hazard-types') {
    requireRole(user,['admin']); const body=await jsonBody(request); const code=String(body.code||'').trim().toUpperCase().slice(0,48),name=String(body.name||'').trim().slice(0,140),area=String(body.area_type||'').toUpperCase(),severity=String(body.default_severity||'').toUpperCase(),description=String(body.description||'').trim().slice(0,700),action=String(body.recommended_action||'').trim().slice(0,700);
    if (!/^[A-Z0-9_]{2,48}$/.test(code)||!name||!['GUDANG','KANTOR','RIG','KEDUANYA'].includes(area)||!['RENDAH','SEDANG','TINGGI'].includes(severity)||!description||!action) throw httpError(400,'Lengkapi kode, nama, area, risiko, definisi, dan saran kategori.');
    const created=await jsonQuery(`DECLARE @id INT; INSERT dbo.HazardType(code,name,area_type,description,default_severity,recommended_action) VALUES (${sqlAscii(code)},${sqlText(name)},${sqlAscii(area)},${sqlText(description)},${sqlAscii(severity)},${sqlText(action)}); SET @id=SCOPE_IDENTITY(); INSERT dbo.AuditEvent(user_id,action_code,entity_type,entity_id,detail) VALUES (${user.user_id},'HAZARD_TYPE_CREATED','HazardType',CONVERT(nvarchar(80),@id),${sqlText(name)}); SELECT (SELECT @id AS hazard_type_id FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS result;`);
    inspectionConfigCache.invalidate();
    return sendJson(response,201,{hazard_type_id:created.hazard_type_id});
  }
  const hazardConfig=pathname.match(/^\/api\/hazard-types\/(\d+)$/);
  if (method === 'PATCH' && hazardConfig) {
    requireRole(user,['admin']); const id=intValue(hazardConfig[1],'ID kategori'); const body=await jsonBody(request); const name=String(body.name||'').trim().slice(0,140),area=String(body.area_type||'').toUpperCase(),severity=String(body.default_severity||'').toUpperCase(),description=String(body.description||'').trim().slice(0,700),action=String(body.recommended_action||'').trim().slice(0,700),active=Boolean(body.is_active);
    if (!name||!['GUDANG','KANTOR','RIG','KEDUANYA'].includes(area)||!['RENDAH','SEDANG','TINGGI'].includes(severity)||!description||!action) throw httpError(400,'Lengkapi nama, area, risiko, definisi, dan saran kategori.');
    const exists=await jsonQuery(`SELECT hazard_type_id FROM dbo.HazardType WHERE hazard_type_id=${id} FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;`); if (!exists) throw httpError(404,'Kategori bahaya tidak ditemukan.');
    await executeSql(`UPDATE dbo.HazardType SET name=${sqlText(name)},area_type=${sqlAscii(area)},default_severity=${sqlAscii(severity)},description=${sqlText(description)},recommended_action=${sqlText(action)},is_active=${active?1:0} WHERE hazard_type_id=${id}; INSERT dbo.AuditEvent(user_id,action_code,entity_type,entity_id,detail) VALUES (${user.user_id},'HAZARD_TYPE_UPDATED','HazardType',${sqlText(id)},${sqlText(name)});`,{database:databaseName});
    inspectionConfigCache.invalidate();
    return sendJson(response,200,{ok:true});
  }
  if (method === 'GET' && pathname === '/api/models') {
    const models = await jsonQuery(`SELECT mv.model_version_id,mv.name,mv.version,mv.engine,mv.status,mv.notes,CONVERT(varchar(33),mv.created_at,126) AS created_at,CONVERT(varchar(33),mv.trained_at,126) AS trained_at,JSON_QUERY((SELECT d.dataset_id,d.name,d.version FROM dbo.ModelTrainingDataset link JOIN dbo.Dataset d ON d.dataset_id=link.dataset_id WHERE link.model_version_id=mv.model_version_id FOR JSON PATH)) AS training_datasets FROM dbo.ModelVersion mv ORDER BY CASE mv.status WHEN 'ACTIVE' THEN 0 WHEN 'DEMO_ONLY' THEN 1 ELSE 2 END,mv.created_at DESC FOR JSON PATH;`) || [];
    return sendJson(response, 200, { model: models[0] || null, models });
  }
  if (method === 'POST' && pathname === '/api/models') {
    requireRole(user,['admin']); const body=await jsonBody(request); const name=String(body.name||'').trim().slice(0,120),version=String(body.version||'').trim().slice(0,60),engine=String(body.engine||'').trim().slice(0,80),artifact=String(body.artifact_uri||'').trim().slice(0,500),notes=String(body.notes||'').slice(0,700);
    if (!name||!version||!engine) throw httpError(400,'Nama, versi, dan engine model wajib diisi.');
    if (/^https?:\/\//i.test(artifact)) throw httpError(400,'Artefak model harus berada pada penyimpanan lokal yang disetujui.');
    const datasetSql = body.training_dataset_id ? String(intValue(body.training_dataset_id,'Dataset pelatihan')) : 'NULL';
    const created=await jsonQuery(`SET XACT_ABORT ON; BEGIN TRANSACTION; DECLARE @id INT,@datasetReady BIT=1;
${datasetSql === 'NULL' ? '' : `IF NOT EXISTS(SELECT 1 FROM dbo.Dataset WITH(UPDLOCK,HOLDLOCK) WHERE dataset_id=${datasetSql} AND status='APPROVED') SET @datasetReady=0;`}
IF @datasetReady=1 BEGIN
INSERT dbo.ModelVersion(name,version,engine,artifact_uri,status,trained_at,notes) VALUES (${sqlText(name)},${sqlAscii(version)},${sqlAscii(engine)},${sqlText(artifact)},'DEMO_ONLY',${body.trained_at&&/^\d{4}-\d{2}-\d{2}$/.test(body.trained_at)?`CONVERT(datetime2(0),${sqlText(body.trained_at)})`:'NULL'},${sqlText(notes)}); SET @id=SCOPE_IDENTITY(); ${datasetSql==='NULL'?'':`INSERT dbo.ModelTrainingDataset(model_version_id,dataset_id) VALUES (@id,${datasetSql});`} INSERT dbo.AuditEvent(user_id,action_code,entity_type,entity_id,detail) VALUES (${user.user_id},'MODEL_VERSION_REGISTERED','ModelVersion',CONVERT(nvarchar(80),@id),${sqlText(`${name} ${version}; status DEMO_ONLY`)});
END; COMMIT TRANSACTION; SELECT @datasetReady AS dataset_ready,@id AS model_version_id FOR JSON PATH,WITHOUT_ARRAY_WRAPPER;`);
    if (created?.dataset_ready === false) throw httpError(409, 'Dataset pelatihan sudah dihapus atau belum berstatus APPROVED. Muat ulang daftar dataset.');
    if (!Number.isSafeInteger(created?.model_version_id)) throw httpError(503, 'Hasil pencatatan model belum terkonfirmasi. Muat ulang halaman.');
    return sendJson(response,201,{model_version_id:created.model_version_id,status:'DEMO_ONLY'});
  }
  if (method === 'GET' && pathname === '/api/dashboard') {
    const stats = await jsonQuery(`SELECT (SELECT COUNT(*) FROM dbo.Analysis WHERE archived_at IS NULL) AS total,(SELECT COUNT(*) FROM dbo.Analysis WHERE archived_at IS NULL AND result_status='HAZARD_FOUND') AS found,(SELECT COUNT(*) FROM dbo.AnalysisFeedback f JOIN dbo.Analysis a ON a.analysis_id=f.analysis_id WHERE a.archived_at IS NULL) AS feedback_count,(SELECT COUNT(*) FROM dbo.DatasetItem WHERE label_status='VERIFIED') AS dataset_items FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;`) || { total: 0, found: 0, feedback_count: 0, dataset_items: 0 };
    const recent = await jsonQuery(`SELECT TOP (6) a.analysis_id,a.result_status,CONVERT(varchar(33),a.analyzed_at,126) AS analyzed_at,ia.original_name,wa.name AS area_name,wa.area_type,(SELECT TOP (1) f.corrected_label FROM dbo.AnalysisFeedback f WHERE f.analysis_id=a.analysis_id ORDER BY f.created_at DESC,f.feedback_id DESC) AS feedback_label FROM dbo.Analysis a JOIN dbo.ImageAsset ia ON ia.image_id=a.image_id LEFT JOIN dbo.WorkArea wa ON wa.work_area_id=ia.work_area_id WHERE a.archived_at IS NULL ORDER BY a.analyzed_at DESC FOR JSON PATH;`) || [];
    return sendJson(response, 200, { stats, recent });
  }
  if (method === 'GET' && pathname === '/api/analyses') {
    const scope = archiveListScope(url.searchParams.get('archived'), user.role);
    const conditions = [scope.condition];
    if (url.searchParams.get('q')) { const value = url.searchParams.get('q').slice(0, 100).replace(/[\[\]%_]/g, c => `[${c}]`); conditions.push(`(ia.original_name LIKE ${sqlText(`%${value}%`)} OR wa.name LIKE ${sqlText(`%${value}%`)})`); }
    if (url.searchParams.get('area')) conditions.push(`wa.work_area_id=${intValue(url.searchParams.get('area'), 'Area')}`);
    const allowedStatuses = ['HAZARD_FOUND','REVIEW_REQUIRED','NO_VISIBLE_HAZARD','UNABLE_TO_ASSESS','FAILED'];
    if (url.searchParams.get('status') && allowedStatuses.includes(url.searchParams.get('status'))) conditions.push(`a.result_status=${sqlAscii(url.searchParams.get('status'))}`);
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const totalValue = await jsonQuery(`SELECT COUNT(*) AS total FROM dbo.Analysis a JOIN dbo.ImageAsset ia ON ia.image_id=a.image_id LEFT JOIN dbo.WorkArea wa ON wa.work_area_id=ia.work_area_id ${where} FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;`);
    const analyses = await jsonQuery(`SELECT TOP (200) a.analysis_id,a.result_status,CONVERT(varchar(33),a.analyzed_at,126) AS analyzed_at,CAST(CASE WHEN a.archived_at IS NULL THEN 0 ELSE 1 END AS BIT) AS archived,CONVERT(varchar(33),a.archived_at,126) AS archived_at,a.archived_by_user_id,au.full_name AS archived_by_name,ia.image_id,ia.original_name,wa.name AS area_name,wa.area_type,(SELECT TOP (1) f.corrected_label FROM dbo.AnalysisFeedback f WHERE f.analysis_id=a.analysis_id ORDER BY f.created_at DESC,f.feedback_id DESC) AS feedback_label FROM dbo.Analysis a JOIN dbo.ImageAsset ia ON ia.image_id=a.image_id LEFT JOIN dbo.WorkArea wa ON wa.work_area_id=ia.work_area_id LEFT JOIN dbo.AppUser au ON au.user_id=a.archived_by_user_id ${where} ORDER BY ${scope.archived ? 'a.archived_at' : 'a.analyzed_at'} DESC,a.analysis_id DESC FOR JSON PATH;`) || [];
    return sendJson(response, 200, { total: totalValue?.total || 0, archived: scope.archived, analyses });
  }
  if (method === 'POST' && pathname === '/api/analyses') {
    await ensureInspectionDatabase();
    const form = await request.formData();
    const areaId = intValue(form.get('work_area_id'), 'Area');
    const selectedFile = form.get('image'); const photo = await sanitizePhotoBinary(selectedFile);
    const { area: workArea, hazards } = await fetchInspectionConfig(areaId);
    if (!workArea) throw httpError(400, 'Area kerja tidak ditemukan atau sudah dinonaktifkan.');
    const checksum = crypto.createHash('sha256').update(photo.buffer).digest('hex');
    const duplicate = await jsonQuery(`SELECT TOP (1) image_id,work_area_id,origin_type FROM dbo.ImageAsset WHERE checksum=${sqlAscii(checksum)} ORDER BY image_id FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;`);
    if (duplicate) {
      if (duplicate.work_area_id !== areaId || duplicate.origin_type !== 'INSPEKSI') throw httpError(409, 'Foto identik sudah tercatat dengan konteks lain. Gunakan salinan foto yang telah diizinkan untuk konteks ini.');
    }
    const profile = inferenceProfile(form.get('performance_profile') || 'hemat').name;
    let inference = null, inferenceError = '', chosenModel = String(form.get('vision_model') || '').trim().slice(0,120);
    const startedAt = Date.now();
    try {
      const available = await listOllamaVisionModels();
      if (!chosenModel) chosenModel = available.find(model => model.name === 'gemma3:4b')?.name || available[0]?.name || '';
      if (!chosenModel) throw new Error('Belum ada model vision lokal yang terpasang pada Ollama.');
      inference = await withInferenceLock(user.user_id, async () => {
        let detector = null;
        try { detector = await rigTrainingApi.detect(photo.buffer,hazards); }
        catch { detector = { available:false,note:'Model rig belum dapat dipakai; pemeriksaan menggunakan Gemma.' }; }
        return analyzeWithOllama(photo.buffer, chosenModel, workArea, hazards, { profile,useExamples:form.get('use_examples')!=='off',
          detector: detector?.available ? { ...detector,enabled:true } : null });
      });
      chosenModel = inference.model_name;
    } catch (error) {
      if (error.code === 'AI_BUSY') throw error;
      inferenceError = String(error.message || 'Analisis model lokal gagal.').slice(0,700);
      console.error('[ollama] VLM analysis unavailable:', inferenceError);
    }
    const latencyMs = Math.max(0, Date.now() - startedAt);
    const resultStatus = inference?.status === 'POTENSI_TIDAK_AMAN' ? 'HAZARD_FOUND' : inference?.status === 'TIDAK_TAMPAK_BAHAYA' ? 'NO_VISIBLE_HAZARD' : inference ? 'REVIEW_REQUIRED' : 'UNABLE_TO_ASSESS';
    const processingStatus = inference ? 'COMPLETED' : 'FAILED';
    const modelVersionTag = chosenModel.length <= 60 ? chosenModel : `${chosenModel.slice(0, 47)}-${crypto.createHash('sha256').update(chosenModel).digest('hex').slice(0, 12)}`;
    // An admin may permanently remove the preflight duplicate during inference.
    // Keep a new candidate available until SQL confirms which asset it used.
    const fileName = `${crypto.randomUUID()}.${photo.extension}`;
    const filePath = path.join(uploadDir, fileName);
    const relativeUri = `uploads/${fileName}`;
    await fs.promises.writeFile(filePath, photo.buffer, { flag: 'wx' });
    try {
      const modelSql = inference
        ? `DECLARE @modelId INT; IF EXISTS(SELECT 1 FROM dbo.ModelVersion WHERE name=N'Ollama lokal' AND version=${sqlAscii(modelVersionTag)}) BEGIN UPDATE dbo.ModelVersion SET engine='OLLAMA_VISION',status='ACTIVE',notes=N'Model visi Ollama lokal yang dipilih untuk analisis foto.' WHERE name=N'Ollama lokal' AND version=${sqlAscii(modelVersionTag)}; SET @modelId=(SELECT TOP (1) model_version_id FROM dbo.ModelVersion WHERE name=N'Ollama lokal' AND version=${sqlAscii(modelVersionTag)}); END ELSE BEGIN INSERT dbo.ModelVersion(name,version,engine,status,notes) VALUES (N'Ollama lokal',${sqlAscii(modelVersionTag)},'OLLAMA_VISION','ACTIVE',N'Model visi Ollama lokal.'); SET @modelId=SCOPE_IDENTITY(); END;`
        : `DECLARE @modelId INT=(SELECT TOP (1) model_version_id FROM dbo.ModelVersion WHERE status='DEMO_ONLY' ORDER BY created_at DESC); IF @modelId IS NULL THROW 51000,'Model versi belum dikonfigurasi.',1;`;
      const predictionSql = inference
        ? `INSERT dbo.AnalysisVlmPrediction(analysis_id,provider,model_name,predicted_status,summary,raw_json,latency_ms,prompt_version) VALUES (@id,'OLLAMA',${sqlText(chosenModel)},${sqlAscii(inference.status)},${sqlText(inference.summary)},${sqlText(inference.raw_json)},${latencyMs},'k3-vision-3-examples');`
        : '';
      const findingsSql = (inference?.findings || []).map(finding => `INSERT dbo.Finding(analysis_id,hazard_type_id,severity,confidence,bbox_x,bbox_y,bbox_width,bbox_height,description) VALUES (@id,${finding.hazard_type_id},${sqlAscii(finding.severity)},${finding.confidence},NULL,NULL,NULL,NULL,${sqlText(finding.description)});`).join(' ');
      const detail = inference ? `${chosenModel}; ${inference.status}; ${latencyMs} ms` : `Ollama belum dapat menilai foto: ${inferenceError}`;
      const inserted = await jsonQuery(`SET XACT_ABORT ON; BEGIN TRANSACTION; DECLARE @imageId INT,@id INT,@newImage BIT=0,@contextConflict BIT=0; SELECT @imageId=image_id,@contextConflict=CASE WHEN work_area_id=${areaId} AND origin_type='INSPEKSI' THEN 0 ELSE 1 END FROM dbo.ImageAsset WITH (UPDLOCK,HOLDLOCK) WHERE checksum=${sqlAscii(checksum)}; IF @contextConflict=0 BEGIN IF @imageId IS NULL BEGIN INSERT dbo.ImageAsset(work_area_id,uploaded_by_user_id,file_uri,original_name,mime_type,file_size_bytes,origin_type,checksum) VALUES (${areaId},${user.user_id},${sqlText(relativeUri)},${sqlText(cleanImageName(selectedFile.name))},${sqlAscii(photo.mime)},${photo.buffer.length},'INSPEKSI',${sqlAscii(checksum)}); SET @imageId=SCOPE_IDENTITY(); SET @newImage=1; END; ${modelSql} INSERT dbo.Analysis(image_id,model_version_id,created_by_user_id,processing_status,result_status,error_message) VALUES (@imageId,@modelId,${user.user_id},${sqlAscii(processingStatus)},${sqlAscii(resultStatus)},${inference ? 'NULL' : sqlText(inferenceError)}); SET @id=SCOPE_IDENTITY(); ${predictionSql} ${findingsSql} INSERT dbo.AuditEvent(user_id,action_code,entity_type,entity_id,detail) VALUES (${user.user_id},'VLM_ANALYSIS_CREATED','Analysis',CONVERT(nvarchar(80),@id),${sqlText(detail)}); END; COMMIT TRANSACTION; SELECT (SELECT @id AS analysis_id,@newImage AS new_image,@contextConflict AS context_conflict FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS result;`);
      if (inserted?.context_conflict) {
        await fs.promises.unlink(filePath).catch(() => {});
        throw httpError(409, 'Foto identik sudah tercatat dengan konteks lain. Gunakan salinan foto yang telah diizinkan untuk konteks ini.');
      }
      if (!inserted?.analysis_id || typeof inserted.new_image !== 'boolean') throw httpError(503, 'Hasil penyimpanan foto belum dapat dipastikan. Muat ulang riwayat sebelum mencoba lagi.');
      if (!inserted.new_image) await fs.promises.unlink(filePath).catch(() => { console.warn('[storage] Unused inspection upload candidate could not be cleaned.'); });
      return sendJson(response, 201, { analysis_id: inserted.analysis_id, result_status: resultStatus, model_name: inference?.model_name || null, inference_ms: inference ? latencyMs : null, performance: inference?.performance || null });
    } catch (error) { /* Keep the candidate if SQL's commit outcome is unknown. */ throw error; }
  }
  if (method === 'GET' && (match = pathname.match(/^\/api\/analyses\/(\d+)$/))) {
    const id = intValue(match[1], 'ID pemeriksaan');
    const analysis = await jsonQuery(`SELECT a.analysis_id,a.image_id,a.result_status,a.processing_status,CONVERT(varchar(33),a.analyzed_at,126) AS analyzed_at,CAST(CASE WHEN a.archived_at IS NULL THEN 0 ELSE 1 END AS BIT) AS archived,CONVERT(varchar(33),a.archived_at,126) AS archived_at,a.archived_by_user_id,au.full_name AS archived_by_name,a.error_message,ia.original_name,wa.name AS area_name,wa.area_type,mv.name AS model_name,mv.version AS model_version FROM dbo.Analysis a JOIN dbo.ImageAsset ia ON ia.image_id=a.image_id LEFT JOIN dbo.WorkArea wa ON wa.work_area_id=ia.work_area_id JOIN dbo.ModelVersion mv ON mv.model_version_id=a.model_version_id LEFT JOIN dbo.AppUser au ON au.user_id=a.archived_by_user_id WHERE a.analysis_id=${id}${analysisVisibilityCondition(user.role)} FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;`);
    if (!analysis) throw httpError(404, 'Pemeriksaan tidak ditemukan.');
    const findings = await jsonQuery(`SELECT f.finding_id,h.name AS hazard_name,f.severity,f.confidence,f.bbox_x,f.bbox_y,f.bbox_width,f.bbox_height,f.description,h.recommended_action FROM dbo.Finding f JOIN dbo.HazardType h ON h.hazard_type_id=f.hazard_type_id WHERE f.analysis_id=${id} FOR JSON PATH;`) || [];
    const prediction = await jsonQuery(`SELECT provider,model_name,predicted_status,summary,latency_ms,prompt_version,JSON_QUERY(raw_json,'$.learning_context') AS learning_context,CONVERT(varchar(33),created_at,126) AS created_at FROM dbo.AnalysisVlmPrediction WHERE analysis_id=${id} FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;`);
    const feedback = await jsonQuery(`SELECT TOP (1) f.feedback_id,f.corrected_label,f.notes,CONVERT(varchar(33),f.created_at,126) AS created_at,u.full_name AS user_name FROM dbo.AnalysisFeedback f JOIN dbo.AppUser u ON u.user_id=f.user_id WHERE f.analysis_id=${id} ORDER BY f.created_at DESC,f.feedback_id DESC FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;`);
    return sendJson(response, 200, { analysis, findings, prediction, feedback });
  }
  if (method === 'PATCH' && (match = pathname.match(/^\/api\/analyses\/(\d+)\/archive$/))) {
    requireRole(user, ['admin']);
    const id = intValue(match[1], 'ID pemeriksaan');
    const archived = archiveState(await jsonBody(request));
    const result = await jsonQuery(archiveTransaction(id, user.user_id, archived));
    if (!result?.found) throw httpError(404, 'Pemeriksaan tidak ditemukan.');
    const { found, ...record } = result;
    return sendJson(response, 200, { ok: true, ...record });
  }
  if (method === 'DELETE' && (match = pathname.match(/^\/api\/analyses\/(\d+)$/))) {
    requireRole(user, ['admin']);
    const id = intValue(match[1], 'ID pemeriksaan');
    requirePermanentDelete(await jsonBody(request));
    const target = await jsonQuery(`SELECT analysis_id,CAST(CASE WHEN archived_at IS NULL THEN 0 ELSE 1 END AS BIT) AS archived FROM dbo.Analysis WHERE analysis_id=${id} FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;`);
    if (!target) throw httpError(404, 'Pemeriksaan tidak ditemukan.');
    if (!target.archived) throw httpError(409, 'Arsipkan pemeriksaan dahulu sebelum menghapusnya permanen.');
    const denied = await jsonQuery(`SELECT name,permission FROM (VALUES ${deletePermissions.map(([name,permission]) => `(${sqlText(name)},${sqlAscii(permission)})`).join(',')}) AS needed(name,permission) WHERE OBJECT_ID(N'dbo.'+name,N'U') IS NOT NULL AND ISNULL(HAS_PERMS_BY_NAME(N'dbo.'+name,'OBJECT',permission),0)<>1 FOR JSON PATH;`) || [];
    if (denied.length) throw httpError(403, `Akun Windows server belum memiliki izin untuk menghapus permanen: ${denied.map(item => `${item.name} (${item.permission})`).join(', ')}.`);
    // The locked transaction repeats the state check because restore/another
    // delete may run after the read-only preflight above.
    const result = await jsonQuery(permanentDeleteTransaction(id, user.user_id));
    if (!result || typeof result.found !== 'boolean' || typeof result.archived !== 'boolean' || typeof result.deleted !== 'boolean' || typeof result.image_retained !== 'boolean') throw httpError(503, 'Hasil penghapusan belum dapat dipastikan. Muat ulang arsip sebelum mencoba lagi.', 'DELETE_RESULT_UNKNOWN');
    if (!result.found) throw httpError(404, 'Pemeriksaan tidak ditemukan.');
    if (!result.archived) throw httpError(409, 'Pemeriksaan sudah dipulihkan. Arsipkan dahulu sebelum menghapus permanen.');
    if (!result.deleted) throw httpError(500, 'Penghapusan permanen belum diselesaikan.');
    const record = { ok: true, analysis_id: id, deleted: true, image_retained: Boolean(result.image_retained) };
    if (!result.image_retained) {
      const cleanup = await cleanupOrphanPhoto({ projectRoot: root, privateDir, uploadDir, fileUri: result.orphan_file_uri });
      record.file_deleted = cleanup.file_deleted;
      if (cleanup.cleanup_warning) {
        record.cleanup_warning = cleanup.cleanup_warning;
        console.error(`[storage] Orphan photo cleanup pending for analysis ${id}: ${cleanup.cleanup_code}`);
      }
    }
    return sendJson(response, 200, record);
  }
  if (method === 'POST' && (match = pathname.match(/^\/api\/analyses\/(\d+)\/feedback$/))) {
    const id = intValue(match[1], 'ID pemeriksaan'); const body = await jsonBody(request);
    const label = String(body.corrected_label || '').toUpperCase();
    if (!['TIDAK_AMAN','TIDAK_TAMPAK_BAHAYA','RAGU'].includes(label)) throw httpError(400, 'Pilih label tidak aman, tidak tampak bahaya, atau ragu.');
    const notes = String(body.notes || '').trim().slice(0,1200);
    // Serialize this check with archive/restore so no correction can be written
    // between checking an active inspection and an admin archiving it.
    const saved = await jsonQuery(`SET XACT_ABORT ON; BEGIN TRANSACTION; DECLARE @found BIT=0,@archived BIT=0; SELECT @found=1,@archived=CASE WHEN archived_at IS NULL THEN 0 ELSE 1 END FROM dbo.Analysis WITH (UPDLOCK,HOLDLOCK) WHERE analysis_id=${id}; IF @found=1 AND @archived=0 BEGIN INSERT dbo.AnalysisFeedback(analysis_id,user_id,corrected_label,notes) VALUES (${id},${user.user_id},${sqlAscii(label)},${sqlText(notes)}); INSERT dbo.AuditEvent(user_id,action_code,entity_type,entity_id,detail) VALUES (${user.user_id},'VLM_FEEDBACK_SAVED','Analysis',${sqlText(id)},${sqlText(label)}); END; COMMIT TRANSACTION; SELECT @found AS found,@archived AS archived FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;`);
    if (!saved?.found || (saved.archived && user.role !== 'admin')) throw httpError(404, 'Pemeriksaan tidak ditemukan.');
    if (saved.archived) throw httpError(409, 'Pemeriksaan berada dalam arsip. Pulihkan dahulu untuk menyimpan koreksi.');
    return sendJson(response, 201, { ok: true, corrected_label: label });
  }
  if (method === 'GET' && pathname === '/api/datasets') {
    const datasets = await jsonQuery(`SELECT d.dataset_id,d.name,d.version,d.status,d.dataset_kind,d.notes,CONVERT(varchar(33),d.created_at,126) AS created_at,u.full_name AS created_by,(SELECT COUNT(*) FROM dbo.DatasetItem di WHERE di.dataset_id=d.dataset_id AND di.is_excluded=0) AS item_count,(SELECT COUNT(*) FROM dbo.DatasetItem di WHERE di.dataset_id=d.dataset_id AND di.is_excluded=1) AS excluded_count,(SELECT COUNT(*) FROM dbo.DatasetItem di WHERE di.dataset_id=d.dataset_id AND di.label_status='VERIFIED' AND di.is_excluded=0) AS verified_count FROM dbo.Dataset d JOIN dbo.AppUser u ON u.user_id=d.created_by_user_id ORDER BY d.created_at DESC FOR JSON PATH;`) || [];
    return sendJson(response, 200, { datasets });
  }
  const datasetDelete = pathname.match(/^\/api\/datasets\/(\d+)$/);
  if (method === 'DELETE' && datasetDelete) {
    requireRole(user, ['admin']);
    const id = intValue(datasetDelete[1], 'ID dataset');
    // Reserve before the first await so exports/imports cannot start in the gap.
    if (datasetDeletions.has(id) || datasetReaders.has(id)) throw httpError(409, 'Dataset sedang digunakan untuk ekspor atau persiapan evaluasi. Tunggu proses selesai sebelum menghapus.', 'DATASET_IN_USE');
    datasetDeletions.add(id);
    try {
      const confirmationName = requireDatasetDelete(await jsonBody(request));
      await ensureInspectionDatabase();
      const target = await jsonQuery(`SELECT dataset_id,dataset_kind FROM dbo.Dataset WHERE dataset_id=${id} FOR JSON PATH,WITHOUT_ARRAY_WRAPPER;`);
      if (!target) throw httpError(404, 'Dataset tidak ditemukan. Muat ulang daftar dataset.');
      const denied = await jsonQuery(`SELECT name,permission FROM (VALUES ${datasetDeletePermissions.map(([name,permission]) => `(${sqlText(name)},${sqlAscii(permission)})`).join(',')}) AS needed(name,permission) WHERE ISNULL(HAS_PERMS_BY_NAME(N'dbo.'+name,'OBJECT',permission),0)<>1 FOR JSON PATH;`) || [];
      if (denied.length) throw httpError(403, `Akun Windows server belum memiliki izin menghapus dataset: ${denied.map(item => `${item.name} (${item.permission})`).join(', ')}.`, 'DATASET_DELETE_PERMISSION');
      let result;
      try { result = await jsonQuery(datasetDeleteTransaction(id, user.user_id, confirmationName)); }
      catch (error) {
        // The SQL call may have committed before its acknowledgement was lost.
        throw httpError(503, 'Server belum dapat memastikan hasil penghapusan. Tutup popup dan muat ulang daftar dataset sebelum mencoba kembali. Berkas foto tetap disimpan sampai hasil terkonfirmasi.', 'DATASET_DELETE_RESULT_UNKNOWN');
      }
      if (!result || typeof result.found !== 'boolean' || typeof result.deleted !== 'boolean' || typeof result.public_import_suppressed !== 'boolean' || typeof result.reason !== 'string' || result.dataset_id !== id) throw httpError(503, 'Hasil penghapusan belum dapat dipastikan. Muat ulang daftar dataset sebelum mencoba kembali.', 'DATASET_DELETE_RESULT_UNKNOWN');
      const reasons = { NOT_FOUND: 'Dataset tidak ditemukan. Muat ulang daftar dataset.', NAME_MISMATCH: 'Nama dataset berubah. Tutup popup dan muat ulang daftar sebelum menghapus.', MODEL_LINKED: 'Dataset ini masih terhubung ke versi model dan diperlukan untuk riwayat pelatihannya.', ACTIVE_EVALUATION: 'Evaluasi dataset masih berjalan. Selesaikan atau batalkan evaluasi dan tunggu hingga berhenti sebelum menghapus.' };
      if (result.reason) throw httpError(result.reason === 'NOT_FOUND' ? 404 : 409, reasons[result.reason] || 'Dataset belum dapat dihapus.', `DATASET_DELETE_${result.reason}`);
      if (!result.found || !result.deleted) throw httpError(503, 'Penghapusan belum dikonfirmasi server. Muat ulang daftar dataset.', 'DATASET_DELETE_RESULT_UNKNOWN');
      const cleanupConfirmed = Number.isSafeInteger(result.photos_deleted) && result.photos_deleted >= 0 && Array.isArray(result.orphans) && result.orphans.length === result.photos_deleted;
      const cleanup = await cleanupDatasetOrphans({ root, privateDir, uploadDir, deletionConfirmed: cleanupConfirmed }, result.orphans);
      return sendJson(response, 200, { ok: true, deleted: true, dataset_id: id, name: result.name, item_count: result.item_count, evaluation_count: result.evaluation_count, photos_retained: result.photos_retained, public_import_suppressed: result.public_import_suppressed, ...cleanup });
    } finally { datasetDeletions.delete(id); }
  }
  const datasetStatus=pathname.match(/^\/api\/datasets\/(\d+)\/status$/);
  if (method === 'PATCH' && datasetStatus) {
    requireRole(user,['operator','admin']); const id=intValue(datasetStatus[1],'ID dataset'); const body=await jsonBody(request),status=String(body.status||'').toUpperCase();
    if (status==='DRAFT') requireRole(user,['admin']);
    if (!['DRAFT','REVIEW','APPROVED'].includes(status)) throw httpError(400,'Status dataset tidak valid.');
    const result = await jsonQuery(datasetStatusTransaction(id,status,user.user_id));
    const messages = { NOT_FOUND:'Dataset tidak ditemukan.', OBJECT_DATASET:'Tinjauan label bahaya hanya tersedia untuk dataset inspeksi.', BAD_TRANSITION:'Dataset hanya dapat beralih dari Draft ke Tinjauan, lalu Disetujui.', LABELS_PENDING:'Verifikasi seluruh label foto sebelum menyetujui dataset.', LICENSE_PENDING:'Konfirmasikan izin penggunaan seluruh foto sebelum menyetujui dataset.' };
    if (!result || typeof result.reason !== 'string') throw httpError(503,'Status dataset belum dapat dipastikan. Muat ulang halaman sebelum mencoba lagi.');
    if (messages[result.reason]) throw httpError(result.reason==='NOT_FOUND'?404:409,messages[result.reason]);
    return sendJson(response,200,{ok:true,status:result.status});
  }
  if (method === 'POST' && pathname === '/api/datasets') {
    requireRole(user, ['operator','admin']); const body = await jsonBody(request);
    const name = String(body.name || '').trim().slice(0,160), version = String(body.version || '').trim().slice(0,40), notes = String(body.notes || '').slice(0,700);
    if (!name || !version) throw httpError(400, 'Nama dan versi dataset wajib diisi.');
    const created = await jsonQuery(`DECLARE @id INT; INSERT dbo.Dataset(created_by_user_id,name,version,status,notes) VALUES (${user.user_id},${sqlText(name)},${sqlAscii(version)},'DRAFT',${sqlText(notes)}); SET @id=SCOPE_IDENTITY(); INSERT dbo.AuditEvent(user_id,action_code,entity_type,entity_id,detail) VALUES (${user.user_id},'DATASET_CREATED','Dataset',CONVERT(nvarchar(80),@id),${sqlText(name)}); SELECT (SELECT @id AS dataset_id FOR JSON PATH, WITHOUT_ARRAY_WRAPPER) AS result;`);
    return sendJson(response, 201, { dataset_id: created.dataset_id });
  }
  const datasetItemsPath = pathname.match(/^\/api\/datasets\/(\d+)\/items$/);
  if (method === 'GET' && datasetItemsPath) {
    const datasetId = intValue(datasetItemsPath[1], 'ID dataset');
    const dataset = await jsonQuery(`SELECT dataset_id,name,version,status,notes,dataset_kind FROM dbo.Dataset WHERE dataset_id=${datasetId} FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;`); if (!dataset) throw httpError(404,'Dataset tidak ditemukan.');
    if (dataset.dataset_kind === 'PPE_OBJECT') throw httpError(409,'Buka dataset objek melalui penelusur Dataset publik.');
    const limit = intValue(url.searchParams.get('limit') || 24, 'Jumlah foto', 1, 48);
    const requestedOffset = intValue(url.searchParams.get('offset') || 0, 'Posisi halaman', 0);
    const total = Number((await jsonQuery(`SELECT COUNT(*) AS total FROM dbo.DatasetItem WHERE dataset_id=${datasetId} AND is_excluded=0 FOR JSON PATH,WITHOUT_ARRAY_WRAPPER;`))?.total || 0);
    const offset = Math.min(requestedOffset, total ? Math.floor((total - 1) / limit) * limit : 0);
    const items = await jsonQuery(`SELECT di.dataset_item_id,di.dataset_id,di.image_id,ia.original_name,ia.mime_type,ia.file_size_bytes,ia.source_url,ia.author_name,ia.license_name,ia.license_url,ia.attribution_text,ia.license_verified,di.split,di.overall_label,di.label_status,CAST(CASE WHEN EXISTS(SELECT 1 FROM dbo.DatasetTrainingReview r WHERE r.dataset_item_id=di.dataset_item_id AND r.reviewed_at IS NULL) THEN 1 ELSE 0 END AS BIT) AS needs_review,u.full_name AS labeled_by,vu.full_name AS verified_by,CONVERT(varchar(33),di.created_at,126) AS created_at,(SELECT h.name AS hazard_name,a.bbox_x,a.bbox_y,a.bbox_width,a.bbox_height,a.note FROM dbo.Annotation a JOIN dbo.HazardType h ON h.hazard_type_id=a.hazard_type_id WHERE a.dataset_item_id=di.dataset_item_id FOR JSON PATH) AS annotations FROM dbo.DatasetItem di JOIN dbo.ImageAsset ia ON ia.image_id=di.image_id JOIN dbo.AppUser u ON u.user_id=di.labeled_by_user_id LEFT JOIN dbo.AppUser vu ON vu.user_id=di.verified_by_user_id WHERE di.dataset_id=${datasetId} AND di.is_excluded=0 ORDER BY di.created_at DESC,di.dataset_item_id DESC OFFSET ${offset} ROWS FETCH NEXT ${limit} ROWS ONLY FOR JSON PATH;`) || [];
    for (const item of items) { try { item.annotations = JSON.parse(item.annotations || '[]'); } catch { item.annotations = []; } }
    return sendJson(response, 200, { dataset, items, total, offset, limit });
  }
  if (method === 'POST' && datasetItemsPath) {
    requireRole(user, ['operator','admin']); const datasetId = intValue(datasetItemsPath[1], 'ID dataset'); const form = await request.formData();
    const dataset = await jsonQuery(`SELECT dataset_id FROM dbo.Dataset WHERE dataset_id=${datasetId} AND status='DRAFT' AND dataset_kind='HAZARD' FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;`); if (!dataset) throw httpError(404, 'Dataset draft untuk label bahaya tidak ditemukan.');
    const split = String(form.get('split') || 'TRAIN').toUpperCase(); if (!['TRAIN','VALIDATION','TEST'].includes(split)) throw httpError(400, 'Pembagian data tidak valid.');
    const label = String(form.get('overall_label') || 'UNCERTAIN').toUpperCase(); if (!['RISK','NO_LISTED_HAZARD_VISIBLE','UNCERTAIN'].includes(label)) throw httpError(400, 'Label keseluruhan tidak valid.');
    const boxes = parseDatasetAnnotations(form.get('annotations'), label, intValue, httpError);
    if (boxes.length) {
      const hazards = await jsonQuery('SELECT hazard_type_id FROM dbo.HazardType WHERE is_active=1 FOR JSON PATH;') || [];
      if (boxes.some(box => !hazards.some(hazard => hazard.hazard_type_id === box.hazardId))) throw httpError(400,'Salah satu kategori anotasi sudah tidak tersedia. Pilih kategori aktif lalu coba lagi.');
    }
    const selectedFile = form.get('image'); const photo = await sanitizePhotoBinary(selectedFile); const checksum = crypto.createHash('sha256').update(photo.buffer).digest('hex');
    const sourceUrl = String(form.get('source_url') || '').trim().slice(0,1200), licenseUrl = String(form.get('license_url') || '').trim().slice(0,1200);
    for (const value of [sourceUrl, licenseUrl]) if (value && !/^https?:\/\//i.test(value)) throw httpError(400, 'URL sumber dan lisensi harus memakai HTTP atau HTTPS.');
    const license = String(form.get('license_name') || '').trim().slice(0,200); if (!license) throw httpError(400, 'Nama atau jenis izin penggunaan foto wajib diisi.');
    const duplicate = await jsonQuery(`SELECT TOP (1) image_id FROM dbo.ImageAsset WHERE checksum=${sqlAscii(checksum)} FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;`);
    if (duplicate && await jsonQuery(`SELECT dataset_item_id FROM dbo.DatasetItem WHERE dataset_id=${datasetId} AND image_id=${duplicate.image_id} FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;`)) throw httpError(409, 'Foto identik sudah tercatat pada dataset ini.');
    const fileName = `${crypto.randomUUID()}.${photo.extension}`;
    const filePath = path.join(uploadDir, fileName);
    const relativeUri = `uploads/${fileName}`;
    await fs.promises.writeFile(filePath, photo.buffer, { flag: 'wx' });
    try {
      const originalName = cleanImageName(selectedFile.name), author = String(form.get('author_name') || '').slice(0,200), attribution = String(form.get('attribution_text') || '').slice(0,1000), verified = boolValue(form.get('license_verified'));
      const saved = await jsonQuery(datasetUploadTransaction({ datasetId, userId: user.user_id, checksum, relativeUri, originalName, mime: photo.mime, bytes: photo.buffer.length, sourceUrl, author, license, licenseUrl, attribution, verified, split, label, boxes }));
      if (saved?.dataset_locked) {
        await fs.promises.unlink(filePath).catch(() => {});
        throw httpError(409, 'Status dataset berubah. Foto hanya dapat ditambahkan ke dataset inspeksi yang masih Draft.');
      }
      if (saved?.duplicate_item) {
        await fs.promises.unlink(filePath).catch(() => {});
        throw httpError(409, 'Foto identik sudah tercatat pada dataset ini.');
      }
      if (!saved?.dataset_item_id || !saved.image_id || typeof saved.new_image !== 'boolean') throw httpError(503, 'Hasil penyimpanan dataset belum dapat dipastikan. Muat ulang dataset sebelum mencoba lagi.');
      if (!saved.new_image) await fs.promises.unlink(filePath).catch(() => { console.warn('[storage] Unused dataset upload candidate could not be cleaned.'); });
      return sendJson(response, 201, { dataset_item_id: saved.dataset_item_id, image_id: saved.image_id, annotation_count: boxes.length });
    } catch (error) { /* Keep the candidate if SQL's commit outcome is unknown. */ throw error; }
  }
  const verifyItem = pathname.match(/^\/api\/dataset-items\/(\d+)\/verify$/);
  if (method === 'PATCH' && verifyItem) {
    requireRole(user, ['operator','admin']); const itemId = intValue(verifyItem[1], 'ID dataset item');
    const verified = await jsonQuery(`SET XACT_ABORT ON; BEGIN TRANSACTION;
DECLARE @datasetId INT,@kind VARCHAR(20),@found BIT=0,@needsReview BIT=0;
SELECT @datasetId=dataset_id FROM dbo.DatasetItem WHERE dataset_item_id=${itemId};
SELECT @kind=dataset_kind FROM dbo.Dataset WITH(UPDLOCK,HOLDLOCK) WHERE dataset_id=@datasetId;
SELECT @found=1 FROM dbo.DatasetItem WITH(UPDLOCK,HOLDLOCK) WHERE dataset_item_id=${itemId} AND dataset_id=@datasetId;
IF EXISTS(SELECT 1 FROM dbo.DatasetTrainingReview WHERE dataset_item_id=${itemId} AND reviewed_at IS NULL) SET @needsReview=1;
IF EXISTS(SELECT 1 FROM dbo.DatasetItem WHERE dataset_item_id=${itemId} AND is_excluded=1) SET @needsReview=1;
IF @found=1 AND @kind='HAZARD' AND @needsReview=0 BEGIN
 UPDATE dbo.DatasetItem SET label_status='VERIFIED',verified_by_user_id=${user.user_id} WHERE dataset_item_id=${itemId};
 INSERT dbo.AuditEvent(user_id,action_code,entity_type,entity_id) VALUES (${user.user_id},'DATASET_LABEL_VERIFIED','DatasetItem',${sqlText(itemId)});
END;
COMMIT TRANSACTION; SELECT @found AS found,@kind AS dataset_kind,@needsReview AS needs_review FOR JSON PATH,WITHOUT_ARRAY_WRAPPER;`);
    if (typeof verified?.found !== 'boolean') throw httpError(503, 'Hasil verifikasi belum terkonfirmasi. Muat ulang dataset.');
    if (!verified.found) throw httpError(404,'Foto dataset tidak ditemukan.');
    if (verified.needs_review) throw httpError(409,'Tinjau foto dan simpan label terlebih dahulu sebelum verifikasi.');
    if (verified.dataset_kind !== 'HAZARD') throw httpError(409,'Verifikasi label bahaya tidak berlaku untuk anotasi objek sumber.');
    return sendJson(response, 200, { ok: true });
  }
  const media = pathname.match(/^\/api\/media\/(\d+)(\/thumbnail)?$/);
  if (method === 'GET' && media) {
    const imageId = intValue(media[1], 'ID foto');
    const asset = await jsonQuery(`SELECT ia.image_id,ia.file_uri,ia.mime_type,ia.checksum FROM dbo.ImageAsset ia WHERE ia.image_id=${imageId}${imageVisibilityCondition(user.role)} FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;`); if (!asset) throw httpError(404,'Foto tidak ditemukan.');
    if (media[2]) {
      let thumbnail;
      try { thumbnail = await mediaPreview.thumbnail(asset); }
      catch { throw httpError(404, 'Pratinjau foto belum tersedia.'); }
      return send(response, 200, thumbnail, { 'Content-Type': 'image/jpeg', 'Content-Length': thumbnail.length, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
    }
    const filePath = path.resolve(privateDir, asset.file_uri);
    if (!filePath.startsWith(`${path.resolve(privateDir)}${path.sep}`)) throw httpError(403,'Lokasi foto tidak valid.');
    const buffer = await fs.promises.readFile(filePath).catch(() => { throw httpError(404,'Berkas foto tidak tersedia pada penyimpanan lokal.'); });
    return send(response, 200, buffer, { 'Content-Type': asset.mime_type, 'Content-Length': buffer.length, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
  }

  throw httpError(404, 'Endpoint tidak ditemukan.');
}

const mimeTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.ttf':'font/ttf', '.woff2':'font/woff2' };

const server = http.createServer(async (incoming, response) => {
  try {
    const remote = incoming.socket.remoteAddress || '';
    if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') throw httpError(403, 'Server ini hanya menerima koneksi dari perangkat lokal.');
    const request = await requestFrom(incoming);
    const origin = request.headers.get('origin');
    if (!['GET','HEAD','OPTIONS'].includes(request.method) && origin) {
      let originUrl; try { originUrl = new URL(origin); } catch { throw httpError(403,'Sumber permintaan tidak valid.'); }
      if (!['127.0.0.1','localhost','[::1]'].includes(originUrl.hostname) || originUrl.port !== String(port)) throw httpError(403, 'Sumber permintaan tidak diizinkan.');
    }
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return await handleApi(request, response, url);
    if (request.method !== 'GET' && request.method !== 'HEAD') throw httpError(405,'Metode tidak didukung.');
    const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
    if (relative.includes('..') || relative.includes('\\') || relative.startsWith('.')) throw httpError(404,'Halaman tidak ditemukan.');
    const file = path.join(publicDir, relative);
    if (!file.startsWith(`${publicDir}${path.sep}`)) throw httpError(404,'Halaman tidak ditemukan.');
    const data = await fs.promises.readFile(file).catch(() => { throw httpError(404,'Halaman tidak ditemukan.'); });
    send(response, 200, data, {
      'Content-Type': mimeTypes[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
    });
  } catch (error) { sendError(response, error); }
});

await bootstrapDatabase();
await rigTrainingApi.initialize();
await annotationJobs.initialize();
if(databaseReady)await annotationLearning.prepareAreas().catch(error=>console.warn('[learning] Area PDF belum dapat disiapkan:',error.message));
server.listen(port, host, () => {
  console.log(`Lentera K3 berjalan di http://${host}:${port}`);
  if (!databaseReady) console.log('Database belum tersambung. Jalankan sql/database.sql melalui SSMS atau sqlcmd, lalu muat ulang aplikasi.');
});

for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => {
  annotationJobs.stop(); rigTrainingApi.stop(); performanceMonitor.close();
  server.close(() => process.exit(0));
});
