USE K3VisionLocal;
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

IF OBJECT_ID(N'dbo.Dataset',N'U') IS NULL OR OBJECT_ID(N'dbo.DatasetItem',N'U') IS NULL
  THROW 51100,N'Jalankan database.sql sebelum public-datasets.sql.',1;
GO

IF COL_LENGTH(N'dbo.Dataset',N'dataset_kind') IS NULL
  ALTER TABLE dbo.Dataset ADD dataset_kind VARCHAR(20) NOT NULL
    CONSTRAINT DF_Dataset_Kind DEFAULT ('HAZARD') WITH VALUES;
GO
IF NOT EXISTS(SELECT 1 FROM sys.check_constraints WHERE parent_object_id=OBJECT_ID(N'dbo.Dataset') AND name=N'CK_Dataset_Kind')
  ALTER TABLE dbo.Dataset WITH CHECK ADD CONSTRAINT CK_Dataset_Kind CHECK(dataset_kind IN ('HAZARD','PPE_OBJECT'));

IF NOT EXISTS(SELECT 1 FROM sys.check_constraints WHERE parent_object_id=OBJECT_ID(N'dbo.DatasetItem') AND name=N'CK_DatasetItem_Overall' AND definition LIKE '%OBJECT_ONLY%')
BEGIN
  IF EXISTS(SELECT 1 FROM sys.check_constraints WHERE parent_object_id=OBJECT_ID(N'dbo.DatasetItem') AND name=N'CK_DatasetItem_Overall')
    ALTER TABLE dbo.DatasetItem DROP CONSTRAINT CK_DatasetItem_Overall;
  ALTER TABLE dbo.DatasetItem WITH CHECK ADD CONSTRAINT CK_DatasetItem_Overall
    CHECK(overall_label IN ('RISK','NO_LISTED_HAZARD_VISIBLE','UNCERTAIN','OBJECT_ONLY'));
END;
GO

IF OBJECT_ID(N'dbo.DatasetExternalSource',N'U') IS NULL
BEGIN
  CREATE TABLE dbo.DatasetExternalSource(
    dataset_id INT NOT NULL CONSTRAINT PK_DatasetExternalSource PRIMARY KEY
      CONSTRAINT FK_DatasetExternalSource_Dataset REFERENCES dbo.Dataset(dataset_id),
    source_key VARCHAR(40) NOT NULL,
    publisher NVARCHAR(200) NOT NULL,
    source_url NVARCHAR(1200) NOT NULL,
    license_name NVARCHAR(200) NOT NULL,
    license_url NVARCHAR(1200) NOT NULL,
    manifest_sha256 CHAR(64) NOT NULL,
    prepared_count INT NOT NULL CONSTRAINT CK_DatasetExternalSource_Count CHECK(prepared_count>=0),
    imported_by_user_id INT NOT NULL CONSTRAINT FK_DatasetExternalSource_User REFERENCES dbo.AppUser(user_id),
    created_at DATETIME2(0) NOT NULL CONSTRAINT DF_DatasetExternalSource_Created DEFAULT(SYSUTCDATETIME()),
    CONSTRAINT UQ_DatasetExternalSource_Manifest UNIQUE(source_key,manifest_sha256)
  );
END;

IF OBJECT_ID(N'dbo.DatasetObjectClass',N'U') IS NULL
BEGIN
  CREATE TABLE dbo.DatasetObjectClass(
    object_class_id INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_DatasetObjectClass PRIMARY KEY,
    dataset_id INT NOT NULL CONSTRAINT FK_DatasetObjectClass_Dataset REFERENCES dbo.Dataset(dataset_id),
    class_index INT NOT NULL CONSTRAINT CK_DatasetObjectClass_Index CHECK(class_index>=0),
    publisher_name NVARCHAR(120) NOT NULL,
    display_name NVARCHAR(120) NOT NULL,
    CONSTRAINT UQ_DatasetObjectClass_Index UNIQUE(dataset_id,class_index),
    CONSTRAINT UQ_DatasetObjectClass_Dataset UNIQUE(object_class_id,dataset_id)
  );
END;

IF NOT EXISTS(SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'dbo.DatasetItem') AND name=N'UQ_DatasetItem_ItemDataset')
  CREATE UNIQUE INDEX UQ_DatasetItem_ItemDataset ON dbo.DatasetItem(dataset_item_id,dataset_id);
GO

