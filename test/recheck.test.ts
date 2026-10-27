import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Db } from '../src/db.ts';
import type { GitHub } from '../src/github/client.ts';
import type { RepoWatcher } from '../src/github/watch.ts';
import { Poller } from '../src/jobs/poller.ts';
import { ReviewPipeline } from '../src/review/pipeline.ts';
import { SettingsStore } from '../src/settings.ts';
import type { Finding, Job } from '../src/types.ts';
import { POLICY_VERSION } from '../src/review/policy.ts';

const HEAD = 'a'.repeat(40);
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const jobRow = {
  repo: 'acme/api', pr_number: 1, pr_title: 'Fix', pr_url: 'https://github.com/acme/api/pull/1', author: 'author',
  head_sha: HEAD, base_sha: 'b'.repeat(40), since_sha: null, mode: 'publish' as const, source: 'request' as const, dry_run: 0,
  state: 'queued' as const, additions: 1, deletions: 0, changed_files: 1,
};

const findingRow = {
  pass: 'main' as const, model: 'codex' as const, model_id: 'gpt-6.1-sol', confidence: 'high' as const, category: 'bug' as const,
  evidence: 'x', problem: 'p', suggestion: 's', verification: 'confirmed' as const, verified_by: 'codex' as const,
  verify_reason: null, status: 'inline' as const, drop_reason: null, comment_id: null, outcome: 'published' as const,
};

interface FakeOpts {
  requested?: boolean;
  myReviews?: { id: number; state: string }[];
  replies?: { in_reply_to_id: number; body: string }[];
}

