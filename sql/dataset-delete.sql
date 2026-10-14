/* Permanent admin dataset deletion: durable public-import suppression.
   Run after database.sql, dataset-tools.sql, and public-datasets.sql. */
USE [K3VisionLocal];
GO
SET NOCOUNT ON;
SET XACT_ABORT ON;
SET ANSI_NULLS ON;
SET ANSI_PADDING ON;
SET ANSI_WARNINGS ON;
SET ARITHABORT ON;
SET CONCAT_NULL_YIELDS_NULL ON;
SET QUOTED_IDENTIFIER ON;
SET NUMERIC_ROUNDABORT OFF;
GO

IF OBJECT_ID(N'dbo.Dataset',N'U') IS NULL OR OBJECT_ID(N'dbo.AppUser',N'U') IS NULL
  THROW 51110,N'Jalankan database.sql sebelum dataset-delete.sql.',1;
GO

IF OBJECT_ID(N'dbo.DatasetImportSuppression',N'U') IS NULL
BEGIN
  CREATE TABLE dbo.DatasetImportSuppression(
    source_key VARCHAR(40) NOT NULL,
    manifest_sha256 CHAR(64) NOT NULL,
    deleted_dataset_id INT NOT NULL, /* Audit scalar; deliberately no Dataset FK. */
    dataset_name NVARCHAR(160) NOT NULL,
    dataset_version VARCHAR(40) NOT NULL,
    deleted_by_user_id INT NOT NULL
      CONSTRAINT FK_DatasetImportSuppression_User REFERENCES dbo.AppUser(user_id),
    deleted_at DATETIME2(0) NOT NULL
      CONSTRAINT DF_DatasetImportSuppression_Deleted DEFAULT(SYSUTCDATETIME()),
    CONSTRAINT PK_DatasetImportSuppression PRIMARY KEY(source_key,manifest_sha256),
    CONSTRAINT CK_DatasetImportSuppression_Source CHECK(LEN(source_key)>0),
    CONSTRAINT CK_DatasetImportSuppression_Manifest CHECK(
      LEN(manifest_sha256)=64 AND manifest_sha256 NOT LIKE '%[^0-9a-f]%' COLLATE Latin1_General_100_BIN2),
    CONSTRAINT CK_DatasetImportSuppression_Dataset CHECK(deleted_dataset_id>0)
  );
END;
GO
