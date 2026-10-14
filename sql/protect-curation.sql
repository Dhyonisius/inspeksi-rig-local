USE [K3VisionLocal];
GO
IF COL_LENGTH(N'dbo.DatasetItem',N'is_excluded') IS NULL
 ALTER TABLE dbo.DatasetItem ADD is_excluded BIT NOT NULL CONSTRAINT DF_DatasetItem_Excluded DEFAULT 0;
IF COL_LENGTH(N'dbo.DatasetItem',N'exclusion_reason') IS NULL
 ALTER TABLE dbo.DatasetItem ADD exclusion_reason NVARCHAR(300) NULL;
IF COL_LENGTH(N'dbo.DatasetItem',N'excluded_at') IS NULL
 ALTER TABLE dbo.DatasetItem ADD excluded_at DATETIME2(0) NULL;
IF COL_LENGTH(N'dbo.DatasetItem',N'excluded_by_user_id') IS NULL
 ALTER TABLE dbo.DatasetItem ADD excluded_by_user_id INT NULL;
GO
/* Scalar snapshots survive removal of an item/dataset. A resumed PDF import
   must not silently recreate images deliberately deleted by the admin. */
IF OBJECT_ID(N'dbo.RigPdfItemSuppression',N'U') IS NULL
 CREATE TABLE dbo.RigPdfItemSuppression (
  dataset_id INT NOT NULL,
  checksum CHAR(64) NOT NULL,
  original_name NVARCHAR(255) NOT NULL,
  deleted_by_user_id INT NOT NULL,
  deleted_at DATETIME2(0) NOT NULL DEFAULT SYSUTCDATETIME(),
  CONSTRAINT PK_RigPdfItemSuppression PRIMARY KEY(dataset_id,checksum)
 );
GO