IF OBJECT_ID(N'dbo.DatasetObjectAnnotation',N'U') IS NULL
BEGIN
  CREATE TABLE dbo.DatasetObjectAnnotation(
    object_annotation_id BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_DatasetObjectAnnotation PRIMARY KEY,
    dataset_id INT NOT NULL,
    dataset_item_id INT NOT NULL,
    object_class_id INT NOT NULL,
    bbox_x DECIMAL(12,9) NOT NULL,
    bbox_y DECIMAL(12,9) NOT NULL,
    bbox_width DECIMAL(12,9) NOT NULL,
    bbox_height DECIMAL(12,9) NOT NULL,
    CONSTRAINT FK_DatasetObjectAnnotation_Item FOREIGN KEY(dataset_item_id,dataset_id)
      REFERENCES dbo.DatasetItem(dataset_item_id,dataset_id) ON DELETE CASCADE,
    CONSTRAINT FK_DatasetObjectAnnotation_Class FOREIGN KEY(object_class_id,dataset_id)
      REFERENCES dbo.DatasetObjectClass(object_class_id,dataset_id),
    CONSTRAINT CK_DatasetObjectAnnotation_Box CHECK(
      bbox_x>=0 AND bbox_y>=0 AND bbox_width>0 AND bbox_height>0
      AND bbox_x+bbox_width<=1 AND bbox_y+bbox_height<=1)
  );
  CREATE INDEX IX_DatasetObjectAnnotation_Class ON dbo.DatasetObjectAnnotation(object_class_id,dataset_item_id);
END;

-- A public source may contain aliases of the same image. One DatasetItem per
-- checksum is retained; source IDs record every imported alias for resuming.
IF OBJECT_ID(N'dbo.DatasetExternalItem',N'U') IS NULL
BEGIN
  CREATE TABLE dbo.DatasetExternalItem(
    external_item_id BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_DatasetExternalItem PRIMARY KEY,
    dataset_id INT NOT NULL,
    dataset_item_id INT NOT NULL,
    source_id NVARCHAR(200) NOT NULL,
    source_image_path NVARCHAR(500) NOT NULL,
    source_checksum CHAR(64) NOT NULL,
    annotation_sha256 CHAR(64) NOT NULL,
    pixel_width INT NOT NULL CONSTRAINT CK_DatasetExternalItem_Width CHECK(pixel_width>0),
    pixel_height INT NOT NULL CONSTRAINT CK_DatasetExternalItem_Height CHECK(pixel_height>0),
    created_at DATETIME2(0) NOT NULL CONSTRAINT DF_DatasetExternalItem_Created DEFAULT(SYSUTCDATETIME()),
    CONSTRAINT FK_DatasetExternalItem_Item FOREIGN KEY(dataset_item_id,dataset_id)
      REFERENCES dbo.DatasetItem(dataset_item_id,dataset_id) ON DELETE CASCADE,
    CONSTRAINT UQ_DatasetExternalItem_Source UNIQUE(dataset_id,source_id)
  );
END;
GO

CREATE OR ALTER TRIGGER dbo.TR_DatasetItem_Kind ON dbo.DatasetItem
AFTER INSERT,UPDATE AS
BEGIN
  SET NOCOUNT ON;
  IF EXISTS(SELECT 1 FROM inserted i JOIN dbo.Dataset d ON d.dataset_id=i.dataset_id
    WHERE (d.dataset_kind='PPE_OBJECT' AND i.overall_label<>'OBJECT_ONLY')
      OR (d.dataset_kind='HAZARD' AND i.overall_label='OBJECT_ONLY'))
    THROW 51101,N'Label objek/APD harus terpisah dari label bahaya.',1;
END;
GO

CREATE OR ALTER TRIGGER dbo.TR_Dataset_Kind ON dbo.Dataset
AFTER UPDATE AS
BEGIN
  SET NOCOUNT ON;
  IF UPDATE(dataset_kind) AND EXISTS(SELECT 1 FROM inserted d JOIN dbo.DatasetItem i ON i.dataset_id=d.dataset_id
    WHERE (d.dataset_kind='PPE_OBJECT' AND i.overall_label<>'OBJECT_ONLY')
      OR (d.dataset_kind='HAZARD' AND i.overall_label='OBJECT_ONLY'))
    THROW 51102,N'Jenis dataset tidak sesuai dengan label item yang sudah ada.',1;
END;
GO
