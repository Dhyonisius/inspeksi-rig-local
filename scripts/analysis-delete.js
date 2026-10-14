import fs from 'node:fs/promises';
import path from 'node:path';
import { sqlText } from './sql-client.js';

const requestError = (status, message) => Object.assign(new Error(message), { status });

export function requirePermanentDelete(body) {
  if (!body || Array.isArray(body) || body.permanent !== true) {
    throw requestError(400, 'Konfirmasi penghapusan permanen harus berupa permanent: true.');
  }
}

// These permissions are checked only when an administrator requests deletion;
// ordinary inspection storage must not require SQL DELETE privileges.
export const deletePermissions = [
  ['Analysis', 'DELETE'], ['AnalysisFeedback', 'DELETE'],
  ['AnalysisVlmPrediction', 'DELETE'], ['Finding', 'DELETE'],
  ['AnalysisReview', 'DELETE'], ['AnalysisReviewRequest', 'DELETE'],
  ['ImageAsset', 'DELETE'], ['AuditEvent', 'INSERT'],
];

export function permanentDeleteTransaction(id, userId) {
  return `SET XACT_ABORT ON;
BEGIN TRANSACTION;
DECLARE @found BIT=0,@archived BIT=0,@deleted BIT=0,@imageRetained BIT=1,@imageId INT,@fileUri NVARCHAR(500);
SELECT @found=1,@archived=CASE WHEN archived_at IS NULL THEN 0 ELSE 1 END,@imageId=image_id
FROM dbo.Analysis WITH (UPDLOCK,HOLDLOCK) WHERE analysis_id=${id};
IF @found=1 AND @archived=1
BEGIN
  /* An exclusive parent lock prevents a concurrent foreign-key attachment while
     deciding whether this photograph has become an orphan. */
  SELECT @fileUri=file_uri FROM dbo.ImageAsset WITH (XLOCK,HOLDLOCK) WHERE image_id=@imageId;
  DELETE FROM dbo.AnalysisFeedback WHERE analysis_id=${id};
  DELETE FROM dbo.AnalysisVlmPrediction WHERE analysis_id=${id};
  DELETE FROM dbo.Finding WHERE analysis_id=${id};
  IF OBJECT_ID(N'dbo.AnalysisReview',N'U') IS NOT NULL DELETE FROM dbo.AnalysisReview WHERE analysis_id=${id};
  IF OBJECT_ID(N'dbo.AnalysisReviewRequest',N'U') IS NOT NULL DELETE FROM dbo.AnalysisReviewRequest WHERE analysis_id=${id};
  DELETE FROM dbo.Analysis WHERE analysis_id=${id};
  IF NOT EXISTS (SELECT 1 FROM dbo.Analysis WHERE image_id=@imageId)
     AND NOT EXISTS (SELECT 1 FROM dbo.DatasetItem WHERE image_id=@imageId)
  BEGIN
    DELETE FROM dbo.ImageAsset WHERE image_id=@imageId;
    SET @imageRetained=0;
  END
  ELSE SET @fileUri=NULL;
  INSERT dbo.AuditEvent(user_id,action_code,entity_type,entity_id,detail)
  VALUES (${userId},'ANALYSIS_PERMANENTLY_DELETED','Analysis',${sqlText(id)},
    N'Pemeriksaan arsip beserta hasil AI dan koreksi dihapus permanen; image_id='+CONVERT(nvarchar(20),@imageId)+
    CASE WHEN @imageRetained=1 THEN N'; foto dipertahankan karena dipakai pemeriksaan lain atau dataset.' ELSE N'; aset foto tanpa referensi ikut dihapus.' END);
  SET @deleted=1;
END;
COMMIT TRANSACTION;
SELECT @found AS found,@archived AS archived,@deleted AS deleted,${id} AS analysis_id,
  @imageRetained AS image_retained,@fileUri AS orphan_file_uri
FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;`;
}

function within(directory, file) {
  const relative = path.relative(directory, file);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

const samePath = (left, right) => process.platform === 'win32'
  ? path.normalize(left).toLowerCase() === path.normalize(right).toLowerCase()
  : path.normalize(left) === path.normalize(right);

// SQL has committed before this function is called. A failure here leaves the
// orphan file on disk and is reported separately from the successful DB deletion.
export async function cleanupOrphanPhoto({ projectRoot, privateDir, uploadDir, fileUri }) {
  try {
    if (typeof fileUri !== 'string' || !fileUri.trim() || fileUri.includes('\0') || path.isAbsolute(fileUri)) {
      throw Object.assign(new Error('Lokasi foto tidak valid.'), { code: 'UNSAFE_PATH' });
    }
    const uploadPath = path.resolve(uploadDir);
    const filePath = path.resolve(privateDir, fileUri);
    if (!within(uploadPath, filePath)) throw Object.assign(new Error('Foto berada di luar folder unggahan.'), { code: 'UNSAFE_PATH' });

    const realRoot = await fs.realpath(projectRoot);
    const realUploads = await fs.realpath(uploadPath);
    // Reject storage junctions/symlinks leading outside the project's actual
    // data/private/uploads directory, including intermediate storage folders.
    if (!samePath(realUploads, path.join(realRoot, 'data', 'private', 'uploads'))) {
      throw Object.assign(new Error('Folder unggahan mengarah ke lokasi lain.'), { code: 'UNSAFE_PATH' });
    }
    const realFile = await fs.realpath(filePath);
    if (!within(realUploads, realFile)) throw Object.assign(new Error('Foto mengarah ke lokasi di luar folder unggahan.'), { code: 'UNSAFE_PATH' });
    const fileInfo = await fs.lstat(filePath);
    if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) throw Object.assign(new Error('Berkas foto bukan file unggahan biasa.'), { code: 'UNSAFE_PATH' });
    await fs.unlink(filePath);
    return { file_deleted: true };
  } catch (error) {
    if (error.code === 'ENOENT') return { file_deleted: true };
    return {
      file_deleted: false,
      cleanup_warning: 'Data pemeriksaan sudah dihapus permanen, tetapi berkas foto belum dapat dibersihkan dari folder unggahan lokal.',
      cleanup_code: String(error.code || 'CLEANUP_FAILED').slice(0, 60),
    };
  }
}
