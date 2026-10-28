import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Db } from '../src/db.ts';
import { NoProviderAvailable, Router } from '../src/llm/router.ts';
import type { RouterTask } from '../src/llm/router.ts';
import { SettingsStore } from '../src/settings.ts';
import type { Finding, Job, Provider, StrictReport, StrictStage } from '../src/types.ts';
import type { ReviewContext } from '../src/review/context.ts';
import { POLICY_VERSION, strictApprovalBlocks } from '../src/review/policy.ts';
import { coverageGaps, makeBatches, runStrictReview } from '../src/review/strict.ts';
import { placeFindings, type Candidate } from '../src/review/validate.ts';

const finding = {
  category: 'bug' as const, severity: 'major' as const, confidence: 'high' as const,
  file: 'a.js', line: 1, title: 'Zero limit loses the result', evidence: 'const limit = 0;',
  problem: 'A zero limit drops all results for nonempty input.', suggestion: 'Validate and use a positive limit.',
};
const jobRow = {
  repo: 'acme/api', pr_number: 1, pr_title: 'Change', pr_url: '', author: 'author',
  head_sha: 'a'.repeat(40), base_sha: 'b'.repeat(40), since_sha: null,
  mode: 'draft' as const, source: 'manual' as const, dry_run: 1, state: 'queued' as const,
  additions: 1, deletions: 1, changed_files: 1,
};
const stage = (purpose: string): StrictStage => ({ key: purpose, purpose, provider: 'codex', model: 'm', state: 'done', error: null, coverage: [] });
const completeReport = (): StrictReport => ({
  version: POLICY_VERSION, sections: [], excluded: [], stages: ['main/batch-1', 'security/batch-1', 'adversarial/batch-1'].map(stage),
  gaps: [], approvalBlocks: [], complete: true,
});

