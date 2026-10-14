import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveListScope, archiveState, archiveTransaction, analysisVisibilityCondition, imageVisibilityCondition } from './analysis-archive.js';

test('inspection lists default to active inspections for every role', () => {
  for (const role of ['admin', 'operator']) {
    for (const value of [null, '0']) {
      assert.deepEqual(archiveListScope(value, role), { archived: false, condition: 'a.archived_at IS NULL' });
    }
  }
});

test('only an admin can request the archived inspection list', () => {
  assert.deepEqual(archiveListScope('1', 'admin'), { archived: true, condition: 'a.archived_at IS NOT NULL' });
  assert.throws(() => archiveListScope('1', 'operator'), error => error.status === 403);
  for (const value of ['', 'true', 'all', '1 OR 1=1']) {
    assert.throws(() => archiveListScope(value, 'admin'), error => error.status === 400);
  }
});

test('archive requests require an explicit boolean, including restoration false', () => {
  assert.equal(archiveState({ archived: true }), true);
  assert.equal(archiveState({ archived: false }), false);
  for (const body of [null, [], {}, { archived: 'false' }, { archived: 0 }, { archived: 'true' }]) {
    assert.throws(() => archiveState(body), error => error.status === 400);
  }
});

test('operator detail access excludes archived inspections and admin access allows them', () => {
  assert.equal(analysisVisibilityCondition('operator'), ' AND a.archived_at IS NULL');
  assert.equal(analysisVisibilityCondition('admin'), '');
});

test('operator photographs remain available when an active analysis or a dataset shares them', () => {
  const condition = imageVisibilityCondition('operator');
  assert.match(condition, /EXISTS \(SELECT 1 FROM dbo.Analysis a WHERE a.image_id=ia.image_id AND a.archived_at IS NULL\)/);
  assert.match(condition, /OR EXISTS \(SELECT 1 FROM dbo.DatasetItem di WHERE di.image_id=ia.image_id\)/);
  assert.equal(imageVisibilityCondition('admin'), '');
});

test('archive and restore use a locked transaction, audit only state changes, and preserve related data', () => {
  const archive = archiveTransaction(7, 2, true);
  const restore = archiveTransaction(7, 2, false);
  for (const query of [archive, restore]) {
    assert.match(query, /SET XACT_ABORT ON;\s*BEGIN TRANSACTION;/);
    assert.match(query, /WITH \(UPDLOCK,HOLDLOCK\) WHERE analysis_id=7/);
    assert.match(query, /IF @found=1 AND @wasArchived<>[01]\s*BEGIN[\s\S]+INSERT dbo.AuditEvent[\s\S]+SET @changed=1;\s*END;/);
    assert.match(query, /COMMIT TRANSACTION;/);
    assert.doesNotMatch(query, /DELETE|TRUNCATE|DROP/i);
    assert.doesNotMatch(query, /UPDATE dbo\.(ImageAsset|DatasetItem|AnalysisFeedback|AnalysisVlmPrediction)/);
  }
  assert.match(archive, /archived_at=SYSUTCDATETIME\(\),archived_by_user_id=2/);
  assert.match(archive, /'ANALYSIS_ARCHIVED'/);
  assert.match(restore, /archived_at=NULL,archived_by_user_id=NULL/);
  assert.match(restore, /'ANALYSIS_RESTORED'/);
});
