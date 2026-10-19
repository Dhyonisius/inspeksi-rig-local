USE [K3VisionLocal];
GO
SET ANSI_NULLS ON;
SET QUOTED_IDENTIFIER ON;
GO
-- AI suggestions are separate from reviewed annotations and training truth.
IF OBJECT_ID(N'dbo.DatasetAiProposal', N'U') IS NULL
BEGIN
 CREATE TABLE dbo.DatasetAiProposal (
  dataset_item_id INT NOT NULL CONSTRAINT PK_DatasetAiProposal PRIMARY KEY,
  work_area_id INT NOT NULL,
  image_checksum CHAR(64) NOT NULL,
  proposal_json NVARCHAR(MAX) NOT NULL,
  method VARCHAR(20) NOT NULL,
  priority INT NOT NULL,
  created_by_user_id INT NOT NULL,
  created_at DATETIME2(0) NOT NULL DEFAULT SYSUTCDATETIME(),
  CONSTRAINT FK_DatasetAiProposal_Item FOREIGN KEY(dataset_item_id) REFERENCES dbo.DatasetItem(dataset_item_id) ON DELETE CASCADE,
  CONSTRAINT CK_DatasetAiProposal_Json CHECK(ISJSON(proposal_json)=1),
  CONSTRAINT CK_DatasetAiProposal_Method CHECK(method IN('VLM','HYBRID','PSEUDO')),
  CONSTRAINT CK_DatasetAiProposal_Priority CHECK(priority BETWEEN 0 AND 100)
 );
END;
GO
