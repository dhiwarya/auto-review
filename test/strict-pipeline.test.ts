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
import { StrictReviewWaiting, StrictReviewIncomplete } from '../src/review/strict.ts';
import { Poller } from '../src/jobs/poller.ts';
import { POLICY_VERSION } from '../src/review/policy.ts';

describe('Strict pipeline integration', () => {
  let dir: string; let db: Db; let cfg: SettingsStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prr-strict-pipeline-')); db = new Db(dir); cfg = new SettingsStore(db);
    cfg.update({ ...cfg.all, reviewProfile: 'strict', repos: { allow: ['acme/api'], deny: [] }, dryRun: false, defaultMode: 'publish' });
    fs.writeFileSync(path.join(dir, 'a.js'), 'const limit = 0;\n');
  });
  afterEach(() => { db.sql.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  function fixture(opts: { concern?: boolean; uncertain?: boolean; missingCoverage?: boolean; recoverCoverage?: boolean; prBody?: string; unavailable?: () => boolean; moveHead?: boolean; closePr?: boolean } = {}) {
    const reviews: any[] = []; const calls: string[] = []; let reads = 0; let deltaReads = 0;
    const file = { filename: 'a.js', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-const limit = 1;\n+const limit = 0;' };
    const gh = {
      me: 'me', token: 't', rateLimits: new Map(),
      octokit: {
        graphql: async () => ({ repository: { pullRequest: { closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } }),
        paginate: async (fn: any, params: any) => (await fn(params)).data,
        rest: {
          pulls: {
            get: async () => { reads++; return { data: {
              title: 'Change the limit', body: opts.prBody ?? '', html_url: 'https://github.com/acme/api/pull/1', user: { login: 'author' }, draft: false,
              state: opts.closePr && reads > 1 ? 'closed' : 'open',
              head: { sha: opts.moveHead && reads > 1 ? 'c'.repeat(40) : 'a'.repeat(40), ref: 'fix' },
              base: { sha: 'b'.repeat(40), ref: 'main', repo: { full_name: 'acme/api' } },
              additions: 1, deletions: 1, changed_files: 1, labels: [], requested_reviewers: [],
            } }; },
            listFiles: async () => ({ data: [file] }),
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
      hasCommit: async () => true, isAncestor: async () => true, diffFiles: async () => { deltaReads++; return [file]; },
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
        coverage: opts.missingCoverage || opts.recoverCoverage && purpose.startsWith('strict:security:') && !purpose.includes(':continuation-') ? [] : [...task.prompt.matchAll(/^## Assigned section (.+)$/gm)].map((m) => ({ section_id: m[1], status: 'examined', dependencies: ['a.js'], tests: [], configuration: [], notes: 'Read a.js; no other files apply.' })),
      };
      const provider = options.providers[0];
      db.insertRun({ job_id: id, purpose, provider, model: 'm', ok: 1, fell_back: 0, duration_ms: 1, error: null, turns: 1, tool_calls: 1, input_tokens: 10, cached_input_tokens: 0, output_tokens: 10, cost_usd: null, output: JSON.stringify(output) });
      return { provider, model: 'm', output };
    } };
    const job = db.insertJob({ repo: 'acme/api', pr_number: 1, pr_title: '', pr_url: '', author: 'author', head_sha: 'a'.repeat(40), base_sha: 'b'.repeat(40), since_sha: null, mode: 'publish', source: 'manual', dry_run: 0, state: 'queued', additions: 1, deletions: 1, changed_files: 1 });
    const pipeline = new ReviewPipeline(gh, cfg, db, router as never, cache as never);
    return { job, pipeline, reviews, calls, gh, deltaReads: () => deltaReads };
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
  it('retains explicit gaps and refuses automatic posting when high confidence lacks coverage', async () => {
    const { job, pipeline, reviews } = fixture({ missingCoverage: true });
    await assert.rejects(pipeline.run(job, new AbortController().signal), StrictReviewIncomplete);
    assert.equal(reviews.length, 0); assert.match(db.job(job.id)!.review_body!, /Review incomplete/);
    assert.doesNotMatch(db.job(job.id)!.review_body!, /\*\*No issues found/);
    assert.equal(db.job(job.id)!.confidence, 'low'); assert.equal(JSON.parse(db.job(job.id)!.review_report!).complete, false);
  });
  it('requires an explicit manual partial-post choice after bounded recovery fails', async () => {
    const { job, pipeline, reviews } = fixture({ missingCoverage: true });
    await assert.rejects(pipeline.run(job, new AbortController().signal), StrictReviewIncomplete);
    db.setState(job.id, 'failed', { error: 'Coverage remains incomplete' });
    assert.equal((await pipeline.previewPost(job.id)).partial, true);
    await assert.rejects(pipeline.postDryRun(job.id, 'publish'), /explicitly choose/i);
    assert.equal(reviews.length, 0);
    await pipeline.postDryRun(job.id, 'publish', true);
    assert.equal(reviews[0].event, 'COMMENT');
    assert.match(reviews[0].body, /Review incomplete/); assert.match(reviews[0].body, /Approval withheld/);
    assert.doesNotMatch(reviews[0].body, /\*\*No issues found/);
  });
  it('finishes recoverable coverage before publishing, without repeating successful passes', async () => {
    const { job, pipeline, reviews, calls } = fixture({ recoverCoverage: true });
    await pipeline.run(job, new AbortController().signal);
    assert.equal(reviews[0].event, 'APPROVE'); assert.equal(calls.length, 4);
    assert.equal(calls.filter((p) => p.startsWith('strict:main:')).length, 1);
    assert.match(reviews[0].body, /Review complete/); assert.doesNotMatch(reviews[0].body, /Review incomplete/);
  });
  it('automatically expands a follow-up with an incomplete baseline to one full PR review', async () => {
    const f = fixture();
    const baseline = db.insertJob({ ...db.job(f.job.id)!, head_sha: 'c'.repeat(40), state: 'done' });
    db.updateJob(baseline.id, { confidence: 'low', review_policy: JSON.stringify({ version: 1, settings: cfg.all }), review_report: JSON.stringify({ version: 1, complete: false, stages: [], gaps: ['Old context was clipped'], approvalBlocks: [] }) });
    const followup = db.updateJob(f.job.id, { since_sha: baseline.head_sha });
    await f.pipeline.run(followup, new AbortController().signal);
    assert.equal(f.deltaReads(), 0); assert.equal(db.job(f.job.id)!.since_sha, null);
    assert.match(JSON.parse(db.job(f.job.id)!.review_report!).recovery, /Automatically expanded/);
    assert.equal(f.reviews.length, 1); assert.equal(f.reviews[0].event, 'APPROVE');
    assert.ok(f.calls.every((p) => p.startsWith('strict:')));
  });
  it('retains incremental review against a complete baseline even with an earlier open major', async () => {
    const f = fixture();
    const baseline = db.insertJob({ ...db.job(f.job.id)!, head_sha: 'c'.repeat(40), state: 'done' });
    db.updateJob(baseline.id, { confidence: 'medium', review_policy: JSON.stringify({ version: POLICY_VERSION, settings: cfg.all }), review_report: JSON.stringify({ version: POLICY_VERSION, complete: true, sections: [], excluded: [], stages: ['main/batch-1', 'security/batch-1', 'adversarial/batch-1'].map((purpose) => ({ key: purpose, purpose, state: 'done', coverage: [], provider: 'codex', model: 'm', error: null })), gaps: [], approvalBlocks: [] }) });
    db.insertFinding({ job_id: baseline.id, pass: 'main', model: 'codex', model_id: 'm', category: 'bug', severity: 'major', original_severity: 'major', confidence: 'high', file: 'a.js', line: 1, title: 'Earlier major', evidence: 'const limit = 0;', problem: 'The bug remains.', suggestion: 'Fix it.', verification: 'confirmed', verified_by: 'claude', verify_reason: 'Read a.js', status: 'summary', drop_reason: null, comment_id: null, outcome: 'published' });
    await f.pipeline.run(db.updateJob(f.job.id, { since_sha: baseline.head_sha }), new AbortController().signal);
    assert.equal(f.deltaReads(), 1); assert.equal(db.job(f.job.id)!.since_sha, baseline.head_sha);
    assert.equal(JSON.parse(db.job(f.job.id)!.review_report!).complete, true);
    assert.equal(f.reviews[0].event, 'COMMENT'); assert.match(db.job(f.job.id)!.approve_note!, /majors remain open/);
  });
  it('reassesses earlier code uncertainty instead of losing unresolved questions on a follow-up', async () => {
    const f = fixture();
    const baseline = db.insertJob({ ...db.job(f.job.id)!, head_sha: 'c'.repeat(40), state: 'done' });
    db.updateJob(baseline.id, { confidence: 'medium', review_policy: JSON.stringify({ version: POLICY_VERSION, settings: cfg.all }), review_report: JSON.stringify({ version: POLICY_VERSION, complete: true, sections: [], excluded: [], stages: ['main/batch-1', 'security/batch-1', 'adversarial/batch-1'].map((purpose) => ({ key: purpose, purpose, state: 'done', coverage: [], provider: 'codex', model: 'm', error: null })), gaps: [], approvalBlocks: ['Unresolved questions affect review confidence'] }) });
    db.updateJob(baseline.id, { review_body: '**Questions**\nDoes production enforce request idempotency?' });
    await f.pipeline.run(db.updateJob(f.job.id, { since_sha: baseline.head_sha }), new AbortController().signal);
    assert.equal(f.deltaReads(), 0);
    assert.ok(db.contextSnapshot(f.job.id)!.sources.some((s) => s.kind === 'prior-review' && s.text.includes('Does production enforce request idempotency?')));
    assert.match(JSON.parse(db.job(f.job.id)!.review_report!).recovery, /earlier questions/);
  });
  it('upgrades an unposted old-policy job and rebuilds full coverage instead of publishing its prepared body', async () => {
    const f = fixture();
    const old = db.updateJob(f.job.id, { review_policy: JSON.stringify({ version: 1, settings: cfg.all }), review_report: JSON.stringify({ version: 1, complete: true, stages: [], gaps: [], approvalBlocks: [] }), review_body: 'OLD_PREPARED_REVIEW' });
    await f.pipeline.run(old, new AbortController().signal);
    assert.equal(f.calls.length, 3); assert.doesNotMatch(f.reviews[0].body, /OLD_PREPARED/);
    const policy = JSON.parse(db.job(f.job.id)!.review_policy!);
    assert.equal(policy.version, POLICY_VERSION); assert.equal(policy.previousPolicy.version, 1);
  });
  it('does not publish when complete source material exceeds the configured batch budget', async () => {
    cfg.update({ ...cfg.all, strict: { ...cfg.strict, maxDiffChars: 20000, maxBatches: 1 } });
    const f = fixture({ prBody: 'Long PR context.\n'.repeat(5000) });
    await assert.rejects(f.pipeline.run(f.job, new AbortController().signal), StrictReviewIncomplete);
    assert.equal(f.reviews.length, 0);
    const report = JSON.parse(db.job(f.job.id)!.review_report!);
    assert.ok(report.gaps.some((g: string) => g.includes('unassigned')));
    assert.ok(report.sources[0].chars > 8000);
    assert.ok(report.sections.some((s: any) => s.id.startsWith('context:pr-description:')));
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
      db.run('DELETE FROM findings'); db.run('DELETE FROM runs'); db.run('DELETE FROM events'); db.run('DELETE FROM evidence'); db.run('DELETE FROM review_context'); db.run('DELETE FROM jobs');
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
