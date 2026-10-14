import { sqlText } from './sql-client.js';
import { cleanupOrphanPhoto } from './analysis-delete.js';

const requestError = (status, message, code = 'DATASET_DELETE_CONFIRMATION') =>
  Object.assign(new Error(message), { status, code });

export function requireDatasetDelete(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.permanent !== true) {
    throw requestError(400, 'Konfirmasi penghapusan dataset harus berupa permanent: true.');
  }
  if (typeof body.confirmation_name !== 'string' || !body.confirmation_name.trim() ||
      body.confirmation_name.length > 160 || /[\u0000-\u001f\u007f]/.test(body.confirmation_name)) {
    throw requestError(400, 'Nama dataset wajib dikonfirmasi untuk penghapusan permanen.');
  }
  // Do not normalize case or whitespace: the locked transaction compares the
  // entered text with the actual dataset name, including trailing whitespace.
  return body.confirmation_name;
}

// Permissions for this optional admin action are checked at the DELETE route,
// rather than making ordinary inspection or dataset reads require DELETE.
export const datasetDeletePermissions = [
  ['Dataset', 'SELECT'], ['Dataset', 'DELETE'],
  ['DatasetItem', 'SELECT'], ['DatasetItem', 'DELETE'],
  ['Annotation', 'SELECT'], ['Annotation', 'DELETE'],
  ['DatasetItemProvenance', 'DELETE'],
  ['DatasetObjectAnnotation', 'SELECT'], ['DatasetObjectAnnotation', 'DELETE'],
  ['DatasetObjectClass', 'DELETE'], ['DatasetExternalItem', 'DELETE'],
  ['DatasetExternalSource', 'SELECT'], ['DatasetExternalSource', 'DELETE'],
  ['EvaluationRun', 'SELECT'], ['EvaluationRun', 'DELETE'],
  ['EvaluationItem', 'SELECT'], ['EvaluationItem', 'DELETE'],
  ['ModelTrainingDataset', 'SELECT'], ['Analysis', 'SELECT'],
  ['ImageAsset', 'SELECT'], ['ImageAsset', 'DELETE'],
  ['DatasetImportSuppression', 'SELECT'], ['DatasetImportSuppression', 'INSERT'],
  ['DatasetImportSuppression', 'UPDATE'], ['AuditEvent', 'INSERT'],
];

function positiveSqlId(value, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw requestError(400, `${label} tidak valid.`, 'DATASET_DELETE_REQUEST');
  }
  return value;
}

