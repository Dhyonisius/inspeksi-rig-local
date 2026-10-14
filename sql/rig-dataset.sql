USE [K3VisionLocal];
GO
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO
IF OBJECT_ID(N'dbo.DatasetTrainingReview',N'U') IS NULL
BEGIN
 CREATE TABLE dbo.DatasetTrainingReview (
  dataset_item_id INT NOT NULL CONSTRAINT PK_DatasetTrainingReview PRIMARY KEY,
  source_kind VARCHAR(20) NOT NULL CHECK(source_kind IN('PDF','INSPECTION')),
  source_group_key VARCHAR(80) NOT NULL,
  source_metadata NVARCHAR(MAX) NOT NULL,
  curated_description NVARCHAR(1200) NULL,
  reviewed_by_user_id INT NULL REFERENCES dbo.AppUser(user_id),
  reviewed_at DATETIME2(0) NULL,
  CONSTRAINT FK_DatasetTrainingReview_Item FOREIGN KEY(dataset_item_id) REFERENCES dbo.DatasetItem(dataset_item_id) ON DELETE CASCADE
 );
 CREATE INDEX IX_DatasetTrainingReview_Group ON dbo.DatasetTrainingReview(source_group_key,dataset_item_id);
END;
GO
/* Keep import checkpoints after dataset deletion. Restart must not recreate a
   dataset intentionally deleted by its admin. dataset_id is a scalar snapshot. */
IF OBJECT_ID(N'dbo.RigPdfImport',N'U') IS NULL
 CREATE TABLE dbo.RigPdfImport (
  manifest_sha256 CHAR(64) NOT NULL CONSTRAINT PK_RigPdfImport PRIMARY KEY,
  dataset_id INT NOT NULL,
  created_at DATETIME2(0) NOT NULL DEFAULT SYSUTCDATETIME(),
  completed_at DATETIME2(0) NULL
 );
GO
IF EXISTS(SELECT 1 FROM sys.check_constraints WHERE name='CK_WorkArea_Type' AND definition NOT LIKE '%RIG%')
BEGIN
 ALTER TABLE dbo.WorkArea DROP CONSTRAINT CK_WorkArea_Type;
 ALTER TABLE dbo.WorkArea WITH CHECK ADD CONSTRAINT CK_WorkArea_Type CHECK(area_type IN('GUDANG','KANTOR','RIG'));
END;
IF EXISTS(SELECT 1 FROM sys.check_constraints WHERE name='CK_HazardType_Area' AND definition NOT LIKE '%RIG%')
BEGIN
 ALTER TABLE dbo.HazardType DROP CONSTRAINT CK_HazardType_Area;
 ALTER TABLE dbo.HazardType WITH CHECK ADD CONSTRAINT CK_HazardType_Area CHECK(area_type IN('GUDANG','KANTOR','RIG','KEDUANYA'));
END;
GO
IF NOT EXISTS(SELECT 1 FROM dbo.WorkArea WHERE name=N'Area Rig')
 INSERT dbo.WorkArea(name,area_type,description) VALUES(N'Area Rig','RIG',N'Pilih untuk pemeriksaan visual peralatan dan lingkungan rig.');
DECLARE @hazards TABLE(code VARCHAR(48),name NVARCHAR(140),description NVARCHAR(700));
INSERT @hazards VALUES
 ('RIG_SELANG_RUSAK',N'Selang atau pipa tampak rusak',N'Robekan, retakan, sambungan terlepas, atau kerusakan yang jelas pada selang/pipa.'),
 ('RIG_KEBOCORAN',N'Indikasi visual kebocoran',N'Cairan tampak keluar dari sambungan atau genangan di sekitar peralatan. Jenis cairan dan tekanan tidak dapat dipastikan dari foto.'),
 ('RIG_PELINDUNG_RUSAK',N'Pelindung peralatan tampak rusak',N'Pelindung atau pagar tampak patah, terlepas, atau terbuka dekat peralatan. Jangan menganggap komponen hilang tanpa bukti visual.'),
 ('RIG_KABEL_RUSAK',N'Kabel atau sling tampak rusak',N'Serabut putus, kabel terkelupas, atau perubahan bentuk yang jelas pada kabel/sling.');
INSERT dbo.HazardType(code,name,area_type,description,default_severity,recommended_action)
 SELECT h.code,h.name,'RIG',h.description,'TINGGI',N'Periksa temuan langsung di lokasi sesuai prosedur rig dan minta penilaian pihak yang berwenang.'
 FROM @hazards h WHERE NOT EXISTS(SELECT 1 FROM dbo.HazardType currentHazard WHERE currentHazard.code=h.code);
GO
