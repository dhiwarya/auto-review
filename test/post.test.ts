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

interface FakeOpts {
  prState?: string;
  headSha?: string;
  author?: string;
  draftPr?: boolean;
  labels?: readonly string[];
  myReviews?: readonly { state: string }[];
  pendingExists?: boolean;
  token?: string;
}

// A stand-in for GitHub that records what would be posted.
function fakeGitHub(opts: FakeOpts = {}) {
  const sent = { reviews: [] as Record<string, unknown>[], labelsAdded: [] as string[], labelsRemoved: [] as string[] };
  const gh = {
    me: 'me',
    token: opts.token ?? 't',
    rateLimits: new Map(),
    octokit: {
      paginate: async (fn: (p: unknown) => Promise<{ data: unknown[] }>, params: unknown) => (await fn(params)).data,
      rest: {
        pulls: {
          get: async () => ({
            data: {
              title: 'Fix', body: '', html_url: 'https://github.com/acme/api/pull/1', user: { login: opts.author ?? 'author' }, draft: opts.draftPr ?? false,
              state: opts.prState ?? 'open', head: { sha: opts.headSha ?? REVIEWED, ref: 'fix' },
              base: { sha: 'b'.repeat(40), ref: 'main', repo: { full_name: 'acme/api' } },
              additions: 1, deletions: 0, changed_files: 1, requested_reviewers: [], labels: (opts.labels ?? []).map((name) => ({ name })),
            },
          }),
          createReview: async (args: Record<string, unknown>) => {
            if (opts.pendingExists) {
              throw Object.assign(new Error('Unprocessable Entity'), { status: 422, response: { data: { errors: ['User can only have one pending review per pull request'] } } });
            }
            sent.reviews.push(args);
            const state = args.event === 'APPROVE' ? 'APPROVED' : args.event ? 'COMMENTED' : 'PENDING';
            return { data: { id: 99, html_url: 'https://github.com/acme/api/pull/1#pullrequestreview-99', state } };
          },
          listCommentsForReview: async () => ({
            data: ((sent.reviews.at(-1)?.comments as { body: string; path: string; line: number }[]) ?? []).map((c, i) => ({ id: 500 + i, ...c })),
          }),
          listReviews: async () => ({ data: (opts.myReviews ?? []).map((r) => ({ ...r, user: { login: 'me' } })) }),
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

describe('posting a review', () => {
  let dir: string;
  let db: Db;
  let cfg: SettingsStore;
  let jobId: number;

  const base = {
    pass: 'main' as const, model: 'codex' as const, model_id: 'gpt-6.1-sol', confidence: 'high' as const,
    evidence: 'x', problem: 'p', suggestion: 's', verification: 'confirmed' as const, verified_by: 'codex' as const,
    verify_reason: null, drop_reason: null, comment_id: null, outcome: null,
  };

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
    db.setState(jobId, 'done', { review_state: 'DRY_RUN', review_body: '**1 blocker, 1 minor**\n\nLooks risky.\n\n<sub>Auto Reviewer</sub>', confidence: 'high' });
    db.insertFinding({ ...base, job_id: jobId, category: 'bug', severity: 'blocker', original_severity: 'blocker', file: 'a.js', line: 3, title: 'Crash', status: 'inline' });
    db.insertFinding({ ...base, job_id: jobId, category: 'design', severity: 'minor', original_severity: 'minor', file: 'b.js', line: null, title: 'Naming', status: 'summary' });
    db.insertFinding({ ...base, job_id: jobId, category: 'bug', severity: 'major', original_severity: 'major', file: 'c.js', line: 1, title: 'Refuted', status: 'dropped' });
  });

  afterEach(() => {
    db.sql.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const pipeline = (gh: GitHub) => new ReviewPipeline(gh, cfg, db, null as never, null as never);
  // Turns the blocker into a minor, leaving nothing that stops an approval.
  const clearBlocker = () => {
    const crash = db.findings(jobId).find((f) => f.title === 'Crash')!;
    db.updateFinding(crash.id, { severity: 'minor' });
  };

  it('previews what will be posted and why it would not approve', async () => {
    const preview = await pipeline(fakeGitHub().gh).previewPost(jobId);
    assert.equal(preview.inline, 1);
    assert.equal(preview.inSummary, 1);
    assert.equal(preview.currentSha, preview.reviewedSha);
    assert.equal(preview.approveNote, '1 blocker still open');
    assert.deepEqual(preview.labels, { draft: 'dh: on review', publish: 'dh: feedback' });
  });

  it('posts a draft on the reviewed commit, never approving, and keeps the on-review label', async () => {
    clearBlocker();
    const { gh, sent } = fakeGitHub();
    const job = await pipeline(gh).postDryRun(jobId, 'draft');
    const review = sent.reviews[0];
    assert.equal(review.commit_id, REVIEWED);
    assert.equal(review.event, undefined, 'a pending draft has no event');
    assert.equal((review.comments as unknown[]).length, 1);
    assert.equal(job.dry_run, 0);
    assert.equal(job.review_state, 'PENDING');
    assert.equal(job.approve_note, null, 'could be approved, so it says so instead');
    assert.deepEqual(sent.labelsAdded, ['dh: on review']);
    const crash = db.findings(jobId).find((f) => f.title === 'Crash')!;
    assert.equal(crash.comment_id, 500);
    assert.equal(crash.outcome, 'pending');
    assert.match(crash.posted_body ?? '', /^\*\*Minor \(bug\):\*\* Crash/, 'keeps the exact text it posted');
    assert.equal(db.findings(jobId).find((f) => f.title === 'Refuted')?.outcome, null, 'dropped findings are never posted');
  });

  it('publishes as a comment with the feedback label when a blocker is open', async () => {
    const { gh, sent } = fakeGitHub();
    const job = await pipeline(gh).postDryRun(jobId, 'publish');
    assert.equal(sent.reviews[0].event, 'COMMENT');
    assert.equal(job.mode, 'publish');
    assert.equal(job.approve_note, '1 blocker still open');
    assert.deepEqual(sent.labelsAdded, ['dh: feedback']);
  });

  it('approves when nothing blocks it and confidence is high enough, swapping the old labels', async () => {
    clearBlocker();
    const { gh, sent } = fakeGitHub({ labels: ['dh: on review', 'ai-review:done', 'bug'] });
    const job = await pipeline(gh).postDryRun(jobId, 'publish');
    assert.equal(sent.reviews[0].event, 'APPROVE');
    assert.equal(job.review_state, 'APPROVED');
    assert.equal(job.approve_note, null);
    assert.deepEqual(sent.labelsAdded, ['dh: approved']);
    assert.deepEqual(sent.labelsRemoved, ['dh: on review', 'ai-review:done'], 'leaves labels that are not ours alone');
  });

  for (const [name, setup, opts, why] of [
    ['confidence is below the minimum', () => db.updateJob(jobId, { confidence: 'medium' }), {}, /Confidence is medium; approving needs high/],
    ['approving is off', () => cfg.update({ ...cfg.all, approval: { enabled: false, minConfidence: 'high' } }), {}, /turned off/],
    ['you requested changes yourself', () => {}, { myReviews: [{ state: 'APPROVED' }, { state: 'CHANGES_REQUESTED' }] }, /requested changes/],
    ['it is your own PR', () => {}, { author: 'me' }, /your own PR/],
    ['the PR is a draft', () => {}, { draftPr: true }, /still a draft/],
    ['the PR has newer commits', () => {}, { headSha: 'c'.repeat(40) }, /new commits/],
    ['the review predates confidence levels', () => db.updateJob(jobId, { confidence: null }), {}, /no confidence level/],
  ] as const) {
    it(`does not approve when ${name}`, async () => {
      clearBlocker();
      setup();
      const { gh, sent } = fakeGitHub(opts);
      const job = await pipeline(gh).postDryRun(jobId, 'publish');
      assert.equal(sent.reviews[0].event, 'COMMENT');
      assert.match(job.approve_note ?? '', why);
      assert.deepEqual(sent.labelsAdded, ['dh: feedback']);
    });
  }

  it('approves at medium confidence when the minimum is medium', async () => {
    clearBlocker();
    db.updateJob(jobId, { confidence: 'medium' });
    cfg.update({ ...cfg.all, approval: { enabled: true, minConfidence: 'medium' } });
    const { gh, sent } = fakeGitHub({ myReviews: [{ state: 'CHANGES_REQUESTED' }, { state: 'DISMISSED' }] });
    await pipeline(gh).postDryRun(jobId, 'publish');
    assert.equal(sent.reviews[0].event, 'APPROVE', 'a dismissed change request no longer counts');
  });

  it('counts blockers still open from an earlier review of the PR', async () => {
    clearBlocker();
    const earlier = db.insertJob({
      repo: 'acme/api', pr_number: 1, pr_title: 'Fix', pr_url: 'https://github.com/acme/api/pull/1', author: 'author',
      head_sha: 'e'.repeat(40), base_sha: 'b'.repeat(40), since_sha: null, mode: 'draft', source: 'request', dry_run: 1,
      state: 'queued', additions: 1, deletions: 0, changed_files: 1,
    });
    db.setState(earlier.id, 'done');
    db.insertFinding({ ...base, job_id: earlier.id, category: 'bug', severity: 'blocker', original_severity: 'blocker', file: 'a.js', line: 9, title: 'Old', status: 'inline' });
    const { gh, sent } = fakeGitHub();
    const job = await pipeline(gh).postDryRun(jobId, 'publish');
    assert.equal(sent.reviews[0].event, 'COMMENT');
    assert.equal(job.approve_note, '1 blocker still open');
  });

  it("never posts the app's own credentials, wherever they turn up", async () => {
    const token = `gho_${'S'.repeat(36)}`;
    db.updateJob(jobId, { review_body: `Summary mentioning ${token}` });
    const first = fakeGitHub({ token });
    await assert.rejects(pipeline(first.gh).postDryRun(jobId, 'publish'), (e) => e instanceof PostRefused && /own credentials/.test(e.message));
    assert.equal(first.sent.reviews.length, 0);

    db.updateJob(jobId, { review_body: 'Fine' });
    const crash = db.findings(jobId).find((f) => f.title === 'Crash')!;
    const claude = `opaque-claude-token-${'x'.repeat(20)}`;
    db.updateFinding(crash.id, { problem: `Leaks ${claude}` });
    process.env.CLAUDE_CODE_OAUTH_TOKEN = claude;
    try {
      const second = fakeGitHub();
      await assert.rejects(pipeline(second.gh).postDryRun(jobId, 'draft'), /own credentials/);
      assert.equal(second.sent.reviews.length, 0);
    } finally {
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    }
    assert.equal(db.job(jobId)?.dry_run, 1, 'still a dry run, nothing went out');
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
