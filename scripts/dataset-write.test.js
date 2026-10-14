import test from 'node:test';
import assert from 'node:assert/strict';
import { datasetStatusTransaction, datasetUploadTransaction } from './dataset-write.js';

const input = overrides => ({
  datasetId: 4, userId: 2, checksum: 'a'.repeat(64), relativeUri: 'uploads/fixture.jpg',
  originalName: 'fixture.jpg', mime: 'image/jpeg', bytes: 123, sourceUrl: 'https://example.test/photo',
  author: 'Fixture publisher', license: 'Internal permission', licenseUrl: '', attribution: 'Fixture attribution',
  verified: true, split: 'TRAIN', label: 'RISK', boxes: [{ hazardId: 7, x: .1, y: .2, width: .3, height: .4 }],
  ...overrides,
});

// These checks cover generated SQL contracts with fixtures; they do not execute
// a SQL Server transaction or claim to verify live lock scheduling.
test('status transitions lock the dataset and write the status and audit atomically', () => {
  for (const status of ['REVIEW', 'APPROVED']) {
    const sql = datasetStatusTransaction(4, status, 2);
    assert.match(sql, /^SET XACT_ABORT ON; BEGIN TRANSACTION;/);
    assert.match(sql, /FROM dbo\.Dataset WITH\(UPDLOCK,HOLDLOCK\) WHERE dataset_id=4;/);
    assert.match(sql, /NOT_FOUND/);
    assert.match(sql, /OBJECT_DATASET/);
    assert.match(sql, /ALREADY_SET/);
    assert.match(sql, /BAD_TRANSITION/);
    assert.match(sql, /IF @reason='' BEGIN\s+UPDATE dbo\.Dataset SET status=/);
    assert.match(sql, /INSERT dbo\.AuditEvent[\s\S]+COMMIT TRANSACTION;/);
    assert.match(sql, /SELECT @state AS status,@reason AS reason FOR JSON PATH,WITHOUT_ARRAY_WRAPPER;/);
    assert.doesNotMatch(sql, /DELETE|TRUNCATE|DROP/);
  }
});

test('approval requires every item to be verified and have a confirmed nonempty permission', () => {
  const sql = datasetStatusTransaction(4, 'APPROVED', 2);
  assert.match(sql, /@state<>'DRAFT'/);
  assert.match(sql, /@state<>'REVIEW'/);
  assert.match(sql, /di\.label_status='VERIFIED'/);
  assert.match(sql, /ia\.license_verified=1 AND NULLIF\(LTRIM\(RTRIM\(ia\.license_name\)\),N''\) IS NOT NULL/);
  assert.match(sql, /FROM dbo\.DatasetItem di WITH\(HOLDLOCK\)/);
  assert.match(sql, /IF @total=0 OR @verified<>@total SET @reason='LABELS_PENDING';/);
  assert.match(sql, /ELSE IF @licensed<>@total SET @reason='LICENSE_PENDING';/);
});

test('upload locks and rechecks draft hazard status before touching assets or labels', () => {
  const sql = datasetUploadTransaction(input());
  assert.match(sql, /^SET XACT_ABORT ON; BEGIN TRANSACTION;/);
  assert.match(sql, /FROM dbo\.Dataset WITH\(UPDLOCK,HOLDLOCK\) WHERE dataset_id=4;/);
  assert.match(sql, /IF @state IS NULL OR @state<>'DRAFT' OR @kind<>'HAZARD' SET @datasetLocked=1;/);
  assert.match(sql, /IF @datasetLocked=0 BEGIN\s+SELECT @imageId=image_id FROM dbo\.ImageAsset WITH\(UPDLOCK,HOLDLOCK\)/);
  assert.match(sql, /IF @duplicateItem=0 BEGIN\s+IF @imageId IS NULL BEGIN/);
  assert.match(sql, /INSERT dbo\.DatasetItem[\s\S]+INSERT dbo\.Annotation[\s\S]+INSERT dbo\.AuditEvent[\s\S]+COMMIT TRANSACTION;/);
  assert.match(sql, /@datasetLocked AS dataset_locked FOR JSON PATH,WITHOUT_ARRAY_WRAPPER;/);
});

test('reused assets preserve inspection origin and publisher fields while enriching only empty inspection permissions', () => {
  const sql = datasetUploadTransaction(input());
  const update = sql.match(/UPDATE dbo\.ImageAsset SET[\s\S]*?;/)?.[0];
  assert.ok(update);
  assert.match(update, /SET license_name=.+,license_url=.+,license_verified=1/);
  assert.match(update, /WHERE image_id=@imageId AND origin_type='INSPEKSI' AND license_verified=0 AND NULLIF\(LTRIM\(RTRIM\(license_name\)\),N''\) IS NULL;/);
  assert.doesNotMatch(update, /SET origin_type|source_url=|author_name=|attribution_text=|work_area_id=|file_uri=/);
  assert.match(sql, /metadata aset bersama dipertahankan/);
});

test('new assets retain attribution and unconfirmed permissions are not silently marked verified', () => {
  const sql = datasetUploadTransaction(input({ verified: false, boxes: [], label: 'UNCERTAIN' }));
  assert.match(sql, /INSERT dbo\.ImageAsset\(work_area_id,uploaded_by_user_id,file_uri,original_name,mime_type,file_size_bytes,origin_type,source_url,author_name,license_name,license_url,attribution_text,license_verified,checksum\)/);
  assert.match(sql, /'DATASET'/);
  assert.match(sql, /Fixture publisher/);
  assert.match(sql, /Fixture attribution/);
  assert.match(sql, /license_verified=0/);
  assert.doesNotMatch(sql, /INSERT dbo\.Annotation/);
});

test('multiline and quoted metadata remain SQL literals instead of script boundaries', () => {
  const sql = datasetUploadTransaction(input({ originalName: "O'Brien\nGO\n:r injected.sql", license: "Internal O'Brien\r\nGO" }));
  assert.match(sql, /O''Brien/);
  assert.match(sql, /NCHAR\(10\)/);
  assert.match(sql, /NCHAR\(13\)/);
  assert.doesNotMatch(sql, /^GO$|^:r injected\.sql$/m);
});