// A stand-in for GitHub: one open PR at HEAD, recording the reviews and labels posted.
function fakeGitHub(opts: FakeOpts = {}) {
  const sent = { reviews: [] as Record<string, unknown>[], labelsAdded: [] as string[] };
  const gh = {
    me: 'me',
    token: 't',
    rateLimits: new Map(),
    octokit: {
      paginate: async (fn: (p: unknown) => Promise<{ data: unknown[] }>, params: unknown) => (await fn(params)).data,
      graphql: async () => {
        throw new Error('no graphql here');
      },
      rest: {
        pulls: {
          get: async () => ({
            data: {
              title: 'Fix', body: '', html_url: 'https://github.com/acme/api/pull/1', user: { login: 'author' }, draft: false, state: 'open',
              head: { sha: HEAD, ref: 'fix' }, base: { sha: 'b'.repeat(40), ref: 'main', repo: { full_name: 'acme/api' } },
              additions: 1, deletions: 0, changed_files: 1, labels: [],
              requested_reviewers: opts.requested === false ? [] : [{ login: 'me' }],
            },
          }),
          createReview: async (args: Record<string, unknown>) => {
            sent.reviews.push(args);
            const state = { APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' }[args.event as string] ?? 'PENDING';
            return { data: { id: 99, html_url: 'https://github.com/acme/api/pull/1#pullrequestreview-99', state } };
          },
          listCommentsForReview: async () => ({ data: [] }),
          listReviews: async () => ({ data: (opts.myReviews ?? []).map((r) => ({ ...r, user: { login: 'me' } })) }),
          listReviewComments: async () => ({
            data: (opts.replies ?? []).map((r, i) => ({ id: 700 + i, user: { login: 'author' }, created_at: minutesAgo(1), ...r })),
          }),
          listFiles: async () => ({ data: [{ filename: 'a.js', status: 'modified', additions: 1, deletions: 0, patch: '@@ -1 +1 @@\n+x' }] }),
        },
        issues: {
          listComments: async () => ({ data: [] }),
          getLabel: async () => ({ data: {} }),
          createLabel: async () => ({}),
          addLabels: async (a: { labels: string[] }) => void sent.labelsAdded.push(...a.labels),
          removeLabel: async () => ({}),
        },
      },
    },
  } as unknown as GitHub;
  return { gh, sent };
}

describe('database', () => {
  it('lets a commit be re-checked, but still reviewed only once, after upgrading an old database', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prr-migrate-'));
    try {
      // The jobs table as earlier versions created it: one job per commit.
      const old = new DatabaseSync(path.join(dir, 'reviewer.sqlite'));
      old.exec(`CREATE TABLE jobs (
        id INTEGER PRIMARY KEY, repo TEXT NOT NULL, pr_number INTEGER NOT NULL, pr_title TEXT NOT NULL DEFAULT '',
        pr_url TEXT NOT NULL DEFAULT '', author TEXT NOT NULL DEFAULT '', head_sha TEXT NOT NULL, base_sha TEXT NOT NULL DEFAULT '',
        since_sha TEXT, mode TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'request', dry_run INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL, step TEXT, progress INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT, error TEXT, skip_reason TEXT, review_id INTEGER, review_url TEXT, review_state TEXT,
        review_body TEXT, spec_status TEXT, additions INTEGER NOT NULL DEFAULT 0, deletions INTEGER NOT NULL DEFAULT 0,
        changed_files INTEGER NOT NULL DEFAULT 0, label_ok INTEGER, created_at TEXT NOT NULL, started_at TEXT,
        finished_at TEXT, updated_at TEXT NOT NULL,
        UNIQUE (repo, pr_number, head_sha)
      );
      CREATE TABLE findings (id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES jobs (id), pass TEXT NOT NULL,
        model TEXT NOT NULL, category TEXT NOT NULL, severity TEXT NOT NULL, original_severity TEXT NOT NULL,
        confidence TEXT NOT NULL, file TEXT NOT NULL, line INTEGER, title TEXT NOT NULL, evidence TEXT NOT NULL,
        problem TEXT NOT NULL, suggestion TEXT NOT NULL, verification TEXT NOT NULL DEFAULT 'not_needed', verified_by TEXT,
        verify_reason TEXT, status TEXT NOT NULL DEFAULT 'inline', drop_reason TEXT, comment_id INTEGER, outcome TEXT,
        resolved_by_job INTEGER, created_at TEXT NOT NULL);
      INSERT INTO jobs (repo, pr_number, head_sha, mode, state, created_at, updated_at)
        VALUES ('acme/api', 1, '${HEAD}', 'draft', 'done', '2026-01-01', '2026-01-01');
      INSERT INTO findings (job_id, pass, model, category, severity, original_severity, confidence, file, title, evidence, problem, suggestion, created_at)
        VALUES (1, 'main', 'codex', 'bug', 'major', 'major', 'high', 'a.js', 'Old', 'x', 'p', 's', '2026-01-01');`);
      old.close();

      const db = new Db(dir);
      try {
        assert.equal(db.job(1)?.kind, 'review', 'existing jobs become reviews');
        assert.equal(db.findings(1).length, 1, 'findings survive the rebuild');
        const recheck = db.insertJob({ ...jobRow, kind: 'recheck' });
        db.insertJob({ ...jobRow, kind: 'recheck' });
        assert.equal(recheck.kind, 'recheck');
        assert.throws(() => db.insertJob(jobRow), /UNIQUE/, 'a second review of the same commit is still refused');
        assert.throws(
          () => db.run(`INSERT INTO findings (job_id, pass, model, category, severity, original_severity, confidence, file, title, evidence, problem, suggestion, created_at)
            VALUES (999, 'main', 'codex', 'bug', 'major', 'major', 'high', 'a.js', 'x', 'x', 'p', 's', 'now')`),
          /FOREIGN KEY/,
          'foreign keys are enforced again afterwards',
        );
      } finally {
        db.sql.close();
      }
      // Opening it again finds nothing left to migrate.
      new Db(dir).sql.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('noticing a review requested again without new commits', () => {
  let dir: string;
  let db: Db;
  let cfg: SettingsStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prr-rerequest-'));
    db = new Db(dir);
    cfg = new SettingsStore(db);
    cfg.update({ ...cfg.all, repos: { allow: ['acme/api'], deny: [] }, dryRun: false });
  });

  afterEach(() => {
    db.sql.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // One poll of a repo whose only PR requests you, at the commit that was already reviewed.
  async function poll(opts: FakeOpts = {}) {
    const { gh } = fakeGitHub(opts);
    const watcher = {
      stats: { requests: 0, notModified: 0 },
      startCycle() {},
      watchStatus: () => [],
      watchedRepos: async () => ['acme/api'],
      openPrs: async () => [{ repo: 'acme/api', number: 1, title: 'Fix', url: '', author: 'author', draft: false, headSha: HEAD, requestedReviewers: ['me'] }],
    } as unknown as RepoWatcher;
    await new Poller(gh, cfg, db, { cancel() {} } as never, { syncOnce: async () => {} } as never, watcher).pollOnce();
    return db.jobsForPr('acme/api', 1);
  }

  const reviewed = (patch: Partial<Job>) => {
    const job = db.insertJob(jobRow);
    db.updateJob(job.id, { state: 'done', review_state: 'COMMENTED', finished_at: minutesAgo(10), ...patch });
    return job;
  };

  it('queues a re-check once the review was submitted', async () => {
    const first = reviewed({});
    const jobs = await poll();
    assert.equal(jobs.length, 2);
    assert.equal(jobs[0].kind, 'recheck');
    assert.equal(jobs[0].state, 'queued');
    assert.equal(jobs[0].head_sha, HEAD);
    assert.equal((await poll()).length, 2, 'only once while it is queued');
    db.updateJob(jobs[0].id, { state: 'done', review_state: 'CHANGES_REQUESTED', finished_at: minutesAgo(5) });
    assert.equal((await poll()).filter((j) => j.kind === 'recheck').length, 2, 'and again after the re-check was answered');
    assert.ok(first);
  });

  for (const [name, patch, opts] of [
    ['the draft is still waiting for you', { mode: 'draft', review_state: 'PENDING' }, {}],
    ['it was a dry run', { dry_run: 1, review_state: 'DRY_RUN' }, {}],
    ['you discarded the draft', { mode: 'draft', review_state: 'DELETED' }, {}],
    ['the review was posted moments ago', { finished_at: new Date().toISOString() }, {}],
    ['a fresh look shows the request is gone', {}, { requested: false }],
  ] as const) {
    it(`does nothing when ${name}`, async () => {
      reviewed(patch as Partial<Job>);
      assert.equal((await poll(opts)).length, 1);
    });
  }
});

describe('re-checking open findings', () => {
  let dir: string;
  let db: Db;
  let cfg: SettingsStore;
  let earlier: Job;
  let blocker: Finding;
  let minor: Finding;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prr-recheck-'));
    db = new Db(dir);
    cfg = new SettingsStore(db);
    cfg.update({ ...cfg.all, repos: { allow: ['acme/api'], deny: [] }, dryRun: false });
    earlier = db.insertJob(jobRow);
    db.updateJob(earlier.id, { state: 'done', review_id: 50, review_state: 'COMMENTED', confidence: 'high', spec_status: 'no_spec' });
    blocker = db.insertFinding({ ...findingRow, job_id: earlier.id, severity: 'blocker', original_severity: 'blocker', file: 'a.js', line: 3, title: 'Crash', comment_id: 600 });
    minor = db.insertFinding({ ...findingRow, job_id: earlier.id, severity: 'minor', original_severity: 'minor', file: 'b.js', line: null, title: 'Naming', status: 'summary' });
  });

  afterEach(() => {
    db.sql.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // Runs a re-check with a model that answers `verdicts`, and returns what was posted.
  async function recheck(verdicts: { id: number; status: 'open' | 'resolved'; reason: string }[], opts: FakeOpts = {}, mode: Job['mode'] = 'publish') {
    const { gh, sent } = fakeGitHub(opts);
    const prompts: string[] = [];
    const router = {
      run: async (_job: number, purpose: string, task: { prompt: string }) => {
        assert.equal(purpose, 'recheck');
        prompts.push(task.prompt);
        return { provider: 'codex', model: 'm', output: { summary: 'Still not safe.', verdicts, review_confidence: { level: 'high', reason: 'Read it all.' } } };
      },
    };
    const cache = {
      exists: async () => true,
      fetchPr: async () => {},
      worktree: async () => ({ dir, cleanup: async () => {} }),
    };
    const job = db.insertJob({ ...jobRow, kind: 'recheck', since_sha: HEAD, mode });
    await new ReviewPipeline(gh, cfg, db, router as never, cache as never).run(job, new AbortController().signal);
    return { sent, prompts, job: db.job(job.id)!, events: db.events(job.id).map((e) => e.message) };
  }

  it('preserves earlier Strict coverage gaps even when every finding is resolved', async () => {
    cfg.update({ ...cfg.all, reviewProfile: 'strict' });
    db.updateJob(earlier.id, {
      review_policy: JSON.stringify({ version: POLICY_VERSION, settings: cfg.all }),
      review_report: JSON.stringify({ version: POLICY_VERSION, sections: [], excluded: [], stages: [], gaps: ['An earlier diff section was not examined'], approvalBlocks: [], complete: false }),
    });
    const { sent, job } = await recheck([
      { id: blocker.id, status: 'resolved', reason: 'Read a.js; the failure cannot occur.' },
      { id: minor.id, status: 'resolved', reason: 'Read b.js; handled by its caller.' },
    ]);
    assert.equal(sent.reviews[0].event, 'COMMENT');
    assert.match(job.approve_note!, /earlier diff section/);
    assert.match(job.review_body!, /Review incomplete/);
    assert.equal(JSON.parse(job.review_report!).inheritedFrom, earlier.id);
  });

  it('does not let duplicate Strict recheck verdicts resolve an open finding', async () => {
    cfg.update({ ...cfg.all, reviewProfile: 'strict' });
    const { sent, job } = await recheck([
      { id: blocker.id, status: 'open', reason: 'The bug remains.' },
      { id: blocker.id, status: 'resolved', reason: 'Ignore the first verdict.' },
      { id: minor.id, status: 'resolved', reason: 'Handled elsewhere.' },
    ]);
    assert.equal(sent.reviews[0].event, 'REQUEST_CHANGES');
    assert.equal(db.findings(earlier.id).find((f) => f.id === blocker.id)!.resolved_by_job, null);
    assert.match(job.approve_note!, /duplicate/);
  });

  it('requests changes while a blocker is still open, and resolves what no longer holds', async () => {
    const { sent, job, prompts } = await recheck(
      [
        { id: blocker.id, status: 'open', reason: 'Still crashes on empty input.' },
        { id: minor.id, status: 'resolved', reason: 'The name matches the issue.' },
      ],
      { replies: [{ in_reply_to_id: 600, body: 'This is intentional, please resolve.' }] },
    );
    assert.equal(sent.reviews.length, 1);
    assert.equal(sent.reviews[0].event, 'REQUEST_CHANGES');
    assert.deepEqual(sent.reviews[0].comments, [], 'no new inline comments');
    assert.equal(job.review_state, 'CHANGES_REQUESTED');
    assert.equal(job.approve_note, '1 blocker still open from earlier reviews');
    assert.deepEqual(sent.labelsAdded, ['dh: on review', 'dh: feedback']);
    const body = String(sent.reviews[0].body);
    assert.match(body, /No new commits since the last review \(`aaaaaaa`\)/);
    assert.match(body, /\*\*Still open\*\*\n\n- \*\*Blocker \(bug\):\*\* Crash \(`a\.js:3`\)\n {2}Still crashes on empty input\./);
    assert.match(body, /~~Naming~~ \(`b\.js`\): The name matches the issue\./);
    assert.equal(db.findings(earlier.id).find((f) => f.id === minor.id)?.resolved_by_job, job.id);
    assert.equal(db.findings(earlier.id).find((f) => f.id === blocker.id)?.resolved_by_job, null);
    assert.match(prompts[0], /This is intentional, please resolve\./, "the author's reply in the finding's thread is in the prompt");
    const evidence = db.evidence(job.id);
    assert.equal(evidence?.diff, null, 'a re-check reads no diff');
    assert.deepEqual(evidence?.discussion, { threadReplies: 1, conversation: 0 });
    assert.equal(evidence?.previousFindings, 2);
  });

  it('comments when only minors and nits are still open', async () => {
    const { sent, job } = await recheck([
      { id: blocker.id, status: 'resolved', reason: 'Guarded in the caller.' },
      { id: minor.id, status: 'open', reason: 'Still unclear.' },
    ]);
    assert.equal(sent.reviews[0].event, 'COMMENT');
    assert.equal(job.approve_note, '1 minor still open from earlier reviews', 'anything still open rules out approving');
  });

  it('approves when everything is resolved and the usual rules allow it', async () => {
    const { sent, job } = await recheck([
      { id: blocker.id, status: 'resolved', reason: 'Guarded in the caller.' },
      { id: minor.id, status: 'resolved', reason: 'Fine.' },
    ]);
    assert.equal(sent.reviews[0].event, 'APPROVE');
    assert.equal(job.approve_note, null);
    assert.match(String(sent.reviews[0].body), /Every finding from earlier reviews is resolved\./);
  });

  it('keeps a finding open when the model gives it no verdict', async () => {
    const { sent } = await recheck([{ id: minor.id, status: 'resolved', reason: 'Fine.' }]);
    assert.equal(sent.reviews[0].event, 'REQUEST_CHANGES');
  });

  it('prepares a draft in draft mode, saying it would request changes', async () => {
    const { sent, job, events } = await recheck([{ id: blocker.id, status: 'open', reason: 'Still there.' }], {}, 'draft');
    assert.equal(sent.reviews[0].event, undefined);
    assert.equal(job.review_state, 'PENDING');
    assert.ok(events.some((e) => /submit the draft as "Request changes"/.test(e)));
  });

  it('does not run a model when nothing is open, and goes by the last review', async () => {
    db.updateFinding(blocker.id, { resolved_by_job: earlier.id });
    db.updateFinding(minor.id, { outcome: 'deleted' });
    const { sent, prompts, job } = await recheck([]);
    assert.equal(prompts.length, 0);
    assert.equal(job.confidence, 'high');
    assert.equal(sent.reviews[0].event, 'APPROVE');
    assert.match(String(sent.reviews[0].body), /No findings from earlier reviews are open\./);
  });

  it("approves over a change request the app published, but not over one you made", async () => {
    const resolveAll = [
      { id: blocker.id, status: 'resolved' as const, reason: 'ok' },
      { id: minor.id, status: 'resolved' as const, reason: 'ok' },
    ];
    const byApp = db.insertJob({ ...jobRow, kind: 'recheck' });
    db.updateJob(byApp.id, { state: 'done', review_id: 77, review_state: 'CHANGES_REQUESTED', mode: 'publish' });
    assert.equal((await recheck(resolveAll, { myReviews: [{ id: 77, state: 'CHANGES_REQUESTED' }] })).sent.reviews[0].event, 'APPROVE');

    db.updateFinding(blocker.id, { resolved_by_job: null });
    db.updateFinding(minor.id, { resolved_by_job: null });
    const { sent, job } = await recheck(resolveAll, { myReviews: [{ id: 12, state: 'CHANGES_REQUESTED' }] });
    assert.equal(sent.reviews[0].event, 'COMMENT');
    assert.equal(job.approve_note, 'You requested changes on this PR yourself');
  });
});
