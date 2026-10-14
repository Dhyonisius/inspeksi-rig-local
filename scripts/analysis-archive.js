import { sqlText } from './sql-client.js';

const requestError = (status, message) => Object.assign(new Error(message), { status });

export function archiveListScope(value, role) {
  if (value !== null && !['0', '1'].includes(value)) throw requestError(400, 'Pilihan arsip pemeriksaan tidak valid.');
  const archived = value === '1';
  if (archived && role !== 'admin') throw requestError(403, 'Arsip pemeriksaan hanya tersedia untuk admin.');
  return { archived, condition: `a.archived_at IS ${archived ? 'NOT ' : ''}NULL` };
}

export function archiveState(body) {
  if (!body || Array.isArray(body) || typeof body.archived !== 'boolean') throw requestError(400, 'Status arsip harus berupa true atau false.');
  return body.archived;
}

export const analysisVisibilityCondition = role => role === 'admin' ? '' : ' AND a.archived_at IS NULL';

// An image may be shared by several inspections and by a dataset. Archiving one
// inspection must not hide a photograph still used by an active inspection or dataset.
export const imageVisibilityCondition = role => role === 'admin' ? '' : ` AND (EXISTS (SELECT 1 FROM dbo.Analysis a WHERE a.image_id=ia.image_id AND a.archived_at IS NULL) OR EXISTS (SELECT 1 FROM dbo.DatasetItem di WHERE di.image_id=ia.image_id))`;

export function archiveTransaction(id, userId, archived) {
  const action = archived ? 'ANALYSIS_ARCHIVED' : 'ANALYSIS_RESTORED';
  return `SET XACT_ABORT ON;
BEGIN TRANSACTION;
DECLARE @found BIT=0,@changed BIT=0,@wasArchived BIT,@archivedAt DATETIME2(0),@archivedBy INT;
SELECT @found=1,@wasArchived=CASE WHEN archived_at IS NULL THEN 0 ELSE 1 END
FROM dbo.Analysis WITH (UPDLOCK,HOLDLOCK) WHERE analysis_id=${id};
IF @found=1 AND @wasArchived<>${archived ? 1 : 0}
BEGIN
  UPDATE dbo.Analysis SET archived_at=${archived ? 'SYSUTCDATETIME()' : 'NULL'},archived_by_user_id=${archived ? userId : 'NULL'} WHERE analysis_id=${id};
  INSERT dbo.AuditEvent(user_id,action_code,entity_type,entity_id,detail)
  VALUES (${userId},'${action}','Analysis',${sqlText(id)},${sqlText(archived ? 'Pemeriksaan dihapus dari riwayat aktif dan disimpan dalam arsip.' : 'Pemeriksaan dipulihkan dari arsip ke riwayat aktif.')});
  SET @changed=1;
END;
SELECT @archivedAt=archived_at,@archivedBy=archived_by_user_id FROM dbo.Analysis WHERE analysis_id=${id};
COMMIT TRANSACTION;
SELECT @found AS found,@changed AS changed,${id} AS analysis_id,
  CAST(CASE WHEN @archivedAt IS NULL THEN 0 ELSE 1 END AS BIT) AS archived,
  CONVERT(varchar(33),@archivedAt,126) AS archived_at,@archivedBy AS archived_by_user_id,
  (SELECT full_name FROM dbo.AppUser WHERE user_id=@archivedBy) AS archived_by_name
FOR JSON PATH, WITHOUT_ARRAY_WRAPPER;`;
}
