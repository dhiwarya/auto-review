import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Db } from '../src/db.ts';
import type { GitHub } from '../src/github/client.ts';
import { legacyInlineBody, OutcomeSync } from '../src/jobs/sync.ts';
import { inlineBody } from '../src/review/format.ts';
import { SettingsStore } from '../src/settings.ts';
import type { Finding } from '../src/types.ts';

// GitHub as it looks after you acted on a draft: the review's state and its comments.
function fakeGitHub(review: { state: string; body: string } | null, comments: { id: number; body: string }[], labels: string[] = []) {
  const sent = { added: [] as string[], removed: [] as string[] };
  const gh = {
    me: 'me',
    octokit: {
      paginate: async (fn: (p: unknown) => Promise<{ data: unknown[] }>, params: unknown) => (await fn(params)).data,
      rest: {
        pulls: {
          getReview: async () => {
            if (!review) throw Object.assign(new Error('Not Found'), { status: 404 });
            return { data: review };
          },
          listCommentsForReview: async () => ({ data: comments.map((c) => ({ ...c, path: 'a.js', line: 1 })) }),
          get: async () => ({
            data: {
              title: 'Fix', body: '', html_url: 'u', user: { login: 'author' }, draft: false, state: 'open',
              head: { sha: 'a'.repeat(40), ref: 'fix' }, base: { sha: 'b'.repeat(40), ref: 'main', repo: { full_name: 'acme/api' } },
              additions: 1, deletions: 0, changed_files: 1, requested_reviewers: [], labels: labels.map((name) => ({ name })),
            },
          }),
        },
        issues: {
          getLabel: async () => ({ data: {} }),
          addLabels: async (a: { labels: string[] }) => void sent.added.push(...a.labels),
          removeLabel: async (a: { name: string }) => void sent.removed.push(a.name),
        },
      },
    },
  } as unknown as GitHub;
  return { gh, sent };
}

describe('learning from your drafts', () => {
  let dir: string;
  let db: Db;
  let cfg: SettingsStore;
  let jobId: number;
  let kept: Finding;
  let edited: Finding;
  let old: Finding;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prr-sync-'));
    db = new Db(dir);
    cfg = new SettingsStore(db);
    const job = db.insertJob({
      repo: 'acme/api', pr_number: 1, pr_title: 'Fix', pr_url: 'u', author: 'author', head_sha: 'a'.repeat(40), base_sha: 'b'.repeat(40),
      since_sha: null, mode: 'draft', source: 'request', dry_run: 0, state: 'queued', additions: 1, deletions: 0, changed_files: 1,
    });
    jobId = job.id;
    db.setState(jobId, 'done', { review_id: 99, review_state: 'PENDING', finished_at: new Date().toISOString() });
    const make = (title: string) =>
      db.insertFinding({
        job_id: jobId, pass: 'main', model: 'codex', model_id: 'gpt-6.1-sol', category: 'bug', severity: 'major', original_severity: 'major',
        confidence: 'high', file: 'a.js', line: 1, title, evidence: 'x', problem: 'p', suggestion: 's', verification: 'confirmed',
        verified_by: 'codex', verify_reason: null, status: 'inline', drop_reason: null, comment_id: null, outcome: 'pending',
      });
    kept = make('Kept');
    edited = make('Edited');
    old = make('Posted before the new wording');
    db.updateFinding(kept.id, { posted_body: inlineBody(kept) });
    db.updateFinding(edited.id, { posted_body: inlineBody(edited) });
  });

  afterEach(() => {
    db.sql.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('tells kept from edited comments, including ones posted with the old wording', async () => {
    const comments = [
      { id: 1, body: inlineBody(kept) },
      { id: 2, body: inlineBody(edited).replace('**Suggestion:** s', '**Suggestion:** s, and add a test') },
      { id: 3, body: `${legacyInlineBody(old)}\n<!-- ai-finding:${old.id} -->` },
    ];
    const { gh, sent } = fakeGitHub({ state: 'COMMENTED', body: '' }, comments, ['dh: on review']);
    await new OutcomeSync(gh, cfg, db).syncOnce();
    const outcome = (f: Finding) => db.findings(jobId).find((x) => x.id === f.id)?.outcome;
    assert.equal(outcome(kept), 'kept');
    assert.equal(outcome(edited), 'edited');
    assert.equal(outcome(old), 'kept', 'the old wording is not mistaken for an edit');
    assert.deepEqual(sent.added, ['dh: feedback']);
    assert.deepEqual(sent.removed, ['dh: on review']);
  });

  it('labels the PR approved when you submit the draft as an approval', async () => {
    const { gh, sent } = fakeGitHub({ state: 'APPROVED', body: '' }, [], ['dh: on review']);
    await new OutcomeSync(gh, cfg, db).syncOnce();
    assert.equal(db.job(jobId)?.review_state, 'APPROVED');
    assert.deepEqual(sent.added, ['dh: approved']);
  });

  it('takes the on-review label off when you discard the draft', async () => {
    const { gh, sent } = fakeGitHub(null, []);
    await new OutcomeSync(gh, cfg, db).syncOnce();
    assert.equal(db.job(jobId)?.review_state, 'DELETED');
    assert.deepEqual(sent.removed, ['dh: on review']);
    assert.deepEqual(sent.added, []);
  });
});