describe('Strict review', () => {
  let dir: string; let db: Db; let cfg: SettingsStore; let job: Job; let ctx: ReviewContext;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prr-strict-'));
    db = new Db(dir); cfg = new SettingsStore(db);
    cfg.update({ ...cfg.all, reviewProfile: 'strict', repos: { allow: ['acme/api'], deny: [] } });
    job = db.insertJob(jobRow);
    job = db.updateJob(job.id, { review_policy: JSON.stringify({ version: POLICY_VERSION, settings: cfg.all }), confidence: 'high', spec_status: 'no_spec' });
    fs.writeFileSync(path.join(dir, 'a.js'), 'const limit = 0;\nconst items = [];\n');
    const file = { filename: 'a.js', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-const limit = 1;\n+const limit = 0;' };
    ctx = {
      pr: {} as never, me: 'me', prFiles: [file], reviewFiles: [file], excluded: [], issues: [], incremental: false,
      large: false, truncated: false, changedLines: 2, previous: [], prompt: 'Context and clipped diff', contextPrompt: 'PR context',
      evidence: { diff: { baseSha: job.base_sha, headSha: job.head_sha, sinceSha: null, prFiles: 1, files: [], changedLines: 2, diffChars: 50, maxDiffChars: 500000, large: false }, issues: [], prs: [], guidelines: [], history: [], previousFindings: 0, discussion: null, promptChars: 100 },
    };
  });
  afterEach(() => { db.sql.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  function mockRouter(change?: (purpose: string, output: any, task: RouterTask) => void, unavailable?: () => boolean) {
    const calls: { purpose: string; provider: Provider; prompt: string; attemptCap?: number }[] = [];
    const router = { run: async (id: number, purpose: string, task: RouterTask, options: { providers: Provider[]; maxJobRuns?: number }) => {
      const provider = options.providers[0]; calls.push({ purpose, provider, prompt: task.prompt, attemptCap: options.maxJobRuns });
      if (purpose.startsWith('strict:adversarial:') && unavailable?.()) throw new NoProviderAvailable(new Date(Date.now() + 60_000));
      let output: any;
      if (purpose.startsWith('strict:verify:')) {
        const match = /"id":(\d+)/.exec(task.prompt)!;
        output = { verdicts: [{ id: Number(match[1]), verdict: 'confirmed', adjusted_severity: 'major', reason: 'Checked a.js and confirmed the zero limit.' }] };
      } else {
        const ids = [...task.prompt.matchAll(/^## Assigned section (.+)$/gm)].map((m) => m[1]);
        if (purpose.includes(':all-batches:')) ids.push(...makeBatches(ctx, cfg).sections.map((s) => s.id));
        output = {
          summary: 'The changed paths were inspected.', findings: [], questions_for_author: [], resolved_previous_ids: [],
          spec_alignment: { status: ctx.issues.length ? 'aligned' : 'no_spec', notes: '' },
          review_confidence: { level: 'high', reason: 'Read the relevant code.' },
          coverage: ids.map((id) => ({ section_id: id, status: 'examined', dependencies: ['a.js'], tests: [], configuration: [], notes: 'Read a.js; no tests or configuration apply to this expression.' })),
          requirements: ctx.issues.map((i) => ({ ref: `${i.repo}#${i.number}`, criterion: i.body, status: 'implemented', reason: 'The requested behavior is present.', scope_evidence: '' })),
        };
      }
      change?.(purpose, output, task);
      db.insertRun({ job_id: id, purpose, provider, model: 'm', ok: 1, fell_back: 0, duration_ms: 1, error: null, turns: 1, tool_calls: 1, input_tokens: 10, cached_input_tokens: 0, output_tokens: 10, cost_usd: null, output: JSON.stringify(output) });
      return { provider, model: 'm', output };
    } };
    return { router: router as unknown as Router, calls };
  }
  const run = (router: Router) => runStrictReview({ job, ctx, cfg, db, router, task: { cwd: dir, workDir: dir, timeoutMs: 1000, signal: new AbortController().signal }, placeOpts: { checkoutDir: dir, prFiles: ctx.prFiles, previous: [], maxNits: 5 } });

  it('preserves existing Standard defaults and snapshots policy independently of later settings', () => {
    assert.equal(SettingsStore.defaults().reviewProfile, 'standard');
    const snapshot = cfg.snapshot();
    cfg.update({ ...cfg.all, reviewProfile: 'standard', strict: { ...cfg.strict, maxRuns: 5 } });
    assert.equal(snapshot.reviewProfile, 'strict'); assert.equal(snapshot.strict.maxRuns, 64);
  });
  it('requires independent providers and never shows the adversarial pass other findings', async () => {
    const { router, calls } = mockRouter((purpose, out) => { if (purpose.startsWith('strict:main:')) out.summary = 'UNIQUE_FIRST_PASS_RESULT'; });
    const result = await run(router);
    assert.equal(result.report.complete, true);
    assert.deepEqual(calls.map((c) => c.provider), ['codex', 'codex', 'claude']);
    assert.ok(!calls[2].prompt.includes('UNIQUE_FIRST_PASS_RESULT'));
    job = db.updateJob(job.id, { review_report: JSON.stringify(result.report) });
    assert.deepEqual(strictApprovalBlocks(job, [], true), []);
  });
  it('continues only missing sections and merges them with completed coverage', async () => {
    ctx.reviewFiles[0].patch += '\n@@ -5 +5 @@\n-oldAgain();\n+newAgain();';
    const { router, calls } = mockRouter((p, o) => {
      if (p.startsWith('strict:main:') && !p.includes(':continuation-')) o.coverage.pop();
    });
    const result = await run(router);
    assert.equal(result.report.complete, true);
    const continuation = calls.find((c) => c.purpose.includes(':continuation-'))!;
    assert.ok(continuation); assert.equal([...continuation.prompt.matchAll(/^## Assigned section /gm)].length, 1);
    assert.equal(result.report.stages.find((s) => s.purpose === 'main/batch-1')!.coverage.length, 2);
    assert.equal(result.report.stages.find((s) => s.purpose === 'main/batch-1')!.continuations, 1);
    assert.equal(calls.filter((c) => c.purpose.startsWith('strict:security:')).length, 1);
    assert.equal(calls.filter((c) => c.purpose.startsWith('strict:adversarial:')).length, 1);
  });
  it('does not treat literal truncation-looking repository text as a lost source', async () => {
    ctx.contextPrompt = 'Repository documentation says [truncated 100 chars] in an example.';
    const result = await run(mockRouter().router);
    assert.equal(result.report.complete, true); assert.deepEqual(result.report.gaps, []);
  });
  it('continues an unfinished requirement checklist and separates missing requirements from missing review coverage', async () => {
    ctx.issues = [{ repo: 'acme/api', number: 9, title: 'Requirement', body: 'Persist the receipt.', url: '', comments: [], linkedBy: 'closes' }];
    const { router, calls } = mockRouter((p, o) => {
      if (p.startsWith('strict:main:') && !p.includes(':continuation-')) o.requirements[0].status = 'not_checked';
    });
    const result = await run(router);
    assert.equal(result.report.complete, true); assert.equal(result.mainOut.spec_alignment.status, 'aligned');
    assert.ok(calls.some((c) => c.purpose.includes(':continuation-')));
    assert.ok(result.report.requirements!.every((r) => r.status === 'implemented'));
  });
  it('completes the job-61 comment citation pattern without wasting continuation attempts', async () => {
    const criterion = 'Client-side token fetching can be disabled by defining `BUILDKIT_NO_CLIENT_TOKEN=1`.';
    ctx.issues = [{ repo: 'moby/buildkit', number: 4725, title: 'Registry auth', body: 'Authentication fails behind a proxy.', url: '', comments: Array.from({ length: 11 }, () => ({ author: 'maintainer', body: criterion })), linkedBy: 'mentioned' }];
    const { router, calls } = mockRouter((p, o, task) => {
      const schema = task.schema as any;
      assert.deepEqual(schema.properties.requirements.items.properties.ref.enum, ['moby/buildkit#4725']);
      if (p.startsWith('strict:security:')) { o.requirements = []; return; }
      o.requirements = [{ ref: 'moby/buildkit#4725:comment-11', criterion, status: 'implemented', reason: 'The image sets the variable and the fixture checks its behavior.', scope_evidence: '' }];
    });
    const result = await run(router);
    assert.equal(result.report.complete, true); assert.deepEqual(result.report.gaps, []);
    assert.equal(calls.length, 3); assert.deepEqual(result.report.approvalBlocks, []);
    assert.ok(result.report.requirements!.every((r) => r.ref === 'moby/buildkit#4725'));
  });
  it('repairs malformed refs with exact diagnostics without repeating completed code coverage', async () => {
    ctx.issues = [{ repo: 'acme/api', number: 9, title: 'Requirement', body: 'Persist the receipt.', url: '', comments: [], linkedBy: 'closes' }];
    const { router, calls } = mockRouter((p, o, task) => {
      if (!p.startsWith('strict:main:')) return;
      if (!p.includes(':continuation-')) o.requirements[0].ref = 'acme/api#9:comment-999';
      else {
        assert.match(task.prompt, /Unknown issue ref acme\/api#9:comment-999/);
        assert.match(task.prompt, /Missing assessment for acme\/api#9/);
        assert.equal([...task.prompt.matchAll(/^## Assigned section /gm)].length, 0);
        o.requirements[0].status = 'missing';
      }
    });
    const result = await run(router);
    assert.equal(result.report.complete, true); assert.equal(calls.length, 4);
    assert.equal(result.report.stages[0].coverage.length, 1);
    assert.ok(result.report.approvalBlocks.some((b) => b.includes('is missing')));
    assert.equal(result.mainOut.spec_alignment.status, 'partial');
    assert.ok(result.report.requirements!.every((r) => r.ref === 'acme/api#9'));
  });
  it('keeps truly unfinished requirement assessments incomplete with actionable reasons', async () => {
    ctx.issues = [{ repo: 'acme/api', number: 9, title: 'Requirement', body: 'Persist the receipt.', url: '', comments: [], linkedBy: 'closes' }];
    const { router } = mockRouter((p, o) => { if (p.startsWith('strict:main:')) o.requirements[0].status = 'not_checked'; });
    const result = await run(router);
    assert.equal(result.report.complete, false);
    assert.ok(result.report.gaps.some((g) => g.includes('Unfinished assessment for acme/api#9: Persist the receipt.')));
  });
  it('requires an explicit consolidated verdict after conflicting parent and comment assessments', async () => {
    ctx.issues = [{ repo: 'acme/api', number: 9, title: 'Requirement', body: 'Persist the receipt.', url: '', comments: [{ author: 'a', body: 'Persist the receipt.' }], linkedBy: 'closes' }];
    const { router } = mockRouter((p, o) => {
      if (!p.startsWith('strict:main:')) return;
      if (!p.includes(':continuation-')) o.requirements.push({ ...o.requirements[0], ref: 'acme/api#9:comment-1', status: 'missing' });
      else o.requirements = [];
    });
    const result = await run(router);
    assert.equal(result.report.complete, false);
    assert.ok(result.report.gaps.some((g) => g.includes('Unfinished assessment for acme/api#9')));
  });
  it('accepts a complete medium-confidence baseline without treating known findings as missing coverage', async () => {
    const baseline = db.insertJob({ ...jobRow, head_sha: 'c'.repeat(40), state: 'done' });
    db.updateJob(baseline.id, { confidence: 'medium', review_policy: job.review_policy, review_report: JSON.stringify(completeReport()) });
    ctx.incremental = true; ctx.evidence.diff!.sinceSha = baseline.head_sha;
    const result = await run(mockRouter().router);
    assert.equal(result.report.complete, true); assert.equal(result.report.inheritedFrom, baseline.id);
  });
  it('reserves future discovery, synthesis and verification capacity before allowing continuation work', async () => {
    const { router, calls } = mockRouter((p, o) => { if (p.startsWith('strict:main:')) o.findings = [finding]; });
    await run(router);
    assert.deepEqual(calls.map((c) => c.attemptCap), [54, 55, 56, 64]);
  });
  it('rejects an oversized planned workload before starting discovery', async () => {
    cfg.update({ ...cfg.all, strict: { ...cfg.strict, maxDiffChars: 20000, maxRuns: 3 } });
    ctx.reviewFiles[0].patch = '@@ -1 +1,30 @@\n' + '+'.padEnd(1000, 'x').concat('\n').repeat(30);
    const { router, calls } = mockRouter(); const result = await run(router);
    assert.equal(calls.length, 0); assert.equal(result.report.complete, false);
    assert.ok(result.report.gaps.some((g) => g.includes('Planned workload')));
  });
  it('raises no new findings when refreshing full coverage for a same-commit recheck', async () => {
    ctx.recheckOnly = true;
    const { router, calls } = mockRouter((p, o) => { if (p.startsWith('strict:main:')) o.findings = [finding]; });
    const result = await run(router);
    assert.deepEqual(result.candidates, []); assert.equal(calls.length, 3);
  });
  it('keeps coverage incomplete despite high confidence when a section is missing or unverified', async () => {
    const { router } = mockRouter((p, o) => { if (p.startsWith('strict:security:')) o.coverage = []; });
    const result = await run(router);
    assert.equal(result.report.complete, false); assert.equal(result.mainOut.review_confidence.level, 'low');
    assert.ok(result.report.gaps.some((g) => g.includes('missing, duplicate or unverified')));
  });
  it('rejects duplicate, unknown and unverified coverage claims', () => {
    const sections = makeBatches(ctx, cfg).sections;
    const s = stage('main/batch-1');
    s.coverage = [{ section_id: 'unknown', status: 'examined', dependencies: [], tests: [], configuration: [], notes: 'Read it' }];
    assert.equal(coverageGaps(s, sections).length, 2);
    const row = { ...s.coverage[0], section_id: sections[0].id, status: 'unverified' as const };
    s.coverage = [row, row]; assert.equal(coverageGaps(s, sections).length, 1);
  });
  it('does not accept claimed checked files that are missing from the checkout', async () => {
    const { router } = mockRouter((_p, o) => { if (o.coverage) o.coverage[0].dependencies = ['missing.js']; });
    const result = await run(router);
    assert.equal(result.report.complete, false); assert.ok(result.report.gaps.some((g) => g.includes('missing checked-file')));
  });
  it('saves successful stages and retries only the independent provider after an outage', async () => {
    let unavailable = true;
    const { router, calls } = mockRouter(undefined, () => unavailable);
    const first = await run(router);
    assert.equal(first.report.complete, false); assert.ok(first.retryAt);
    unavailable = false;
    const second = await run(router);
    assert.equal(second.report.complete, true);
    assert.equal(calls.filter((c) => c.purpose.startsWith('strict:main:')).length, 1);
    assert.equal(calls.filter((c) => c.purpose.startsWith('strict:security:')).length, 1);
    assert.equal(calls.filter((c) => c.purpose.startsWith('strict:adversarial:')).length, 2);
  });
  it('verifies serious findings independently and retains uncertainty at its original severity', async () => {
    const { router, calls } = mockRouter((p, o) => {
      if (p.startsWith('strict:main:')) o.findings = [finding];
      if (p.startsWith('strict:verify:')) o.verdicts[0].verdict = 'uncertain';
    });
    const result = await run(router);
    assert.equal(calls.at(-1)?.provider, 'claude');
    assert.equal(result.candidates[0].severity, 'major'); assert.equal(result.candidates[0].confidence, 'low');
    assert.equal(result.candidates[0].verification, 'uncertain');
    assert.ok(result.report.approvalBlocks.some((b) => b.includes('unresolved serious verification')));
  });
  it('treats missing or duplicate verification verdicts as incomplete', async () => {
    const { router } = mockRouter((p, o) => {
      if (p.startsWith('strict:main:')) o.findings = [finding];
      if (p.startsWith('strict:verify:')) o.verdicts = [];
    });
    const result = await run(router);
    assert.equal(result.report.complete, false); assert.equal(result.candidates[0].verification, 'skipped');
    assert.ok(result.report.stages.at(-1)?.error?.includes('exactly one'));
  });
  it('verifies a duplicate that survives after the first finding is refuted', async () => {
    const { router, calls } = mockRouter((p, o) => {
      if (p.startsWith('strict:main:') || p.startsWith('strict:security:')) o.findings = [finding];
      if (p.startsWith('strict:verify:0:')) o.verdicts[0].verdict = 'refuted';
    });
    const result = await run(router);
    assert.equal(calls.filter((c) => c.purpose.startsWith('strict:verify:')).length, 2);
    assert.equal(result.candidates[0].verification, 'refuted'); assert.equal(result.candidates[1].verification, 'confirmed');
  });
  it('requires explicit linked-issue assessment and keeps reviewer disagreement visible', async () => {
    ctx.issues = [{ repo: 'acme/api', number: 9, title: 'Requirement', body: 'Keep results', url: '', comments: [], linkedBy: 'closes' }];
    const { router } = mockRouter((p, o) => { if (p.startsWith('strict:adversarial:')) o.requirements[0].status = 'missing'; });
    const result = await run(router);
    assert.equal(result.mainOut.spec_alignment.status, 'partial');
    assert.ok(result.report.approvalBlocks.some((b) => b.includes('disagreement')));
  });
  it('splits large diffs into bounded batches and records unassigned work instead of omitting it', () => {
    cfg.update({ ...cfg.all, strict: { ...cfg.strict, maxDiffChars: 20000, maxBatches: 1 } });
    ctx.reviewFiles[0].patch = '@@ -1 +1,60 @@\n' + '+'.padEnd(1000, 'x').concat('\n').repeat(60);
    const result = makeBatches(ctx, cfg);
    assert.equal(result.batches.length, 1); assert.ok(result.sections.length > 1);
    assert.ok(result.gaps.some((g) => g.includes('unassigned')));
    assert.ok(result.batches.every((b) => b.prompt.length < cfg.strict.maxDiffChars));
  });
  it('runs synthesis across multiple batches and keeps minor findings on large PRs', async () => {
    cfg.update({ ...cfg.all, strict: { ...cfg.strict, maxDiffChars: 20000 } });
    ctx.reviewFiles[0].patch = '@@ -1 +1,18 @@\n' + '+'.padEnd(1000, 'x').concat('\n').repeat(18);
    ctx.large = true;
    const { router, calls } = mockRouter((p, o) => {
      if (p.startsWith('strict:main:')) { o.findings = [{ ...finding, severity: 'minor' }]; o.summary = 'PRIMARY_ONLY_ASSESSMENT'; }
    });
    const result = await run(router);
    assert.ok(calls.some((c) => c.purpose.startsWith('strict:synthesis:')));
    assert.ok(!calls.find((c) => c.purpose.startsWith('strict:adversarial:all-batches:'))!.prompt.includes('PRIMARY_ONLY_ASSESSMENT'));
    assert.equal(result.report.complete, true); assert.ok(result.candidates.some((c) => c.severity === 'minor'));
  });
  it('does not approve an incremental review with an incomplete or Standard baseline', async () => {
    ctx.incremental = true; ctx.evidence.diff!.sinceSha = 'c'.repeat(40);
    const { router } = mockRouter();
    const result = await run(router);
    assert.equal(result.report.complete, false); assert.ok(result.report.gaps.some((g) => g.includes('baseline')));
  });
  it('blocks approval for legacy records, current Strict settings, majors and incomplete inherited coverage', () => {
    assert.ok(strictApprovalBlocks({ ...job, review_policy: null }, [], true).some((b) => b.includes('no Strict')));
    const report = completeReport(); report.gaps = ['Earlier coverage was incomplete']; report.complete = false; report.inheritedFrom = 99;
    const incomplete = { ...job, review_report: JSON.stringify(report) };
    assert.ok(strictApprovalBlocks(incomplete, [], true).includes('Earlier coverage was incomplete'));
    const complete = { ...job, review_report: JSON.stringify(completeReport()) };
    assert.ok(strictApprovalBlocks(complete, [{ ...finding, status: 'summary', original_severity: 'major', verification: 'confirmed' } as Finding], true).some((b) => b.includes('majors')));
    assert.ok(strictApprovalBlocks({ ...complete, confidence: 'medium' }, [], true).some((b) => b.includes('high confidence')));
    assert.ok(strictApprovalBlocks({ ...complete, review_report: null }, [], true).some((b) => b.includes('missing')));
  });
  it('enforces the model-attempt budget before spawning a CLI', async () => {
    db.insertRun({ job_id: job.id, purpose: 'strict:main:old', provider: 'codex', model: null, ok: 0, fell_back: 0, duration_ms: 1, error: 'failed', turns: null, tool_calls: null, input_tokens: null, cached_input_tokens: null, output_tokens: null, cost_usd: null });
    const router = new Router(db, cfg);
    await assert.rejects(router.run(job.id, 'strict:test', { cwd: dir, workDir: dir, instructions: '', prompt: '', schema: {}, timeoutMs: 1 }, { providers: ['codex'], maxJobRuns: 1 }), /budget exhausted/);
  });
  it('requires contiguous evidence and preserves duplicate provenance in discarded records', () => {
    const candidate = { ...finding, pass: 'main', model: 'codex', model_id: 'm', original_severity: 'major', verification: 'confirmed', verified_by: 'claude', verify_reason: 'Checked a.js' } as Candidate;
    const options = { checkoutDir: dir, prFiles: ctx.prFiles, previous: [], maxNits: 5, strict: true };
    assert.equal(placeFindings([{ ...candidate, evidence: 'const limit = 0;\nnonexistent();' }], options)[0].status, 'dropped');
    assert.equal(placeFindings([{ ...candidate, evidence: 'const limit = 0' }], options)[0].status, 'dropped');
    const placed = placeFindings([candidate, { ...candidate, pass: 'adversarial', model: 'claude' }], options);
    assert.equal(placed.filter((p) => p.status !== 'dropped').length, 1);
    assert.equal(placed[1].model, 'claude'); assert.match(placed[1].drop_reason!, /duplicate/);
  });
});
