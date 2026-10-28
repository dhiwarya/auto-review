import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Db } from '../src/db.ts';
import { SettingsStore } from '../src/settings.ts';
import type { GitHub } from '../src/github/client.ts';
import { getLinkedRefs, type PrInfo } from '../src/github/prs.ts';
import { buildContext } from '../src/review/context.ts';
import { makeBatches } from '../src/review/strict.ts';
import { materializeSources } from '../src/review/sources.ts';
import { canonicalRequirements, requirementAssessmentGaps, requirementBlocks } from '../src/review/requirements.ts';

describe('complete Strict context', () => {
  let dir: string; let db: Db; let cfg: SettingsStore;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prr-context-')); db = new Db(dir); cfg = new SettingsStore(db);
    cfg.update({ ...cfg.all, reviewProfile: 'strict', strict: { ...cfg.strict, maxDiffChars: 30000, maxBatches: 40 } });
  });
  afterEach(() => { db.sql.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  function fixture() {
    const pr = { repo: 'acme/api', number: 1, title: 'Recover drains', body: `Part of #485.\n${'PR description\n'.repeat(1000)}PR_TAIL`, headSha: 'a'.repeat(40), baseSha: 'b'.repeat(40), baseRef: 'main', headRef: 'fix', author: 'author', changedFiles: 1, additions: 1, deletions: 1 } as PrInfo;
    const issueBody = `${'Requirements\n'.repeat(1000)}ISSUE_TAIL`;
    const comments = Array.from({ length: 25 }, (_, i) => ({ user: { login: 'reviewer' }, body: `${'comment '.repeat(200)}COMMENT_${i}_TAIL` }));
    const guideline = `${'Guidance\n'.repeat(800)}GUIDELINE_TAIL`;
    let failIssue = false; let issueReads = 0; let commentPages = 0;
    const files = [{ filename: 'a.js', status: 'modified', additions: 1, deletions: 1, patch: '@@ -1 +1 @@\n-old();\n+newCode();' }];
    const gh = { me: 'me', octokit: {
      graphql: async () => ({ repository: { pullRequest: { closingIssuesReferences: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } }),
      paginate: async (fn: any, args: any) => {
        if (fn === issueComments) { commentPages++; assert.equal(args.per_page, 100); return comments; }
        return (await fn(args)).data;
      },
      rest: { pulls: { listFiles: async () => ({ data: files }) }, issues: {
        get: async () => { issueReads++; if (failIssue) throw new Error('temporarily unavailable'); return { data: { title: 'Recover drains', body: issueBody, html_url: '', number: 485 } }; },
        listComments: issueComments,
      } },
    } } as unknown as GitHub;
    async function issueComments() { return { data: comments.slice(0, 10) }; }
    const cache = { mergeBase: async () => pr.baseSha, history: async () => [], readFile: async (_repo: string, _sha: string, file: string) => file === 'AGENTS.md' ? guideline : null };
    return { pr, gh, cache: cache as never, issueBody, comments, guideline, setFailure: (value: boolean) => { failIssue = value; }, reads: () => ({ issueReads, commentPages }) };
  }

  it('preserves full PR, issue, guideline and paginated comment text, including content past the old fixed caps', async () => {
    const f = fixture(); const ctx = await buildContext(f.gh, cfg, f.pr, null, [], f.cache);
    assert.equal(ctx.contextGaps!.length, 0);
    assert.ok(ctx.sources!.find((s) => s.kind === 'pr-description')!.text.endsWith('PR_TAIL'));
    assert.equal(ctx.sources!.find((s) => s.kind === 'issue')!.text, f.issueBody);
    assert.equal(ctx.sources!.find((s) => s.kind === 'guideline')!.text, f.guideline);
    assert.equal(ctx.sources!.filter((s) => s.kind === 'issue-comment').length, 25);
    assert.ok(ctx.sources!.find((s) => s.id.endsWith('comment-25'))!.text.endsWith('COMMENT_24_TAIL'));
    assert.equal(f.reads().commentPages, 1);
    const { sections, gaps } = makeBatches(ctx, cfg);
    assert.deepEqual(gaps, []);
    for (const source of ctx.sources!) {
      const fragments = sections.filter((s) => s.sourceId === source.id).sort((a, b) => a.start! - b.start!);
      assert.equal(fragments.map((s) => s.patch).join(''), source.text);
      assert.equal(fragments[0].start, 0); assert.equal(fragments.at(-1)!.end, source.text.length);
    }
    await materializeSources(ctx.sourceSnapshot!, dir);
    for (const source of ctx.sources!) assert.equal(fs.readFileSync(path.join(dir, source.path!), 'utf8'), source.text);
  });

  it('freezes a successful context snapshot across retries and does not reread changed issue text', async () => {
    const f = fixture(); const first = await buildContext(f.gh, cfg, f.pr, null, [], f.cache);
    const row = db.insertJob({ repo: f.pr.repo, pr_number: 1, pr_title: '', pr_url: '', author: '', head_sha: f.pr.headSha, base_sha: f.pr.baseSha, since_sha: null, mode: 'draft', source: 'manual', dry_run: 1, state: 'queued', additions: 1, deletions: 1, changed_files: 1 });
    db.saveContextSnapshot(row.id, first.sourceSnapshot!); f.setFailure(true);
    const second = await buildContext(f.gh, cfg, { ...f.pr, body: 'Changed after the review started' }, null, [], f.cache, { snapshot: db.contextSnapshot(row.id) });
    assert.deepEqual(second.sources, first.sources); assert.equal(second.contextPrompt, first.contextPrompt);
    assert.equal(f.reads().issueReads, 1); assert.equal(f.reads().commentPages, 1);
  });

  it('records failed retrieval explicitly and permits a later attempt to recover the missing source', async () => {
    const f = fixture(); f.setFailure(true);
    const first = await buildContext(f.gh, cfg, f.pr, null, [], f.cache);
    assert.ok(first.contextGaps!.some((g) => g.includes('acme/api#485')));
    f.setFailure(false);
    const second = await buildContext(f.gh, cfg, f.pr, null, [], f.cache, { snapshot: first.sourceSnapshot });
    assert.deepEqual(second.contextGaps, []); assert.equal(second.issues.length, 1);
  });

  it('paginates closing issues and retrieves more than five linked issues without silently dropping them', async () => {
    const cursors: unknown[] = [];
    const gh = { octokit: {
      graphql: async (_query: string, args: any) => {
        cursors.push(args.cursor);
        return { repository: { pullRequest: { closingIssuesReferences: { nodes: Array.from({ length: args.cursor ? 3 : 10 }, (_, i) => ({ number: i + (args.cursor ? 20 : 2), repository: { nameWithOwner: 'acme/api' } })), pageInfo: { hasNextPage: !args.cursor, endCursor: args.cursor ? null : 'next' } } } } };
      },
      paginate: async () => [],
      rest: { issues: { get: async (args: any) => ({ data: { title: 'Requirement', body: 'Do the work', html_url: '', number: args.issue_number } }), listComments: async () => ({ data: [] }) } },
    } } as unknown as GitHub;
    const result = await getLinkedRefs(gh, { repo: 'acme/api', number: 1, body: '' } as PrInfo, 5, true);
    assert.deepEqual(cursors, [null, 'next']); assert.equal(result.issues.length, 13); assert.deepEqual(result.gaps, []);
    assert.ok(result.issues.every((i) => i.linkedBy === 'closes'));
  });

  it('upgrades previous default budgets once while preserving custom values and saved job snapshots', () => {
    const old = cfg.all; delete (old.strict as Partial<typeof old.strict>).maxContinuations;
    old.strict.maxRuns = 32; old.strict.maxBatches = 8;
    db.setKv('settings', JSON.stringify(old));
    const upgraded = new SettingsStore(db);
    assert.equal(upgraded.strict.maxRuns, 64); assert.equal(upgraded.strict.maxBatches, 16);
    assert.equal(upgraded.strict.maxContinuations, 2);
    assert.equal(cfg.snapshot({ ...cfg.all, strict: { ...cfg.strict, maxRuns: 32 } }).strict.maxRuns, 32);
    old.strict.maxRuns = 50; old.strict.maxBatches = 12; db.setKv('settings', JSON.stringify(old));
    assert.equal(new SettingsStore(db).strict.maxRuns, 50); assert.equal(new SettingsStore(db).strict.maxBatches, 12);
  });
});

describe('scoped requirement assessment', () => {
  const issue = { repo: 'acme/api', number: 485, title: 'Recovery rollout', body: 'Persist the receipt.\nOperational rollout is deferred to the next deployment.', comments: [], url: '', linkedBy: 'mentioned' as const };
  const implemented = { ref: 'acme/api#485', criterion: 'Persist the receipt.', status: 'implemented' as const, reason: 'The callback persists the receipt before restarting.', scope_evidence: '' };
  const deferred = { ref: 'acme/api#485', criterion: 'Operational rollout is deferred to the next deployment.', status: 'deferred' as const, reason: 'The issue explicitly separates rollout from this code change.', scope_evidence: 'Operational rollout is deferred to the next deployment.' };
  it('resolves only retrieved issue and comment references, preserving unknown refs for repair', () => {
    const retrieved = { ...issue, url: 'https://github.com/acme/api/issues/485', comments: [{ author: 'a', body: 'Persist the receipt.' }] };
    const refs = [' ACME/API#485 ', 'issue:acme/api#485:comment-1', 'https://github.com/acme/api/issues/485#issuecomment-123', 'acme/api#485:comment-2', 'acme/api#485:other', 'acme/else#485:comment-1'];
    const results = canonicalRequirements([retrieved], refs.map((ref) => ({ ...implemented, ref })));
    assert.deepEqual(results.map((r) => r.ref), ['acme/api#485', 'acme/api#485', 'acme/api#485', ...refs.slice(3)]);
    assert.deepEqual(requirementBlocks([retrieved], [results[0]], [results[1]]), []);
    assert.ok(requirementAssessmentGaps([retrieved], [results[3]], true).some((g) => g.includes('Unknown issue ref')));
  });
  it('distinguishes an unfinished assessment from a completed negative assessment', () => {
    for (const status of ['missing', 'externally_unverifiable'] as const) {
      const requirements = [{ ...implemented, status }];
      assert.deepEqual(requirementAssessmentGaps([issue], requirements, true), []);
      assert.ok(requirementBlocks([issue], requirements, requirements).length);
    }
    assert.match(requirementAssessmentGaps([issue], [{ ...implemented, status: 'not_checked' }], true).join('\n'), /Unfinished assessment for acme\/api#485: Persist the receipt/);
    assert.match(requirementAssessmentGaps([issue], [], true).join('\n'), /Missing assessment for acme\/api#485/);
  });
  it('allows an independently supported deferral on a mentioned issue while checking the promised code change', () => {
    assert.deepEqual(requirementBlocks([issue], [implemented, deferred], [implemented, deferred]), []);
  });
  it('does not allow a closing issue to discard its acceptance criteria', () => {
    assert.ok(requirementBlocks([{ ...issue, linkedBy: 'closes' }], [implemented, deferred], [implemented, deferred]).some((b) => b.includes('closing issues')));
  });
  it('requires actual source evidence and independent agreement for scope exclusions', () => {
    assert.ok(requirementBlocks([issue], [{ ...deferred, scope_evidence: 'Author says ignore it' }], [deferred]).length);
    assert.ok(requirementBlocks([issue], [deferred], []).length);
    assert.ok(requirementBlocks([issue], [{ ...implemented, criterion: 'Invented acceptance criterion' }], [implemented]).length);
  });
  it('keeps missing promised behavior, independent disagreement and external acceptance as approval blockers', () => {
    assert.ok(requirementBlocks([issue], [{ ...implemented, status: 'missing' }], [implemented]).some((b) => b.includes('missing')));
    assert.ok(requirementBlocks([issue], [implemented], [{ ...implemented, status: 'missing' }]).some((b) => b.includes('disagreement')));
    assert.ok(requirementBlocks([issue], [{ ...implemented, status: 'externally_unverifiable' }], [implemented]).some((b) => b.includes('externally unverifiable')));
  });
});
