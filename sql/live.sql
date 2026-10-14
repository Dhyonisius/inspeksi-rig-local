/* Selected camera evidence only. Continuous inference is kept in process RAM. */
USE [K3VisionLocal];
GO
SET NOCOUNT ON;
SET ANSI_NULLS ON;
SET ANSI_PADDING ON;
SET ANSI_WARNINGS ON;
SET ARITHABORT ON;
SET CONCAT_NULL_YIELDS_NULL ON;
SET QUOTED_IDENTIFIER ON;
SET NUMERIC_ROUNDABORT OFF;
GO

IF OBJECT_ID(N'dbo.AnalysisLiveEvidence', N'U') IS NULL
BEGIN
  CREATE TABLE dbo.AnalysisLiveEvidence (
    analysis_id INT NOT NULL CONSTRAINT PK_AnalysisLiveEvidence PRIMARY KEY,
    evidence_id UNIQUEIDENTIFIER NOT NULL CONSTRAINT UQ_AnalysisLiveEvidence_Evidence UNIQUE,
    session_id UNIQUEIDENTIFIER NOT NULL,
    frame_id INT NOT NULL CONSTRAINT CK_AnalysisLiveEvidence_Frame CHECK (frame_id > 0),
    captured_at DATETIME2(3) NOT NULL,
    analyzed_at DATETIME2(3) NOT NULL,
    capture_scope VARCHAR(16) NOT NULL CONSTRAINT CK_AnalysisLiveEvidence_Scope CHECK (capture_scope IN ('FULL_FRAME','ROI')),
    roi_json NVARCHAR(300) NULL,
    selection_notes NVARCHAR(1200) NULL,
    selected_at DATETIME2(3) NOT NULL CONSTRAINT DF_AnalysisLiveEvidence_Selected DEFAULT (SYSUTCDATETIME()),
    CONSTRAINT FK_AnalysisLiveEvidence_Analysis FOREIGN KEY (analysis_id) REFERENCES dbo.Analysis(analysis_id) ON DELETE CASCADE,
    CONSTRAINT CK_AnalysisLiveEvidence_Roi CHECK (
      (capture_scope='FULL_FRAME' AND roi_json IS NULL) OR
      (capture_scope='ROI' AND roi_json IS NOT NULL AND ISJSON(roi_json)=1)
    )
  );
END;
GO

IF COL_LENGTH(N'dbo.AnalysisLiveEvidence',N'selection_notes') IS NULL
  ALTER TABLE dbo.AnalysisLiveEvidence ADD selection_notes NVARCHAR(1200) NULL;
IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE object_id=OBJECT_ID(N'dbo.AnalysisLiveEvidence') AND name=N'IX_AnalysisLiveEvidence_SessionCapture')
  CREATE INDEX IX_AnalysisLiveEvidence_SessionCapture ON dbo.AnalysisLiveEvidence(session_id,captured_at,frame_id);
GO
