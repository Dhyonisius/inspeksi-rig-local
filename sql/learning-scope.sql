USE [K3VisionLocal];
GO
SET XACT_ABORT ON;
BEGIN TRANSACTION;
IF COL_LENGTH(N'dbo.WorkArea',N'scope_key') IS NULL
 ALTER TABLE dbo.WorkArea ADD scope_key VARCHAR(40) NULL;
IF COL_LENGTH(N'dbo.DatasetTrainingReview',N'work_area_id') IS NULL
 ALTER TABLE dbo.DatasetTrainingReview ADD work_area_id INT NULL REFERENCES dbo.WorkArea(work_area_id);
COMMIT TRANSACTION;
GO
SET XACT_ABORT ON;
BEGIN TRANSACTION;
DECLARE @catalog TABLE(name NVARCHAR(120),area_type VARCHAR(20),description NVARCHAR(500));
INSERT @catalog VALUES
 (N'Accumulator', 'RIG', N'Bagian pemeriksaan pada PDF CRSSC: Accumulator'),
 (N'Agitator', 'RIG', N'Bagian pemeriksaan pada PDF CRSSC: Agitator'),
 (N'Air Hoist / Hydraulic Winch', 'RIG', N'Bagian pemeriksaan pada PDF CRSSC: Air Hoist / Hydraulic Winch'),
 (N'Annular', 'RIG', N'Bagian pemeriksaan pada PDF CRSSC: Annular'),
 (N'Bendera Guyline', 'RIG', N'Bagian pemeriksaan pada PDF CRSSC: Bendera Guyline'),
 (N'Blind Shear Ram', 'RIG', N'Bagian pemeriksaan pada PDF CRSSC: Blind Shear Ram'),
 (N'Bowen Power Swivel', 'RIG', N'Bagian pemeriksaan pada PDF CRSSC: Bowen Power Swivel'),
 (N'Choke Manifold', 'RIG', N'Bagian pemeriksaan pada PDF CRSSC: Choke Manifold'),
 (N'Crown Block', 'RIG', N'Bagian pemeriksaan pada PDF CRSSC: Crown Block'),
 (N'Discharge Line', 'RIG', N'Bagian pemeriksaan pada PDF CRSSC: Discharge Line'),
 (N'Drawwork', 'RIG', N'Bagian pemeriksaan pada PDF CRSSC: Drawwork, Draw Work'),
 (N'Drilling Line', 'RIG', N'Bagian pemeriksaan pada PDF CRSSC: Drilling Line'),
 (N'Drilling Spool', 'RIG', N'Bagian pemeriksaan pada PDF CRSSC: Drilling Spool'),
 (N'Drippan', 'RIG', N'Bagian pemeriksaan pada PDF CRSSC: Drippan'),
 (N'Electric Motor', 'RIG', N'Bagian pemeriksaan pada PDF CRSSC: Electric motor'),
 (N'Elevator & Link', 'RIG', N'Bagian pemeriksaan pada PDF CRSSC: Elevator & Link'),
 (N'Equipment', 'RIG', N'Bagian pemeriksaan pada PDF CRSSC: Equipment'),
 (N'Foto Dokumen Checklist Survey Lokasi/Well', 'RIG', N'Bagian pemeriksaan pada PDF CRSSC: Foto Dokumen Checklist Survey Lokasi/Well'),
 (N'Genset', 'RIG', N'Bagian pemeriksaan pada PDF CRSSC: Genset'),
 (N'Guyline', 'RIG', N'Bagian pemeriksaan pada PDF CRSSC: Guyline'),
 (N'Kelly Hose', 'RIG', N'Bagian pemeriksaan pada PDF CRSSC: Kelly hose'),
 (N'Manual Rotary Tong', 'RIG', N'Bagian pemeriksaan pada PDF CRSSC: Manual Rotary Tong'),
 (N'Mast', 'RIG', N'Bagian pemeriksaan pada PDF CRSSC: Mast'),
 (N'Mud Gas Separator', 'RIG', N'Bagian pemeriksaan pada PDF CRSSC: Mud Gas Separator'),
 (N'Mud Pump', 'RIG', N'Bagian pemeriksaan pada PDF CRSSC: Mud Pump'),
 (N'Mud Tank', 'RIG', N'Bagian pemeriksaan pada PDF CRSSC: Mud tank'),
 (N'Open Type Power Tong', 'RIG', N'Bagian pemeriksaan pada PDF CRSSC: Open Type Power Tong'),
 (N'PJSM', 'RIG', N'Bagian pemeriksaan pada PDF CRSSC: PJSM'),
 (N'Ram BOP', 'RIG', N'Bagian pemeriksaan pada PDF CRSSC: Ram BOP'),
 (N'Rig Carrier Equipment', 'RIG', N'Bagian pemeriksaan pada PDF CRSSC: Rig Carrier Equipment'),
 (N'Rig Engine', 'RIG', N'Bagian pemeriksaan pada PDF CRSSC: Rig Engine'),
 (N'Rig Mast', 'RIG', N'Bagian pemeriksaan pada PDF CRSSC: Rig Mast'),
 (N'Rod Tong', 'RIG', N'Bagian pemeriksaan pada PDF CRSSC: Rod Tong'),
 (N'Safety Pin Guyline', 'RIG', N'Bagian pemeriksaan pada PDF CRSSC: Safety Pin Guyline'),
 (N'Sand Line & Sand Drum', 'RIG', N'Bagian pemeriksaan pada PDF CRSSC: Sand Line & Sand Drum'),
 (N'Shale Shaker', 'RIG', N'Bagian pemeriksaan pada PDF CRSSC: Shale Shaker'),
 (N'Single Ram', 'RIG', N'Bagian pemeriksaan pada PDF CRSSC: Single Ram'),
 (N'Standpipe Manifold', 'RIG', N'Bagian pemeriksaan pada PDF CRSSC: Standpipe manifold'),
 (N'Travelling Block', 'RIG', N'Bagian pemeriksaan pada PDF CRSSC: Travelling Block'),
 (N'Tubing Base / Matng Board', 'RIG', N'Bagian pemeriksaan pada PDF CRSSC: Tubing Base/Matng Board'),
 (N'WARNING SIGN VALVE', 'RIG', N'Bagian pemeriksaan pada PDF CRSSC: WARNING SIGN VALVE'),
 (N'Working Platform', 'RIG', N'Bagian pemeriksaan pada PDF CRSSC: Working Platorm'),
 (N'Ruangan Kantor', 'KANTOR', N'Tambahan ruang kantor sesuai permintaan pengguna.');
/* Retain historical foreign keys; remove obsolete choices from new inspections.
   Scope reconciliation applies on restart and cannot delete photos or labels. */
UPDATE dbo.WorkArea SET is_active=0 WHERE NOT EXISTS(SELECT 1 FROM @catalog c WHERE c.name=WorkArea.name AND c.area_type=WorkArea.area_type);
UPDATE wa SET scope_key='CRSSC-20261005',description=c.description
 FROM dbo.WorkArea wa JOIN @catalog c ON c.name=wa.name AND c.area_type=wa.area_type;
INSERT dbo.WorkArea(name,area_type,description,is_active,scope_key)
 SELECT c.name,c.area_type,c.description,1,'CRSSC-20261005' FROM @catalog c
 WHERE NOT EXISTS(SELECT 1 FROM dbo.WorkArea wa WHERE wa.name=c.name AND wa.area_type=c.area_type);
COMMIT TRANSACTION;
GO
