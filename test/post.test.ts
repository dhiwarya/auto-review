import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Db } from '../src/db.ts';
import type { GitHub } from '../src/github/client.ts';
import { PostRefused, ReviewPipeline } from '../src/review/pipeline.ts';
import { SettingsStore } from '../src/settings.ts';

const REVIEWED = 'a'.repeat(40);

// A stand-in for GitHub that records what would be posted.
function fakeGitHub(opts: { prState?: string; headSha?: string; pendingExists?: boolean } = {}) {
  const sent = { reviews: [] as Record<string, unknown>[], labelsAdded: [] as string[], labelsRemoved: [] as string[] };
  const gh = {
    me: 'me',
    token: 't',
    rateLimits: new Map(),
    octokit: {
      paginate: async (fn: (p: unknown) => Promise<{ data: unknown[] }>, params: unknown) => (await fn(params)).data,
      rest: {
        pulls: {
          get: async () => ({
            data: {
              title: 'Fix', body: '', html_url: 'https://github.com/acme/api/pull/1', user: { login: 'author' }, draft: false,
              state: opts.prState ?? 'open', head: { sha: opts.headSha ?? REVIEWED, ref: 'fix' },
              base: { sha: 'b'.repeat(40), ref: 'main', repo: { full_name: 'acme/api' } },
              additions: 1, deletions: 0, changed_files: 1, requested_reviewers: [],
            },
          }),
          createReview: async (args: Record<string, unknown>) => {
            if (opts.pendingExists) {
              throw Object.assign(new Error('Unprocessable Entity'), { status: 422, response: { data: { errors: ['User can only have one pending review per pull request'] } } });
            }
            sent.reviews.push(args);
            return { data: { id: 99, html_url: 'https://github.com/acme/api/pull/1#pullrequestreview-99', state: args.event ? 'COMMENTED' : 'PENDING' } };
          },
          listCommentsForReview: async () => ({
            data: ((sent.reviews.at(-1)?.comments as { body: string; path: string; line: number }[]) ?? []).map((c, i) => ({ id: 500 + i, ...c })),
          }),
        },
        issues: {
          getLabel: async () => ({ data: {} }),
          createLabel: async () => ({}),
          addLabels: async (a: { labels: string[] }) => void sent.labelsAdded.push(...a.labels),
          removeLabel: async (a: { name: string }) => void sent.labelsRemoved.push(a.name),
        },
      },
    },
  } as unknown as GitHub;
  return { gh, sent };
}

describe('posting a dry-run review', () => {
  let dir: string;
  let db: Db;
  let cfg: SettingsStore;
  let jobId: number;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prr-post-'));
    db = new Db(dir);
    cfg = new SettingsStore(db);
    cfg.update({ ...cfg.all, repos: { allow: ['acme/api'], deny: [] } });
    const job = db.insertJob({
      repo: 'acme/api', pr_number: 1, pr_title: 'Fix', pr_url: 'https://github.com/acme/api/pull/1', author: 'author',
      head_sha: REVIEWED, base_sha: 'b'.repeat(40), since_sha: null, mode: 'draft', source: 'request', dry_run: 1,
      state: 'queued', additions: 1, deletions: 0, changed_files: 1,
    });
    jobId = job.id;
    db.setState(jobId, 'done', { review_state: 'DRY_RUN', review_body: '## 🤖 AI-assisted review\n\nLooks risky.' });
    const base = {
      job_id: jobId, pass: 'main' as const, model: 'codex' as const, model_id: 'gpt-6.1-sol', confidence: 'high' as const,
      evidence: 'x', problem: 'p', suggestion: 's', verification: 'confirmed' as const, verified_by: 'codex' as const,
      verify_reason: null, drop_reason: null, comment_id: null, outcome: null,
    };
    db.insertFinding({ ...base, category: 'bug', severity: 'blocker', original_severity: 'blocker', file: 'a.js', line: 3, title: 'Crash', status: 'inline' });
    db.insertFinding({ ...base, category: 'design', severity: 'minor', original_severity: 'minor', file: 'b.js', line: null, title: 'Naming', status: 'summary' });
    db.insertFinding({ ...base, category: 'bug', severity: 'major', original_severity: 'major', file: 'c.js', line: 1, title: 'Refuted', status: 'dropped' });
  });

  afterEach(() => {
    db.sql.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const pipeline = (gh: GitHub) => new ReviewPipeline(gh, cfg, db, null as never, null as never);

  it('previews what will be posted', async () => {
    const preview = await pipeline(fakeGitHub().gh).previewPost(jobId);
    assert.equal(preview.inline, 1);
    assert.equal(preview.inSummary, 1);
    assert.equal(preview.blockerLabel, 'ai-review:blocker');
    assert.equal(preview.currentSha, preview.reviewedSha);
  });

  it('posts a draft on the reviewed commit and turns it into a normal review', async () => {
    const { gh, sent } = fakeGitHub();
    const job = await pipeline(gh).postDryRun(jobId, 'draft');
    const review = sent.reviews[0];
    assert.equal(review.commit_id, REVIEWED);
    assert.equal(review.event, undefined, 'a pending draft has no event');
    assert.equal((review.comments as unknown[]).length, 1);
    assert.equal(job.dry_run, 0);
    assert.equal(job.review_state, 'PENDING');
    assert.equal(job.review_id, 99);
    assert.deepEqual(sent.labelsAdded, ['ai-review:done'], 'no blocker label while it is still a draft');
    const findings = db.findings(jobId);
    assert.equal(findings.find((f) => f.title === 'Crash')?.comment_id, 500);
    assert.equal(findings.find((f) => f.title === 'Crash')?.outcome, 'pending');
    assert.equal(findings.find((f) => f.title === 'Refuted')?.outcome, null, 'dropped findings are never posted');
  });

  it('publishes as a comment review, with the blocker label', async () => {
    const { gh, sent } = fakeGitHub();
    const job = await pipeline(gh).postDryRun(jobId, 'publish');
    assert.equal(sent.reviews[0].event, 'COMMENT');
    assert.equal(job.mode, 'publish');
    assert.deepEqual(sent.labelsAdded, ['ai-review:done', 'ai-review:blocker']);
  });

  it('refuses to post twice, or to a closed PR', async () => {
    await pipeline(fakeGitHub().gh).postDryRun(jobId, 'draft');
    await assert.rejects(pipeline(fakeGitHub().gh).postDryRun(jobId, 'draft'), (e) => e instanceof PostRefused && /already on GitHub/.test(e.message));

    db.updateJob(jobId, { dry_run: 1, review_id: null, review_state: 'DRY_RUN' });
    await assert.rejects(pipeline(fakeGitHub({ prState: 'closed' }).gh).postDryRun(jobId, 'draft'), /no longer open/);
  });

  it('explains a pending review in the way and leaves the dry run ready to retry', async () => {
    await assert.rejects(
      pipeline(fakeGitHub({ pendingExists: true }).gh).postDryRun(jobId, 'draft'),
      (e) => e instanceof PostRefused && /unsubmitted review/.test(e.message),
    );
    const job = db.job(jobId)!;
    assert.equal(job.dry_run, 1);
    assert.equal(job.review_state, 'DRY_RUN');
  });

  it('still posts when the PR has moved on, on the commit that was reviewed', async () => {
    const { gh, sent } = fakeGitHub({ headSha: 'c'.repeat(40) });
    await pipeline(gh).postDryRun(jobId, 'draft');
    assert.equal(sent.reviews[0].commit_id, REVIEWED);
    assert.ok(db.events(jobId).some((e) => /moved on/.test(e.message)));
  });
});
