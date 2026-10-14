/* Dataset provenance and fixed-test evaluation. Run after database.sql and live.sql. */
USE [K3VisionLocal];
GO
SET ANSI_NULLS ON;
SET ANSI_PADDING ON;
SET ANSI_WARNINGS ON;
SET ARITHABORT ON;
SET CONCAT_NULL_YIELDS_NULL ON;
SET QUOTED_IDENTIFIER ON;
SET NUMERIC_ROUNDABORT OFF;
GO

IF OBJECT_ID(N'dbo.DatasetItemProvenance', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.DatasetItemProvenance (
    dataset_item_id INT NOT NULL CONSTRAINT PK_DatasetItemProvenance PRIMARY KEY,
    source_analysis_id INT NOT NULL, /* Snapshot: deliberately no FK to Analysis. */
    source_image_checksum CHAR(64) NOT NULL,
    source_model_name NVARCHAR(120) NULL,
    source_predicted_status VARCHAR(32) NULL,
    source_result_status VARCHAR(32) NOT NULL,
    source_feedback_id BIGINT NULL, /* Feedback can be deleted with its analysis. */
    source_feedback_label VARCHAR(32) NULL,
    source_feedback_notes NVARCHAR(1200) NULL,
    source_feedback_user_id INT NULL,
    source_feedback_user_name NVARCHAR(120) NULL,
    source_analysis_user_id INT NULL,
    source_live_session_id UNIQUEIDENTIFIER NULL,
    source_live_sessions_json NVARCHAR(MAX) NOT NULL CONSTRAINT DF_DatasetItemProvenance_Sessions DEFAULT N'[]',
    source_captured_at DATETIME2(3) NULL,
    curated_description NVARCHAR(1200) NOT NULL,
    imported_by_user_id INT NOT NULL CONSTRAINT FK_DatasetItemProvenance_User REFERENCES dbo.AppUser(user_id),
    created_at DATETIME2(3) NOT NULL CONSTRAINT DF_DatasetItemProvenance_Created DEFAULT SYSUTCDATETIME(),
    CONSTRAINT FK_DatasetItemProvenance_Item FOREIGN KEY(dataset_item_id) REFERENCES dbo.DatasetItem(dataset_item_id)
  );
  CREATE INDEX IX_DatasetItemProvenance_Session ON dbo.DatasetItemProvenance(source_live_session_id,dataset_item_id);
END;
GO

IF COL_LENGTH(N'dbo.DatasetItemProvenance',N'source_live_sessions_json') IS NULL
  ALTER TABLE dbo.DatasetItemProvenance ADD source_live_sessions_json NVARCHAR(MAX) NOT NULL CONSTRAINT DF_DatasetItemProvenance_Sessions DEFAULT N'[]';
IF COL_LENGTH(N'dbo.DatasetItemProvenance',N'source_feedback_user_id') IS NULL
  ALTER TABLE dbo.DatasetItemProvenance ADD source_feedback_user_id INT NULL;
IF COL_LENGTH(N'dbo.DatasetItemProvenance',N'source_feedback_user_name') IS NULL
  ALTER TABLE dbo.DatasetItemProvenance ADD source_feedback_user_name NVARCHAR(120) NULL;
IF COL_LENGTH(N'dbo.DatasetItemProvenance',N'source_analysis_user_id') IS NULL
  ALTER TABLE dbo.DatasetItemProvenance ADD source_analysis_user_id INT NULL;
GO

IF OBJECT_ID(N'dbo.EvaluationRun', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.EvaluationRun (
    evaluation_run_id INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_EvaluationRun PRIMARY KEY,
    owner_user_id INT NOT NULL CONSTRAINT FK_EvaluationRun_Owner REFERENCES dbo.AppUser(user_id),
    dataset_id INT NOT NULL CONSTRAINT FK_EvaluationRun_Dataset REFERENCES dbo.Dataset(dataset_id),
    dataset_name NVARCHAR(160) NOT NULL,
    dataset_version VARCHAR(40) NOT NULL,
    model_name NVARCHAR(120) NOT NULL,
    prompt_version VARCHAR(60) NOT NULL,
    status VARCHAR(20) NOT NULL CONSTRAINT CK_EvaluationRun_Status CHECK(status IN ('QUEUED','RUNNING','COMPLETED','CANCELLED','FAILED','INTERRUPTED')),
    total_items INT NOT NULL CONSTRAINT CK_EvaluationRun_Total CHECK(total_items>0),
    completed_items INT NOT NULL CONSTRAINT DF_EvaluationRun_Completed DEFAULT 0,
    cancellation_requested BIT NOT NULL CONSTRAINT DF_EvaluationRun_Cancel DEFAULT 0,
    dataset_snapshot NVARCHAR(MAX) NOT NULL,
    hazard_catalog_json NVARCHAR(MAX) NOT NULL,
    metrics_json NVARCHAR(MAX) NULL,
    error_message NVARCHAR(700) NULL,
    created_at DATETIME2(3) NOT NULL CONSTRAINT DF_EvaluationRun_Created DEFAULT SYSUTCDATETIME(),
    started_at DATETIME2(3) NULL,
    finished_at DATETIME2(3) NULL,
    CONSTRAINT CK_EvaluationRun_Progress CHECK(completed_items>=0 AND completed_items<=total_items)
  );
  CREATE INDEX IX_EvaluationRun_OwnerCreated ON dbo.EvaluationRun(owner_user_id,created_at DESC);
END;
GO

IF OBJECT_ID(N'dbo.EvaluationItem', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.EvaluationItem (
    evaluation_item_id INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_EvaluationItem PRIMARY KEY,
    evaluation_run_id INT NOT NULL,
    ordinal INT NOT NULL CONSTRAINT CK_EvaluationItem_Ordinal CHECK(ordinal>0),
    dataset_item_id INT NOT NULL, /* Immutable scalar provenance; no live-data FK. */
    image_id INT NOT NULL,
    checksum CHAR(64) NOT NULL,
    file_uri NVARCHAR(500) NOT NULL,
    image_mime_type VARCHAR(80) NOT NULL,
    original_name NVARCHAR(255) NOT NULL,
    area_name NVARCHAR(120) NOT NULL,
    area_type VARCHAR(20) NOT NULL,
    split VARCHAR(12) NOT NULL CONSTRAINT CK_EvaluationItem_Split CHECK(split='TEST'),
    true_label VARCHAR(32) NOT NULL CONSTRAINT CK_EvaluationItem_Truth CHECK(true_label IN ('RISK','NO_LISTED_HAZARD_VISIBLE','UNCERTAIN')),
    curated_description NVARCHAR(1200) NOT NULL,
    annotation_snapshot NVARCHAR(MAX) NOT NULL,
    source_live_session_id UNIQUEIDENTIFIER NULL,
    status VARCHAR(20) NOT NULL CONSTRAINT CK_EvaluationItem_Status CHECK(status IN ('PENDING','RUNNING','COMPLETED','FAILED','CANCELLED','INTERRUPTED')),
    predicted_status VARCHAR(32) NULL CONSTRAINT CK_EvaluationItem_Prediction CHECK(predicted_status IS NULL OR predicted_status IN ('POTENSI_TIDAK_AMAN','TIDAK_TAMPAK_BAHAYA','TIDAK_PASTI')),
    summary NVARCHAR(1200) NULL,
    latency_ms INT NULL,
    error_message NVARCHAR(700) NULL,
    completed_at DATETIME2(3) NULL,
    CONSTRAINT UQ_EvaluationItem_RunOrdinal UNIQUE(evaluation_run_id,ordinal),
    CONSTRAINT FK_EvaluationItem_Run FOREIGN KEY(evaluation_run_id) REFERENCES dbo.EvaluationRun(evaluation_run_id) ON DELETE CASCADE
  );
END;
GO
