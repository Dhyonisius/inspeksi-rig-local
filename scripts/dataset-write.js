import { sqlText, sqlAscii } from './sql-client.js';

export function datasetStatusTransaction(id, status, userId) {
  return `SET XACT_ABORT ON; BEGIN TRANSACTION;
DECLARE @state VARCHAR(20),@kind VARCHAR(20),@reason VARCHAR(32)='',@total INT,@verified INT,@licensed INT;
SELECT @state=status,@kind=dataset_kind FROM dbo.Dataset WITH(UPDLOCK,HOLDLOCK) WHERE dataset_id=${id};
IF @state IS NULL SET @reason='NOT_FOUND';
ELSE IF @kind<>'HAZARD' SET @reason='OBJECT_DATASET';
ELSE IF @state=${sqlAscii(status)} SET @reason='ALREADY_SET';
ELSE IF (${sqlAscii(status)}='DRAFT' AND @state<>'REVIEW') OR (${sqlAscii(status)}='REVIEW' AND @state<>'DRAFT') OR (${sqlAscii(status)}='APPROVED' AND @state<>'REVIEW') SET @reason='BAD_TRANSITION';
IF @reason='' AND ${sqlAscii(status)}='APPROVED' BEGIN
 SELECT @total=COUNT(*),@verified=COALESCE(SUM(CASE WHEN di.label_status='VERIFIED' THEN 1 ELSE 0 END),0),@licensed=COALESCE(SUM(CASE WHEN ia.license_verified=1 AND NULLIF(LTRIM(RTRIM(ia.license_name)),N'') IS NOT NULL THEN 1 ELSE 0 END),0)
 FROM dbo.DatasetItem di WITH(HOLDLOCK) JOIN dbo.ImageAsset ia ON ia.image_id=di.image_id WHERE di.dataset_id=${id} AND di.is_excluded=0;
 IF @total=0 OR @verified<>@total SET @reason='LABELS_PENDING';
 ELSE IF @licensed<>@total SET @reason='LICENSE_PENDING';
END;
IF @reason='' BEGIN
 UPDATE dbo.Dataset SET status=${sqlAscii(status)} WHERE dataset_id=${id};
 INSERT dbo.AuditEvent(user_id,action_code,entity_type,entity_id,detail) VALUES(${userId},'DATASET_STATUS_CHANGED','Dataset',${sqlText(id)},${sqlText(status)});
 SET @state=${sqlAscii(status)};
END;
COMMIT TRANSACTION;
SELECT @state AS status,@reason AS reason FOR JSON PATH,WITHOUT_ARRAY_WRAPPER;`;
}

export function datasetUploadTransaction({ datasetId, userId, checksum, relativeUri, originalName, mime, bytes, sourceUrl, author, license, licenseUrl, attribution, verified, split, label, boxes }) {
  return `SET XACT_ABORT ON; BEGIN TRANSACTION;
DECLARE @imageId INT,@itemId INT,@newImage BIT=0,@duplicateItem BIT=0,@datasetLocked BIT=0,@state VARCHAR(20),@kind VARCHAR(20);
SELECT @state=status,@kind=dataset_kind FROM dbo.Dataset WITH(UPDLOCK,HOLDLOCK) WHERE dataset_id=${datasetId};
IF @state IS NULL OR @state<>'DRAFT' OR @kind<>'HAZARD' SET @datasetLocked=1;
IF @datasetLocked=0 BEGIN
 SELECT @imageId=image_id FROM dbo.ImageAsset WITH(UPDLOCK,HOLDLOCK) WHERE checksum=${sqlAscii(checksum)};
 IF @imageId IS NOT NULL AND EXISTS(SELECT 1 FROM dbo.DatasetItem WHERE dataset_id=${datasetId} AND image_id=@imageId) SET @duplicateItem=1;
 IF @duplicateItem=0 BEGIN
  IF @imageId IS NULL BEGIN
   INSERT dbo.ImageAsset(work_area_id,uploaded_by_user_id,file_uri,original_name,mime_type,file_size_bytes,origin_type,source_url,author_name,license_name,license_url,attribution_text,license_verified,checksum)
   VALUES(NULL,${userId},${sqlText(relativeUri)},${sqlText(originalName)},${sqlAscii(mime)},${bytes},'DATASET',${sqlText(sourceUrl)},${sqlText(author)},${sqlText(license)},${sqlText(licenseUrl)},${sqlText(attribution)},${verified ? 1 : 0},${sqlAscii(checksum)});
   SET @imageId=SCOPE_IDENTITY(); SET @newImage=1;
  END ELSE BEGIN
   -- Shared inspection context and publisher metadata must remain stable.
   -- Only an inspection's previously empty permission record is enriched.
   UPDATE dbo.ImageAsset SET license_name=${sqlText(license)},license_url=${sqlText(licenseUrl)},license_verified=${verified ? 1 : 0}
   WHERE image_id=@imageId AND origin_type='INSPEKSI' AND license_verified=0 AND NULLIF(LTRIM(RTRIM(license_name)),N'') IS NULL;
  END;
  INSERT dbo.DatasetItem(dataset_id,image_id,split,overall_label,label_status,labeled_by_user_id) VALUES(${datasetId},@imageId,${sqlAscii(split)},${sqlAscii(label)},'DRAFT',${userId}); SET @itemId=SCOPE_IDENTITY();
  ${boxes.map(box => `INSERT dbo.Annotation(dataset_item_id,hazard_type_id,bbox_x,bbox_y,bbox_width,bbox_height) VALUES(@itemId,${box.hazardId},${box.x},${box.y},${box.width},${box.height});`).join('\n')}
  INSERT dbo.AuditEvent(user_id,action_code,entity_type,entity_id,detail) VALUES(${userId},'DATASET_ITEM_CREATED','DatasetItem',CONVERT(nvarchar(80),@itemId),${sqlText(`${label}; ${boxes.length} anotasi; izin input ${license}; metadata aset bersama dipertahankan`)});
 END;
END;
COMMIT TRANSACTION;
SELECT @itemId AS dataset_item_id,@imageId AS image_id,@newImage AS new_image,@duplicateItem AS duplicate_item,@datasetLocked AS dataset_locked FOR JSON PATH,WITHOUT_ARRAY_WRAPPER;`;
}
