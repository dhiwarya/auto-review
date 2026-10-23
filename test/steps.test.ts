import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Db } from '../src/db.ts';

describe('recording what a model run does', () => {
  it('adds steps, updates one when its result arrives, and keeps long detail out of listings', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prr-steps-'));
    const db = new Db(dir);
    try {
      const job = db.insertJob({
        repo: 'acme/api', pr_number: 1, pr_title: 'Fix', pr_url: '', author: 'a', head_sha: 'h', base_sha: 'b', since_sha: null,
        mode: 'draft', source: 'request', dry_run: 1, state: 'running', additions: 0, deletions: 0, changed_files: 0,
      });
      const base = { job_id: job.id, run_key: 'run-1', purpose: 'main', provider: 'codex' as const, model: 'gpt-6.1-sol' };
      db.recordStep({ ...base, ref: null, kind: 'start', title: 'Started codex gpt-6.1-sol', status: 'ok' });
      db.recordStep({ ...base, ref: 'item_1', kind: 'command', title: 'cat a.txt', status: 'running' });
      db.recordStep({ ...base, ref: 'item_1', kind: 'command', detail: 'hello\n', status: 'ok' });
      // The same ref in another run is a different step.
      db.recordStep({ ...base, run_key: 'run-2', ref: 'item_1', kind: 'command', title: 'ls', status: 'running' });

      const steps = db.steps(job.id);
      assert.equal(steps.length, 3);
      const cat = steps.find((s) => s.title === 'cat a.txt')!;
      assert.equal(cat.status, 'ok');
      assert.equal(cat.detail_chars, 6);
      assert.equal('detail' in cat, false, 'listings leave the detail out');
      assert.equal(db.stepDetail(cat.id), 'hello\n');
      assert.equal(steps.find((s) => s.run_key === 'run-2')?.status, 'running');

      assert.equal(db.evidence(job.id), null);
      db.setEvidence(job.id, { diff: null, issues: [], prs: [], guidelines: ['CONTRIBUTING.md'], history: [], previousFindings: 2, discussion: null, promptChars: 10 });
      db.setEvidence(job.id, { diff: null, issues: [], prs: [], guidelines: [], history: [], previousFindings: 3, discussion: null, promptChars: 12 });
      assert.equal(db.evidence(job.id)?.previousFindings, 3, 'saving again replaces it');
    } finally {
      db.sql.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