export function datasetDeleteTransaction(id, userId, confirmationName) {
  positiveSqlId(id, 'ID dataset');
  positiveSqlId(userId, 'ID admin');
  requireDatasetDelete({ permanent: true, confirmation_name: confirmationName });
  return `SET XACT_ABORT ON;
BEGIN TRANSACTION;
DECLARE @found BIT=0,@deleted BIT=0,@suppressed BIT=0,@reason VARCHAR(40)='',
 @name NVARCHAR(160),@version VARCHAR(40),@kind VARCHAR(20),
 @sourceKey VARCHAR(40),@manifest CHAR(64),@itemCount INT=0,@annotationCount INT=0,
 @objectAnnotationCount INT=0,@evaluationCount INT=0,@evaluationItemCount INT=0,
 @photoCount INT=0,@deletedPhotoCount INT=0,@auditDetail NVARCHAR(1200);
DECLARE @imageIds TABLE(image_id INT NOT NULL PRIMARY KEY);
DECLARE @assets TABLE(image_id INT NOT NULL PRIMARY KEY,file_uri NVARCHAR(500) NOT NULL);
DECLARE @orphans TABLE(image_id INT NOT NULL PRIMARY KEY,file_uri NVARCHAR(500) NOT NULL);

-- The parent lock also serializes dataset uploads, curation, public import
-- batches, and evaluation creation, all of which lock Dataset first.
SELECT @found=1,@name=name,@version=version,@kind=dataset_kind
FROM dbo.Dataset WITH(XLOCK,HOLDLOCK) WHERE dataset_id=${id};
IF @found=0 SET @reason='NOT_FOUND';
ELSE IF CONVERT(varbinary(max),@name)<>CONVERT(varbinary(max),${sqlText(confirmationName)}) SET @reason='NAME_MISMATCH';
ELSE IF EXISTS(SELECT 1 FROM dbo.ModelTrainingDataset WITH(UPDLOCK,HOLDLOCK) WHERE dataset_id=${id}) SET @reason='MODEL_LINKED';
ELSE IF EXISTS(SELECT 1 FROM dbo.EvaluationRun WITH(UPDLOCK,HOLDLOCK)
 WHERE dataset_id=${id} AND status IN('QUEUED','RUNNING','CANCELLING')) SET @reason='ACTIVE_EVALUATION';

IF @reason='' BEGIN
 SELECT @sourceKey=source_key,@manifest=manifest_sha256
 FROM dbo.DatasetExternalSource WITH(UPDLOCK,HOLDLOCK) WHERE dataset_id=${id};
 SELECT @itemCount=COUNT(*) FROM dbo.DatasetItem WITH(UPDLOCK,HOLDLOCK) WHERE dataset_id=${id};
 SELECT @annotationCount=COUNT(*) FROM dbo.Annotation a JOIN dbo.DatasetItem di ON di.dataset_item_id=a.dataset_item_id WHERE di.dataset_id=${id};
 SELECT @objectAnnotationCount=COUNT(*) FROM dbo.DatasetObjectAnnotation WHERE dataset_id=${id};
 SELECT @evaluationCount=COUNT(*) FROM dbo.EvaluationRun WITH(UPDLOCK,HOLDLOCK) WHERE dataset_id=${id};
 SELECT @evaluationItemCount=COUNT(*) FROM dbo.EvaluationItem ei JOIN dbo.EvaluationRun er ON er.evaluation_run_id=ei.evaluation_run_id WHERE er.dataset_id=${id};

 INSERT @imageIds(image_id)
 SELECT image_id FROM dbo.DatasetItem WHERE dataset_id=${id}
 UNION SELECT ei.image_id FROM dbo.EvaluationItem ei JOIN dbo.EvaluationRun er ON er.evaluation_run_id=ei.evaluation_run_id WHERE er.dataset_id=${id};
 -- Exclusive image-parent locks prevent simultaneous foreign-key attachments
 -- while orphan status is determined. EvaluationItem has no ImageAsset FK;
 -- its HOLDLOCK predicate below separately protects snapshot references.
 INSERT @assets(image_id,file_uri)
 SELECT ia.image_id,ia.file_uri FROM dbo.ImageAsset ia WITH(XLOCK,HOLDLOCK)
 JOIN @imageIds wanted ON wanted.image_id=ia.image_id;
 SELECT @photoCount=COUNT(*) FROM @assets;

 IF @sourceKey IS NOT NULL BEGIN
  -- Keep the source/manifest tombstone even after deleting the source row. The
  -- startup importer must consult it before recreating this public dataset.
  IF EXISTS(SELECT 1 FROM dbo.DatasetImportSuppression WITH(UPDLOCK,HOLDLOCK)
    WHERE source_key=@sourceKey AND manifest_sha256=@manifest)
   UPDATE dbo.DatasetImportSuppression SET deleted_dataset_id=${id},dataset_name=@name,
    dataset_version=@version,deleted_by_user_id=${userId},deleted_at=SYSUTCDATETIME()
   WHERE source_key=@sourceKey AND manifest_sha256=@manifest;
  ELSE INSERT dbo.DatasetImportSuppression(source_key,manifest_sha256,deleted_dataset_id,dataset_name,dataset_version,deleted_by_user_id)
   VALUES(@sourceKey,@manifest,${id},@name,@version,${userId});
  SET @suppressed=1;
 END;

 DELETE ei FROM dbo.EvaluationItem ei JOIN dbo.EvaluationRun er ON er.evaluation_run_id=ei.evaluation_run_id WHERE er.dataset_id=${id};
 DELETE FROM dbo.EvaluationRun WHERE dataset_id=${id};
 DELETE a FROM dbo.Annotation a JOIN dbo.DatasetItem di ON di.dataset_item_id=a.dataset_item_id WHERE di.dataset_id=${id};
 DELETE p FROM dbo.DatasetItemProvenance p JOIN dbo.DatasetItem di ON di.dataset_item_id=p.dataset_item_id WHERE di.dataset_id=${id};
 DELETE FROM dbo.DatasetObjectAnnotation WHERE dataset_id=${id};
 DELETE FROM dbo.DatasetExternalItem WHERE dataset_id=${id};
 DELETE FROM dbo.DatasetItem WHERE dataset_id=${id};
 DELETE FROM dbo.DatasetObjectClass WHERE dataset_id=${id};
 DELETE FROM dbo.DatasetExternalSource WHERE dataset_id=${id};
 DELETE FROM dbo.Dataset WHERE dataset_id=${id};

 DELETE ia OUTPUT deleted.image_id,deleted.file_uri INTO @orphans(image_id,file_uri)
 FROM dbo.ImageAsset ia JOIN @assets candidate ON candidate.image_id=ia.image_id
 WHERE NOT EXISTS(SELECT 1 FROM dbo.Analysis WITH(HOLDLOCK) WHERE image_id=ia.image_id)
   AND NOT EXISTS(SELECT 1 FROM dbo.DatasetItem WITH(HOLDLOCK) WHERE image_id=ia.image_id)
   AND NOT EXISTS(SELECT 1 FROM dbo.EvaluationItem WITH(UPDLOCK,HOLDLOCK) WHERE image_id=ia.image_id)
   AND NOT EXISTS(SELECT 1 FROM dbo.ImageAsset shared WITH(HOLDLOCK) WHERE shared.image_id<>ia.image_id AND shared.file_uri=ia.file_uri)
   AND NOT EXISTS(SELECT 1 FROM dbo.EvaluationRun er WITH(HOLDLOCK)
     CROSS APPLY OPENJSON(CASE WHEN ISJSON(er.dataset_snapshot)=1 THEN er.dataset_snapshot ELSE N'{}' END,'$.items')
       WITH(image_id INT '$.image_id') snapshot
     WHERE snapshot.image_id=ia.image_id);
 SELECT @deletedPhotoCount=COUNT(*) FROM @orphans;
 SET @auditDetail=(SELECT @name AS name,@version AS version,@kind AS dataset_kind,
  @itemCount AS items,@annotationCount AS hazard_annotations,@objectAnnotationCount AS object_annotations,
  @evaluationCount AS evaluations,@evaluationItemCount AS evaluation_items,
  @deletedPhotoCount AS photos_deleted,(@photoCount-@deletedPhotoCount) AS photos_retained,
  @suppressed AS public_import_suppressed FOR JSON PATH,WITHOUT_ARRAY_WRAPPER);
 INSERT dbo.AuditEvent(user_id,action_code,entity_type,entity_id,detail)
 VALUES(${userId},'DATASET_DELETED','Dataset',${sqlText(id)},@auditDetail);
 SET @deleted=1;
END;
COMMIT TRANSACTION;
SELECT @found AS found,@deleted AS deleted,@reason AS reason,${id} AS dataset_id,
 @name AS name,@version AS version,@kind AS dataset_kind,
 @itemCount AS item_count,@annotationCount AS annotation_count,@objectAnnotationCount AS object_annotation_count,
 @evaluationCount AS evaluation_count,@evaluationItemCount AS evaluation_item_count,
 @deletedPhotoCount AS photos_deleted,(@photoCount-@deletedPhotoCount) AS photos_retained,
 @suppressed AS public_import_suppressed,
 JSON_QUERY((SELECT image_id,file_uri FROM @orphans ORDER BY image_id FOR JSON PATH)) AS orphans
FOR JSON PATH,WITHOUT_ARRAY_WRAPPER;`;
}

