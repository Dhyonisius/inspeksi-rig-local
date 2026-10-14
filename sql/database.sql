/*
  K3 Vision Local - SQL Server Express bootstrap
  Database is intentionally created for local demonstration only.
  Run in SQL Server Management Studio or with sqlcmd against .\SQLEXPRESS.
*/
USE [master];
GO
IF DB_ID(N'K3VisionLocal') IS NULL
BEGIN
  CREATE DATABASE [K3VisionLocal];
END;
GO
USE [K3VisionLocal];
GO

-- Required when creating or changing data covered by a filtered index.
SET NOCOUNT ON;
SET ANSI_NULLS ON;
SET ANSI_PADDING ON;
SET ANSI_WARNINGS ON;
SET ARITHABORT ON;
SET CONCAT_NULL_YIELDS_NULL ON;
SET QUOTED_IDENTIFIER ON;
SET NUMERIC_ROUNDABORT OFF;
GO

IF OBJECT_ID(N'dbo.AppUser', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.AppUser (
    user_id INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_AppUser PRIMARY KEY,
    full_name NVARCHAR(120) NOT NULL,
    email NVARCHAR(254) NOT NULL CONSTRAINT UQ_AppUser_Email UNIQUE,
    password_hash VARCHAR(180) NOT NULL,
    role VARCHAR(20) NOT NULL CONSTRAINT CK_AppUser_Role CHECK (role IN ('operator','admin')),
    is_active BIT NOT NULL CONSTRAINT DF_AppUser_Active DEFAULT (1),
    created_at DATETIME2(0) NOT NULL CONSTRAINT DF_AppUser_Created DEFAULT (SYSUTCDATETIME())
  );
END;
GO

IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE parent_object_id=OBJECT_ID(N'dbo.AppUser') AND name=N'CK_AppUser_Role' AND definition LIKE N'%k3%')
BEGIN
  ALTER TABLE dbo.AppUser DROP CONSTRAINT CK_AppUser_Role;
  UPDATE dbo.AppUser SET role='operator' WHERE role='k3';
  ALTER TABLE dbo.AppUser ADD CONSTRAINT CK_AppUser_Role CHECK (role IN ('operator','admin'));
END;
GO

