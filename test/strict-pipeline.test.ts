import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Db } from '../src/db.ts';
import type { GitHub } from '../src/github/client.ts';
import { SettingsStore } from '../src/settings.ts';
import { NoProviderAvailable } from '../src/llm/router.ts';
import type { RouterTask } from '../src/llm/router.ts';
import { ReviewPipeline } from '../src/review/pipeline.ts';
import { StrictReviewWaiting } from '../src/review/strict.ts';
import { Poller } from '../src/jobs/poller.ts';

describe('Strict pipeline integration', () => {
  let dir: string; let db: Db; let cfg: SettingsStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prr-strict-pipeline-')); db = new Db(dir); cfg = new SettingsStore(db);
    cfg.update({ ...cfg.all, reviewProfile: 'strict', repos: { allow: ['acme/api'], deny: [] }, dryRun: false, defaultMode: 'publish' });
    fs.writeFileSync(path.join(dir, 'a.js'), 'const limit = 0;\n');
  });
  afterEach(() => { db.sql.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  function fixture(opts: { concern?: boolean; uncertain?: boolean; missingCoverage?: boolean; unavailable?: () => boolean; moveHead?: boolean; closePr?: boolean } = {}) {
    const reviews: any[] = []; const calls: string[] = []; let reads = 0;
    const gh = {
      me: 'me', token: 't', rateLimits: new Map(),
      octokit: {
        graphql: async () => { throw new Error('No linked issues'); },
        paginate: async (fn: any, params: any) => (await fn(params)).data,
        rest: {
          pulls: {
            get: async () => { reads++; return { data: {
              title: 'Change the limit', body: '', html_url: 'https://github.com/acme/api/pull/1', user: { login: 'author' }, draft: false,
              state: opts.closePr && reads > 1 ? 'closed' : 'open',
              head: { sha: opts.moveHead && reads > 1 ? 'c'.repeat(40) : 'a'.repeat(40), ref: 'fix' },
              base: { sha: 'b'.repeat(40), ref: 'main', repo: { full_name: 'acme/api' } },
              additions: 1, deletions: 1, changed_files: 1, labels: [], requested_reviewers: [],
            } }; },
            listFiles: async () => ({ data: [{ filename: 'a.js', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-const limit = 1;\n+const limit = 0;' }] }),
            listReviews: async () => ({ data: [] }),
            listCommentsForReview: async () => ({ data: [] }),
            createReview: async (review: any) => { reviews.push(review); return { data: { id: 90, html_url: '', state: review.event === 'APPROVE' ? 'APPROVED' : 'COMMENTED' } }; },
          },
          issues: { getLabel: async () => ({}), addLabels: async () => ({}), removeLabel: async () => ({}), createLabel: async () => ({}) },
        },
      },
    } as unknown as GitHub;
    const cache = {
      exists: async () => true, fetchPr: async () => {}, worktree: async () => ({ dir, cleanup: async () => {} }),
      mergeBase: async () => 'b'.repeat(40), history: async () => [], readFile: async () => null,
    };
    const router = { run: async (id: number, purpose: string, task: RouterTask, options: { providers: ('codex' | 'claude')[]; config: SettingsStore }) => {
      calls.push(purpose);
      assert.equal(options.config.reviewProfile, 'strict'); assert.equal(options.config.limits.passTimeoutSec, 1800);
      assert.equal(options.config.limits.claudeMaxTurns, 120); assert.equal(options.config.models.claudeEffort, 'high');
      if (purpose.startsWith('strict:adversarial:') && opts.unavailable?.()) throw new NoProviderAvailable(new Date(Date.now() + 60000));
      const idMatch = /"id":(\d+)/.exec(task.prompt);
      const output = purpose.startsWith('strict:verify:') ? { verdicts: [{ id: Number(idMatch![1]), verdict: opts.uncertain ? 'uncertain' : 'confirmed', adjusted_severity: 'major', reason: 'Checked a.js; its limit can discard results.' }] } : {
        summary: 'Reviewed the changed limit.',
        findings: opts.concern && purpose.startsWith('strict:main:') ? [{ category: 'bug', severity: 'major', confidence: 'high', file: 'a.js', line: 1, title: 'Drops all results', evidence: 'const limit = 0;', problem: 'All results are discarded.', suggestion: 'Use a positive limit.' }] : [],
        questions_for_author: [], resolved_previous_ids: [], spec_alignment: { status: 'no_spec', notes: '' }, review_confidence: { level: 'high', reason: 'Read a.js.' }, requirements: [],
        coverage: opts.missingCoverage ? [] : [...task.prompt.matchAll(/^## Assigned section (.+)$/gm)].map((m) => ({ section_id: m[1], status: 'examined', dependencies: ['a.js'], tests: [], configuration: [], notes: 'Read a.js; no other files apply.' })),
      };
      const provider = options.providers[0];
      db.insertRun({ job_id: id, purpose, provider, model: 'm', ok: 1, fell_back: 0, duration_ms: 1, error: null, turns: 1, tool_calls: 1, input_tokens: 10, cached_input_tokens: 0, output_tokens: 10, cost_usd: null, output: JSON.stringify(output) });
      return { provider, model: 'm', output };
    } };
    const job = db.insertJob({ repo: 'acme/api', pr_number: 1, pr_title: '', pr_url: '', author: 'author', head_sha: 'a'.repeat(40), base_sha: 'b'.repeat(40), since_sha: null, mode: 'publish', source: 'manual', dry_run: 0, state: 'queued', additions: 1, deletions: 1, changed_files: 1 });
    const pipeline = new ReviewPipeline(gh, cfg, db, router as never, cache as never);
    return { job, pipeline, reviews, calls, gh };
  }

  it('approves only after the complete Strict workflow succeeds', async () => {
    const { job, pipeline, reviews, calls } = fixture();
    await pipeline.run(job, new AbortController().signal);
    assert.equal(db.job(job.id)!.state, 'done'); assert.equal(reviews[0].event, 'APPROVE');
    assert.equal(calls.length, 3); assert.equal(JSON.parse(db.job(job.id)!.review_report!).complete, true);
  });
  it('posts uncertain serious concerns only as clearly marked summary items and never approves', async () => {
    const { job, pipeline, reviews } = fixture({ concern: true, uncertain: true });
    await pipeline.run(job, new AbortController().signal);
    assert.equal(reviews[0].event, 'COMMENT'); assert.equal(reviews[0].comments?.length ?? 0, 0);
    assert.match(reviews[0].body, /Unverified concern/);
    const f = db.findings(job.id)[0]; assert.equal(f.severity, 'major'); assert.equal(f.status, 'summary');
    assert.match(db.job(job.id)!.approve_note!, /unresolved serious verification/);
  });
  it('retains explicit gaps and refuses approval when a model claims high confidence without coverage', async () => {
    const { job, pipeline, reviews } = fixture({ missingCoverage: true });
    await pipeline.run(job, new AbortController().signal);
    assert.equal(reviews[0].event, 'COMMENT'); assert.match(reviews[0].body, /Review incomplete/);
    assert.equal(db.job(job.id)!.confidence, 'low'); assert.equal(JSON.parse(db.job(job.id)!.review_report!).complete, false);
  });
  it('waits on an independent-provider outage and resumes without rerunning successful stages or duplicating findings', async () => {
    let unavailable = true;
    const { job, pipeline, reviews, calls } = fixture({ concern: true, unavailable: () => unavailable });
    await assert.rejects(pipeline.run(job, new AbortController().signal), StrictReviewWaiting);
    assert.equal(reviews.length, 0); assert.equal(db.findings(job.id).length, 1);
    unavailable = false;
    await pipeline.run(db.job(job.id)!, new AbortController().signal);
    assert.equal(reviews.length, 1); assert.equal(db.findings(job.id).length, 1);
    assert.equal(calls.filter((p) => p.startsWith('strict:main:')).length, 1);
    assert.equal(calls.filter((p) => p.startsWith('strict:security:')).length, 1);
  });
  it('refuses automatic posting when the PR moves or closes during review', async () => {
    for (const opts of [{ moveHead: true }, { closePr: true }]) {
      // Audit jobs intentionally allow another full review of the same head.
      const f = fixture(opts);
      await assert.rejects(f.pipeline.run(f.job, new AbortController().signal), /superseded|no longer open/);
      assert.equal(f.reviews.length, 0);
      db.run('DELETE FROM findings'); db.run('DELETE FROM runs'); db.run('DELETE FROM events'); db.run('DELETE FROM evidence'); db.run('DELETE FROM jobs');
    }
  });
  it('queues a fresh full PR audit without the one-review-per-head constraint and enforces the active-job guard', async () => {
    const f = fixture(); db.setState(f.job.id, 'done');
    const poller = new Poller(f.gh, cfg, db, null as never, null as never);
    const audit = await poller.fullReviewFromDashboard(f.job.id);
    assert.equal(audit.kind, 'audit'); assert.equal(audit.since_sha, null); assert.equal(audit.source, 'manual');
    await assert.rejects(poller.fullReviewFromDashboard(f.job.id), /already has a review/);
  });
});