export async function cleanupDatasetOrphans(ctx, rows) {
  // A timeout or incomplete SQL acknowledgement must never cause file removal.
  // The route sets this flag only after validating the committed JSON result.
  if (ctx?.deletionConfirmed !== true || !Array.isArray(rows) || rows.some(row =>
    !row || !Number.isSafeInteger(row.image_id) || row.image_id < 1 ||
    typeof row.file_uri !== 'string' || !row.file_uri.trim())) {
    return { files_deleted: 0, files_pending: Array.isArray(rows) ? rows.length : 0,
      cleanup_warning: 'Hasil penghapusan dataset belum terkonfirmasi. Berkas foto tetap disimpan.' };
  }
  const uniqueRows = [...new Map(rows.map(row => [row.file_uri, row])).values()];
  let filesDeleted = 0, filesPending = 0;
  for (const row of uniqueRows) {
    const result = await cleanupOrphanPhoto({
      projectRoot: ctx.projectRoot || ctx.root, privateDir: ctx.privateDir,
      uploadDir: ctx.uploadDir, fileUri: row.file_uri,
    });
    if (result.file_deleted) filesDeleted++;
    else filesPending++;
  }
  return { files_deleted: filesDeleted, files_pending: filesPending,
    ...(filesPending ? { cleanup_warning: 'Dataset sudah dihapus permanen, tetapi beberapa berkas foto belum dapat dibersihkan dari folder unggahan lokal.' } : {}) };
}