IF OBJECT_ID(N'dbo.WorkArea', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.WorkArea (
    work_area_id INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_WorkArea PRIMARY KEY,
    name NVARCHAR(120) NOT NULL,
    area_type VARCHAR(20) NOT NULL CONSTRAINT CK_WorkArea_Type CHECK (area_type IN ('GUDANG','KANTOR')),
    description NVARCHAR(500) NULL,
    is_active BIT NOT NULL CONSTRAINT DF_WorkArea_Active DEFAULT (1),
    created_at DATETIME2(0) NOT NULL CONSTRAINT DF_WorkArea_Created DEFAULT (SYSUTCDATETIME())
  );
END;
GO

IF OBJECT_ID(N'dbo.HazardType', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.HazardType (
    hazard_type_id INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_HazardType PRIMARY KEY,
    code VARCHAR(48) NOT NULL CONSTRAINT UQ_HazardType_Code UNIQUE,
    name NVARCHAR(140) NOT NULL,
    area_type VARCHAR(20) NOT NULL CONSTRAINT CK_HazardType_Area CHECK (area_type IN ('GUDANG','KANTOR','KEDUANYA')),
    description NVARCHAR(700) NOT NULL,
    default_severity VARCHAR(20) NOT NULL CONSTRAINT CK_HazardType_Severity CHECK (default_severity IN ('RENDAH','SEDANG','TINGGI')),
    recommended_action NVARCHAR(700) NOT NULL,
    is_active BIT NOT NULL CONSTRAINT DF_HazardType_Active DEFAULT (1)
  );
END;
GO

IF OBJECT_ID(N'dbo.ImageAsset', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.ImageAsset (
    image_id INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_ImageAsset PRIMARY KEY,
    work_area_id INT NULL CONSTRAINT FK_ImageAsset_WorkArea REFERENCES dbo.WorkArea(work_area_id),
    uploaded_by_user_id INT NOT NULL CONSTRAINT FK_ImageAsset_User REFERENCES dbo.AppUser(user_id),
    file_uri NVARCHAR(500) NOT NULL,
    original_name NVARCHAR(255) NOT NULL,
    mime_type VARCHAR(80) NOT NULL,
    file_size_bytes BIGINT NOT NULL,
    origin_type VARCHAR(20) NOT NULL CONSTRAINT CK_ImageAsset_Origin CHECK (origin_type IN ('INSPEKSI','DATASET')),
    source_url NVARCHAR(1200) NULL,
    author_name NVARCHAR(200) NULL,
    license_name NVARCHAR(200) NULL,
    license_url NVARCHAR(1200) NULL,
    attribution_text NVARCHAR(1000) NULL,
    license_verified BIT NULL,
    captured_at DATETIME2(0) NULL,
    uploaded_at DATETIME2(0) NOT NULL CONSTRAINT DF_ImageAsset_Uploaded DEFAULT (SYSUTCDATETIME()),
    checksum CHAR(64) NOT NULL CONSTRAINT UQ_ImageAsset_Checksum UNIQUE
  );
  CREATE INDEX IX_ImageAsset_WorkAreaUploaded ON dbo.ImageAsset(work_area_id, uploaded_at DESC);
END;
GO

IF OBJECT_ID(N'dbo.Dataset', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.Dataset (
    dataset_id INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Dataset PRIMARY KEY,
    created_by_user_id INT NOT NULL CONSTRAINT FK_Dataset_User REFERENCES dbo.AppUser(user_id),
    name NVARCHAR(160) NOT NULL,
    version VARCHAR(40) NOT NULL,
    status VARCHAR(20) NOT NULL CONSTRAINT CK_Dataset_Status CHECK (status IN ('DRAFT','REVIEW','APPROVED','ARCHIVED')),
    notes NVARCHAR(700) NULL,
    created_at DATETIME2(0) NOT NULL CONSTRAINT DF_Dataset_Created DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT UQ_Dataset_NameVersion UNIQUE(name, version)
  );
END;
GO

IF OBJECT_ID(N'dbo.DatasetItem', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.DatasetItem (
    dataset_item_id INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_DatasetItem PRIMARY KEY,
    dataset_id INT NOT NULL CONSTRAINT FK_DatasetItem_Dataset REFERENCES dbo.Dataset(dataset_id),
    image_id INT NOT NULL CONSTRAINT FK_DatasetItem_Image REFERENCES dbo.ImageAsset(image_id),
    split VARCHAR(12) NOT NULL CONSTRAINT CK_DatasetItem_Split CHECK (split IN ('TRAIN','VALIDATION','TEST')),
    overall_label VARCHAR(32) NOT NULL CONSTRAINT CK_DatasetItem_Overall CHECK (overall_label IN ('RISK','NO_LISTED_HAZARD_VISIBLE','UNCERTAIN')),
    label_status VARCHAR(20) NOT NULL CONSTRAINT CK_DatasetItem_LabelStatus CHECK (label_status IN ('DRAFT','REVIEWED','VERIFIED')),
    labeled_by_user_id INT NOT NULL CONSTRAINT FK_DatasetItem_LabeledBy REFERENCES dbo.AppUser(user_id),
    verified_by_user_id INT NULL CONSTRAINT FK_DatasetItem_VerifiedBy REFERENCES dbo.AppUser(user_id),
    created_at DATETIME2(0) NOT NULL CONSTRAINT DF_DatasetItem_Created DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT UQ_DatasetItem_Image UNIQUE(dataset_id, image_id)
  );
END;
GO

IF OBJECT_ID(N'dbo.Annotation', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.Annotation (
    annotation_id INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Annotation PRIMARY KEY,
    dataset_item_id INT NOT NULL CONSTRAINT FK_Annotation_DatasetItem REFERENCES dbo.DatasetItem(dataset_item_id),
    hazard_type_id INT NOT NULL CONSTRAINT FK_Annotation_Hazard REFERENCES dbo.HazardType(hazard_type_id),
    bbox_x REAL NOT NULL CONSTRAINT CK_Annotation_X CHECK (bbox_x >= 0 AND bbox_x <= 1),
    bbox_y REAL NOT NULL CONSTRAINT CK_Annotation_Y CHECK (bbox_y >= 0 AND bbox_y <= 1),
    bbox_width REAL NOT NULL CONSTRAINT CK_Annotation_Width CHECK (bbox_width > 0 AND bbox_width <= 1),
    bbox_height REAL NOT NULL CONSTRAINT CK_Annotation_Height CHECK (bbox_height > 0 AND bbox_height <= 1),
    note NVARCHAR(500) NULL
  );
END;
GO

IF OBJECT_ID(N'dbo.ModelVersion', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.ModelVersion (
    model_version_id INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_ModelVersion PRIMARY KEY,
    name NVARCHAR(120) NOT NULL,
    version VARCHAR(60) NOT NULL,
    engine VARCHAR(80) NOT NULL,
    artifact_uri NVARCHAR(500) NULL,
    status VARCHAR(20) NOT NULL CONSTRAINT CK_ModelVersion_Status CHECK (status IN ('DEMO_ONLY','ACTIVE','RETIRED')),
    trained_at DATETIME2(0) NULL,
    notes NVARCHAR(700) NULL,
    created_at DATETIME2(0) NOT NULL CONSTRAINT DF_ModelVersion_Created DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT UQ_ModelVersion_NameVersion UNIQUE(name, version)
  );
END;
GO

IF OBJECT_ID(N'dbo.ModelTrainingDataset', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.ModelTrainingDataset (
    model_version_id INT NOT NULL CONSTRAINT FK_ModelTrainingDataset_Model REFERENCES dbo.ModelVersion(model_version_id),
    dataset_id INT NOT NULL CONSTRAINT FK_ModelTrainingDataset_Dataset REFERENCES dbo.Dataset(dataset_id),
    CONSTRAINT PK_ModelTrainingDataset PRIMARY KEY(model_version_id, dataset_id)
  );
END;
GO

IF OBJECT_ID(N'dbo.Analysis', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.Analysis (
    analysis_id INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Analysis PRIMARY KEY,
    image_id INT NOT NULL CONSTRAINT FK_Analysis_Image REFERENCES dbo.ImageAsset(image_id),
    model_version_id INT NOT NULL CONSTRAINT FK_Analysis_Model REFERENCES dbo.ModelVersion(model_version_id),
    created_by_user_id INT NOT NULL CONSTRAINT FK_Analysis_User REFERENCES dbo.AppUser(user_id),
    processing_status VARCHAR(20) NOT NULL CONSTRAINT CK_Analysis_Processing CHECK (processing_status IN ('QUEUED','RUNNING','COMPLETED','FAILED')),
    result_status VARCHAR(32) NOT NULL CONSTRAINT CK_Analysis_Result CHECK (result_status IN ('HAZARD_FOUND','REVIEW_REQUIRED','NO_VISIBLE_HAZARD','UNABLE_TO_ASSESS')),
    analyzed_at DATETIME2(0) NOT NULL CONSTRAINT DF_Analysis_Analyzed DEFAULT (SYSUTCDATETIME()),
    error_message NVARCHAR(700) NULL
  );
  CREATE INDEX IX_Analysis_AnalyzedAt ON dbo.Analysis(analyzed_at DESC);
  CREATE INDEX IX_Analysis_Status ON dbo.Analysis(result_status, analyzed_at DESC);
END;
GO

/* Recoverable inspection deletion keeps photographs, predictions, feedback,
   and dataset relationships intact. Both columns are nullable for existing rows. */
IF COL_LENGTH(N'dbo.Analysis', N'archived_at') IS NULL
  ALTER TABLE dbo.Analysis ADD archived_at DATETIME2(0) NULL;
IF COL_LENGTH(N'dbo.Analysis', N'archived_by_user_id') IS NULL
  ALTER TABLE dbo.Analysis ADD archived_by_user_id INT NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.foreign_keys WHERE parent_object_id=OBJECT_ID(N'dbo.Analysis') AND name=N'FK_Analysis_ArchivedBy')
  ALTER TABLE dbo.Analysis ADD CONSTRAINT FK_Analysis_ArchivedBy FOREIGN KEY (archived_by_user_id) REFERENCES dbo.AppUser(user_id);
IF NOT EXISTS (SELECT 1 FROM sys.check_constraints WHERE parent_object_id=OBJECT_ID(N'dbo.Analysis') AND name=N'CK_Analysis_ArchiveState')
  ALTER TABLE dbo.Analysis ADD CONSTRAINT CK_Analysis_ArchiveState CHECK (
    (archived_at IS NULL AND archived_by_user_id IS NULL) OR
    (archived_at IS NOT NULL AND archived_by_user_id IS NOT NULL)
  );
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'dbo.Analysis') AND name=N'IX_Analysis_ArchiveAnalyzed')
  CREATE INDEX IX_Analysis_ArchiveAnalyzed ON dbo.Analysis(archived_at,analyzed_at DESC);
GO

IF OBJECT_ID(N'dbo.AnalysisVlmPrediction', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.AnalysisVlmPrediction (
    analysis_id INT NOT NULL,
    provider VARCHAR(20) NOT NULL CONSTRAINT CK_AnalysisVlmPrediction_Provider CHECK (provider IN ('OLLAMA')),
    model_name NVARCHAR(120) NOT NULL,
    predicted_status VARCHAR(32) NOT NULL CONSTRAINT CK_AnalysisVlmPrediction_Status CHECK (predicted_status IN ('POTENSI_TIDAK_AMAN','TIDAK_TAMPAK_BAHAYA','TIDAK_PASTI')),
    summary NVARCHAR(1200) NOT NULL,
    raw_json NVARCHAR(MAX) NOT NULL,
    latency_ms INT NOT NULL,
    prompt_version VARCHAR(32) NOT NULL,
    created_at DATETIME2(0) NOT NULL CONSTRAINT DF_AnalysisVlmPrediction_Created DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT PK_AnalysisVlmPrediction PRIMARY KEY (analysis_id),
    CONSTRAINT FK_AnalysisVlmPrediction_Analysis FOREIGN KEY (analysis_id) REFERENCES dbo.Analysis(analysis_id)
  );
END;
GO

IF OBJECT_ID(N'dbo.AnalysisFeedback', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.AnalysisFeedback (
    feedback_id BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_AnalysisFeedback PRIMARY KEY,
    analysis_id INT NOT NULL CONSTRAINT FK_AnalysisFeedback_Analysis REFERENCES dbo.Analysis(analysis_id),
    user_id INT NOT NULL CONSTRAINT FK_AnalysisFeedback_User REFERENCES dbo.AppUser(user_id),
    corrected_label VARCHAR(32) NOT NULL CONSTRAINT CK_AnalysisFeedback_Label CHECK (corrected_label IN ('TIDAK_AMAN','TIDAK_TAMPAK_BAHAYA','RAGU')),
    notes NVARCHAR(1200) NULL,
    created_at DATETIME2(0) NOT NULL CONSTRAINT DF_AnalysisFeedback_Created DEFAULT (SYSUTCDATETIME())
  );
  CREATE INDEX IX_AnalysisFeedback_AnalysisCreated ON dbo.AnalysisFeedback(analysis_id, created_at DESC);
END;
GO

IF OBJECT_ID(N'dbo.Finding', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.Finding (
    finding_id INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_Finding PRIMARY KEY,
    analysis_id INT NOT NULL CONSTRAINT FK_Finding_Analysis REFERENCES dbo.Analysis(analysis_id),
    hazard_type_id INT NOT NULL CONSTRAINT FK_Finding_Hazard REFERENCES dbo.HazardType(hazard_type_id),
    severity VARCHAR(20) NOT NULL CONSTRAINT CK_Finding_Severity CHECK (severity IN ('RENDAH','SEDANG','TINGGI')),
    confidence REAL NOT NULL CONSTRAINT CK_Finding_Confidence CHECK (confidence >= 0 AND confidence <= 1),
    bbox_x REAL NULL,
    bbox_y REAL NULL,
    bbox_width REAL NULL,
    bbox_height REAL NULL,
    description NVARCHAR(700) NOT NULL
  );
END;
GO

IF OBJECT_ID(N'dbo.AnalysisReview', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.AnalysisReview (
    review_id INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_AnalysisReview PRIMARY KEY,
    analysis_id INT NOT NULL CONSTRAINT FK_AnalysisReview_Analysis REFERENCES dbo.Analysis(analysis_id),
    reviewed_by_user_id INT NOT NULL CONSTRAINT FK_AnalysisReview_User REFERENCES dbo.AppUser(user_id),
    verified_status VARCHAR(24) NOT NULL CONSTRAINT CK_AnalysisReview_Status CHECK (verified_status IN ('TERKONFIRMASI','TIDAK_SESUAI','BELUM_PASTI')),
    notes NVARCHAR(1200) NULL,
    reviewed_at DATETIME2(0) NOT NULL CONSTRAINT DF_AnalysisReview_Reviewed DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT UQ_AnalysisReview_Analysis UNIQUE(analysis_id)
  );
END;
GO

IF OBJECT_ID(N'dbo.AnalysisReviewRequest', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.AnalysisReviewRequest (
    request_id INT IDENTITY(1,1) NOT NULL CONSTRAINT PK_AnalysisReviewRequest PRIMARY KEY,
    analysis_id INT NOT NULL CONSTRAINT FK_AnalysisReviewRequest_Analysis REFERENCES dbo.Analysis(analysis_id),
    requested_by_user_id INT NOT NULL CONSTRAINT FK_AnalysisReviewRequest_User REFERENCES dbo.AppUser(user_id),
    request_status VARCHAR(16) NOT NULL CONSTRAINT CK_AnalysisReviewRequest_Status CHECK (request_status IN ('OPEN','COMPLETED')),
    requested_at DATETIME2(0) NOT NULL CONSTRAINT DF_AnalysisReviewRequest_Requested DEFAULT (SYSUTCDATETIME()),
    completed_at DATETIME2(0) NULL
  );
  CREATE UNIQUE INDEX UQ_AnalysisReviewRequest_Open ON dbo.AnalysisReviewRequest(analysis_id) WHERE request_status = 'OPEN';
END;
GO

IF OBJECT_ID(N'dbo.AuditEvent', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.AuditEvent (
    audit_event_id BIGINT IDENTITY(1,1) NOT NULL CONSTRAINT PK_AuditEvent PRIMARY KEY,
    user_id INT NULL CONSTRAINT FK_AuditEvent_User REFERENCES dbo.AppUser(user_id),
    action_code VARCHAR(60) NOT NULL,
    entity_type VARCHAR(60) NOT NULL,
    entity_id NVARCHAR(80) NULL,
    detail NVARCHAR(1200) NULL,
    occurred_at DATETIME2(0) NOT NULL CONSTRAINT DF_AuditEvent_Occurred DEFAULT (SYSUTCDATETIME())
  );
  CREATE INDEX IX_AuditEvent_Occurred ON dbo.AuditEvent(occurred_at DESC);
END;
GO

/* Demo-only logins: change these before any real deployment. */
IF NOT EXISTS (SELECT 1 FROM dbo.AppUser WHERE email = N'operator@k3.local')
  INSERT dbo.AppUser(full_name,email,password_hash,role) VALUES
  (N'Operator Demo',N'operator@k3.local','k3-local-demo-salt-v1:bae428823332de833c51a081e10797bfb998d0d3a328029e09d77db73a60643c','operator');
IF NOT EXISTS (SELECT 1 FROM dbo.AppUser WHERE email = N'admin@k3.local')
  INSERT dbo.AppUser(full_name,email,password_hash,role) VALUES
  (N'Admin Demo',N'admin@k3.local','k3-local-demo-salt-v1:bae428823332de833c51a081e10797bfb998d0d3a328029e09d77db73a60643c','admin');
GO

IF NOT EXISTS (SELECT 1 FROM dbo.WorkArea)
  INSERT dbo.WorkArea(name,area_type,description) VALUES
  (N'Penerimaan & Bongkar Muat','GUDANG',N'Area penerimaan barang dan aktivitas bongkar muat.'),
  (N'Rak Penyimpanan A','GUDANG',N'Zona rak dan penyimpanan barang.'),
  (N'Kantor Operasional','KANTOR',N'Area kerja administrasi dan operasional.'),
  (N'Ruang Rapat','KANTOR',N'Ruang rapat dan area kolaborasi.');
GO

IF NOT EXISTS (SELECT 1 FROM dbo.HazardType)
  INSERT dbo.HazardType(code,name,area_type,description,default_severity,recommended_action) VALUES
  ('APD_TIDAK_TERLIHAT',N'APD yang diwajibkan tidak terlihat','GUDANG',N'Indikasi APD yang diwajibkan untuk tugas atau zona tidak terlihat pada foto.',N'TINGGI',N'Periksa aturan APD yang berlaku untuk tugas dan zona ini, lalu pastikan pekerja yang bertugas mematuhinya.'),
  ('JALUR_TERHALANG_GUDANG',N'Jalur jalan atau pintu keluar terhalang','GUDANG',N'Barang tampak berada pada jalur yang ditandai atau akses keluar.',N'TINGGI',N'Periksa jalur dan akses keluar di lokasi. Pindahkan penghalang sesuai prosedur lokasi.'),
  ('TUMPAHAN_GUDANG',N'Indikasi tumpahan di lantai','GUDANG',N'Area cairan atau material tampak berada di lantai; pantulan dapat menyerupai tumpahan.',N'SEDANG',N'Periksa kondisi lantai langsung dan ikuti prosedur penanganan tumpahan yang berlaku.'),
  ('FORKLIFT_DEKAT_ORANG',N'Orang dekat forklift atau alat bergerak','GUDANG',N'Orang dan alat bergerak tampak berdekatan; foto tunggal tidak memastikan jarak atau pergerakan.',N'TINGGI',N'Periksa pemisahan jalur, kondisi operasi alat, dan prosedur lalu lintas di area.'),
  ('JALUR_TERHALANG_KANTOR',N'Jalur jalan atau pintu keluar terhalang','KANTOR',N'Barang atau kabel tampak mengganggu jalur berjalan atau akses keluar.',N'SEDANG',N'Periksa jalur dan akses keluar di lokasi, lalu singkirkan penghalang sesuai aturan.'),
  ('TUMPAHAN_KANTOR',N'Indikasi tumpahan di lantai','KANTOR',N'Area cairan tampak di lantai; pantulan atau pola lantai dapat menyebabkan salah deteksi.',N'SEDANG',N'Periksa kondisi lantai langsung dan ikuti prosedur penanganan tumpahan yang berlaku.'),
  ('POTENSI_TERSANDUNG',N'Kabel atau barang berpotensi tersandung','KANTOR',N'Kabel atau barang tampak berada di jalur berjalan.',N'SEDANG',N'Periksa jalur berjalan dan rapikan kabel atau barang menggunakan prosedur yang berlaku.'),
  ('AKSES_PERLENGKAPAN_K3',N'Akses ke perlengkapan keselamatan terhalang','KANTOR',N'Barang tampak menghalangi perlengkapan keselamatan atau ruang aksesnya.',N'TINGGI',N'Periksa akses ke perlengkapan keselamatan dan singkirkan penghalang secepatnya.');
GO

IF NOT EXISTS (SELECT 1 FROM dbo.HazardType WHERE code='POTENSI_LAINNYA')
  INSERT dbo.HazardType(code,name,area_type,description,default_severity,recommended_action) VALUES
  ('POTENSI_LAINNYA',N'Potensi visual lainnya','KEDUANYA',N'Indikasi visual yang perlu dicatat tetapi belum sesuai kategori lain.',N'SEDANG',N'Tinjau kondisi di lokasi dan ikuti prosedur keselamatan organisasi.');
GO

/* Align stock recommendations with the VLM-first workflow without overwriting customized catalog text. */
UPDATE dbo.HazardType SET recommended_action=N'Periksa aturan APD yang berlaku untuk tugas dan zona ini, lalu pastikan pekerja yang bertugas mematuhinya.'
WHERE code='APD_TIDAK_TERLIHAT' AND recommended_action=N'Petugas K3 memeriksa aturan APD untuk tugas dan zona ini, lalu mengonfirmasi langsung kepada penanggung jawab.';
UPDATE dbo.HazardType SET recommended_action=N'Periksa kondisi lantai langsung dan ikuti prosedur penanganan tumpahan yang berlaku.'
WHERE code='TUMPAHAN_GUDANG' AND recommended_action=N'Petugas memeriksa kondisi lantai secara langsung dan menjalankan prosedur penanganan tumpahan yang berlaku.';
UPDATE dbo.HazardType SET recommended_action=N'Periksa kondisi lantai langsung dan ikuti prosedur penanganan tumpahan yang berlaku.'
WHERE code='TUMPAHAN_KANTOR' AND recommended_action=N'Petugas memeriksa lantai secara langsung dan menjalankan prosedur penanganan tumpahan.';
GO

IF NOT EXISTS (SELECT 1 FROM dbo.ModelVersion WHERE name = N'Demo lokal' AND version = '0.1-demo')
  INSERT dbo.ModelVersion(name,version,engine,status,notes) VALUES
  (N'Demo lokal','0.1-demo','NO_INFERENCE_ENGINE','DEMO_ONLY',N'Tidak menjalankan deteksi semantik. Semua unggahan disimpan sebagai BELUM DAPAT DINILAI sampai model tervalidasi dipasang.');
GO

