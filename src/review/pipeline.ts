import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SettingsStore } from '../settings.ts';
import type { Db } from '../db.ts';
import type { Checkout, RepoCache } from '../git/mirror.ts';
import type { GitHub } from '../github/client.ts';
import { addLabel, removeLabel } from '../github/labels.ts';
import { getPr } from '../github/prs.ts';
import { PendingReviewExists, postReview, type InlineComment } from '../github/publish.ts';
import { NoProviderAvailable, type Router } from '../llm/router.ts';
import type { Finding, Job, PostPreview, Provider, ReviewMode } from '../types.ts';
import { buildContext, type ReviewContext } from './context.ts';
import { inlineBody, summaryBody } from './format.ts';
import { mainInstructions, securityInstructions, verifyInstructions } from './prompts.ts';
import { ReviewOut, reviewSchema, VerifyOut, verifySchema } from './schema.ts';
import { lowerSeverity, minSeverity, placeFindings, type Candidate } from './validate.ts';

// The job no longer needs doing: PR closed, or new commits replaced it.
export class JobObsolete extends Error {}

// Posting a dry-run review isn't possible right now; the message says why.
export class PostRefused extends Error {}



export class ReviewPipeline {
  private readonly gh: GitHub;
  private readonly cfg: SettingsStore;
  private readonly db: Db;
  private readonly router: Router;
  private readonly cache: RepoCache;

  constructor(gh: GitHub, cfg: SettingsStore, db: Db, router: Router, cache: RepoCache) {
    this.gh = gh;
    this.cfg = cfg;
    this.db = db;
    this.router = router;
    this.cache = cache;
  }

  private step(job: Job, step: string, progress: number) {
    this.db.updateJob(job.id, { step, progress });
    this.db.event(job.id, step);
  }

  async run(job: Job, signal: AbortSignal): Promise<void> {
    if (!this.cfg.isRepoAllowed(job.repo)) throw new JobObsolete('repo is no longer in your repos list');
    const pr = await getPr(this.gh, job.repo, job.pr_number);
    if (pr.state !== 'open') throw new JobObsolete('PR is no longer open');
    if (pr.headSha !== job.head_sha) throw new JobObsolete(`superseded by new commits (${pr.headSha.slice(0, 7)})`);
    this.db.updateJob(job.id, { pr_title: pr.title, additions: pr.additions, deletions: pr.deletions, changed_files: pr.changedFiles });

    // A retry after "pending review exists" only needs to post what was already prepared.
    if (job.review_body && !job.review_id && !job.dry_run) {
      await this.publish(job, this.db.findings(job.id));
      return;
    }

    await this.labelStart(job);

    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `auto-reviewer-work-${job.id}-`));
    let checkout: Checkout | null = null;
    try {
      const firstTime = !(await this.cache.exists(job.repo));
      this.step(job, firstTime ? 'Downloading a local copy of the repo (first review only)' : 'Fetching new commits', 6);
      await this.cache.fetchPr(job.repo, job.pr_number, job.head_sha, pr.baseRef, pr.baseSha);
      if (signal.aborted) throw signal.reason;
      this.step(job, 'Checking out the PR', 12);
      checkout = await this.cache.worktree(job.repo, job.head_sha, this.cfg.keepCheckouts);
      if (signal.aborted) throw signal.reason;

      this.step(job, 'Reading the PR, linked issues and guidelines', 18);
      const previous = this.previousFindings(job);
      const ctx = await buildContext(this.gh, this.cfg, pr, job.since_sha, previous, this.cache);
      this.db.event(
        job.id,
        `${ctx.incremental ? 'Follow-up review of new commits' : 'Full review'}: ${ctx.reviewFiles.length} files, ` +
          `${ctx.changedLines} changed lines, ${ctx.issues.length} linked issue(s)${ctx.large ? ', large-PR mode' : ''}`,
      );

      const task = { cwd: checkout.dir, workDir, timeoutMs: this.cfg.limits.passTimeoutSec * 1000, signal };
      this.step(job, 'Reviewing: code and requirements, security', 25);
      let done = 0;
      const progress = () => this.db.updateJob(job.id, { progress: 25 + ++done * 22 });
      const [main, security] = await Promise.all([
        this.router
          .run(job.id, 'main', {
            ...task,
            instructions: mainInstructions(ctx.me, this.cfg.limits.maxNits),
            prompt: ctx.prompt,
            schema: reviewSchema,
          })
          .finally(progress),
        this.router
          .run(job.id, 'security', {
            ...task,
            instructions: securityInstructions(ctx.me),
            prompt: ctx.prompt,
            schema: reviewSchema,
          })
          .finally(progress),
      ]);
      const mainOut = parseReview(main.output, 'main');
      const secOut = parseReview(security.output, 'security');
      const label = (r: { provider: string; model: string | null }) => `${r.provider} ${r.model ?? '(default model)'}`;
      this.db.event(job.id, `Main pass (${label(main)}): ${mainOut.findings.length} finding(s). Security pass (${label(security)}): ${secOut.findings.length} finding(s).`);

      let candidates: Candidate[] = [
        ...mainOut.findings.map((f) => toCandidate(f, 'main', main.provider, main.model)),
        ...secOut.findings.map((f) => toCandidate(f, 'security', security.provider, security.model)),
      ];

      const placeOpts = { checkoutDir: checkout.dir, prFiles: ctx.prFiles, previous, maxNits: this.cfg.limits.maxNits };
      if (this.cfg.models.doubleCheck && candidates.some((c) => c.severity === 'blocker' || c.severity === 'major')) {
        this.step(job, 'Double-checking blockers and majors', 72);
        candidates = await this.verify(job, ctx, candidates, placeOpts, task);
      }

      this.step(job, 'Checking findings against the code', 88);
      const placed = placeFindings(candidates, placeOpts);
      const inserted = placed.map((p) =>
        this.db.insertFinding({
          job_id: job.id,
          pass: p.pass,
          model: p.model,
          model_id: p.model_id,
          category: p.category,
          severity: p.severity,
          original_severity: p.original_severity,
          confidence: p.confidence,
          file: p.file,
          line: p.line,
          title: p.title,
          evidence: p.evidence,
          problem: p.problem,
          suggestion: p.suggestion,
          verification: p.verification,
          verified_by: p.verified_by,
          verify_reason: p.verify_reason,
          status: p.status,
          drop_reason: p.drop_reason,
          comment_id: null,
          outcome: null,
        }),
      );
      const dropped = inserted.filter((f) => f.status === 'dropped');
      if (dropped.length) this.db.event(job.id, `Discarded ${dropped.length} finding(s): ${[...new Set(dropped.map((f) => f.drop_reason?.split(':')[0]))].join('; ')}`);
      if (placed.some((p) => p.drop_reason?.includes('exfiltration'))) {
        this.db.event(job.id, 'A model tried to output a credential that is not in the PR. That finding was discarded; check the PR for prompt injection.', 'warn');
      }

      const resolvedIds = new Set([...mainOut.resolved_previous_ids, ...secOut.resolved_previous_ids]);
      const resolved = previous.filter((f) => resolvedIds.has(f.id));
      for (const f of resolved) this.db.updateFinding(f.id, { resolved_by_job: job.id });

      const posted = inserted.filter((f) => f.status !== 'dropped');
      const body = summaryBody({
        headSha: job.head_sha,
        sinceSha: ctx.incremental ? job.since_sha : null,
        summaries: [mainOut.summary, secOut.summary],
        specStatus: mainOut.spec_alignment.status,
        specNotes: mainOut.spec_alignment.notes,
        issues: ctx.issues,
        findings: posted,
        questions: [...mainOut.questions_for_author, ...secOut.questions_for_author].slice(0, 4),
        resolved,
        large: ctx.large,
        excluded: ctx.excluded,
        inlineFailed: false,
        jobId: job.id,
      });
      job = this.db.updateJob(job.id, { review_body: body, spec_status: mainOut.spec_alignment.status });

      if (signal.aborted) throw signal.reason;
      await this.publish(job, inserted);
    } finally {
      await checkout?.cleanup();
      await fs.rm(workDir, { recursive: true, force: true });
    }
  }

  // Findings raised in earlier reviews of this PR that haven't been marked fixed.
  private previousFindings(job: Job): Finding[] {
    return this.db.all<Finding>(
      `SELECT f.* FROM findings f JOIN jobs j ON j.id = f.job_id
       WHERE j.repo = ? AND j.pr_number = ? AND j.id != ? AND j.state = 'done' AND j.dry_run = ?
         AND f.status != 'dropped' AND f.resolved_by_job IS NULL AND COALESCE(f.outcome, '') != 'deleted'`,
      job.repo, job.pr_number, job.id, job.dry_run,
    );
  }

  private async verify(
    job: Job,
    ctx: ReviewContext,
    candidates: Candidate[],
    placeOpts: Parameters<typeof placeFindings>[1],
    task: { cwd: string; workDir: string; timeoutMs: number; signal: AbortSignal },
  ): Promise<Candidate[]> {
    // Only findings that survive the cheap checks are worth a second model's time.
    const pre = placeFindings(candidates, placeOpts);
    const toVerify = candidates
      .map((c, i) => ({ c, i }))
      .filter(({ c, i }) => pre[i].status !== 'dropped' && (c.severity === 'blocker' || c.severity === 'major'));
    if (!toVerify.length) return candidates;

    // A separate run with fresh context, on the same provider order as the review itself.
    const out = candidates.map((c) => ({ ...c }));
    const list = toVerify
      .map(({ c, i }) =>
        [`### Finding id ${i}`, `${c.severity} · ${c.category} · ${c.file}${c.line ? `:${c.line}` : ''}`, `Title: ${c.title}`, `Problem: ${c.problem}`, `Evidence:\n${c.evidence}`].join('\n'),
      )
      .join('\n\n');
    try {
      const res = await this.router.run(job.id, 'verify', {
        ...task,
        instructions: verifyInstructions(),
        prompt: `${ctx.prompt}\n\n## Findings to check\n\n${list}`,
        schema: verifySchema,
      });
      const parsed = VerifyOut.safeParse(res.output);
      if (!parsed.success) throw new Error('the double-check returned an unexpected shape');
      const byId = new Map(parsed.data.verdicts.map((v) => [v.id, v]));
      for (const { i } of toVerify) {
        const v = byId.get(i);
        const c = out[i];
        c.verified_by = res.provider;
        if (!v) {
          c.verification = 'skipped';
          continue;
        }
        c.verify_reason = v.reason;
        c.verification = v.verdict;
        if (v.verdict === 'confirmed') c.severity = minSeverity(c.severity, v.adjusted_severity);
        if (v.verdict === 'uncertain') {
          c.severity = lowerSeverity(c.severity);
          c.confidence = 'low';
        }
      }
      const refuted = toVerify.filter(({ i }) => out[i].verification === 'refuted').length;
      this.db.event(job.id, `${res.provider} ${res.model ?? ''} double-checked ${toVerify.length} finding(s): ${refuted} refuted`);
    } catch (err) {
      if (task.signal.aborted) throw err;
      for (const { i } of toVerify) out[i].verification = 'skipped';
      const why = err instanceof NoProviderAvailable ? 'no model available' : err instanceof Error ? err.message : String(err);
      this.db.event(job.id, `Couldn't double-check the findings (${why}); posting them unverified`, 'warn');
    }
    return out;
  }

  private async publish(job: Job, findings: Finding[]) {
    if (job.dry_run) {
      const inline = findings.filter((f) => f.status === 'inline' && f.line !== null).length;
      this.step(job, `Dry run: not posted. Ready to post a ${job.mode} review with ${inline} inline comment(s)`, 100);
      this.db.setState(job.id, 'done', { review_state: 'DRY_RUN', progress: 100 });
      return;
    }

    // Last check before speaking for you: don't post on a commit that's already outdated.
    const pr = await getPr(this.gh, job.repo, job.pr_number);
    if (pr.headSha !== job.head_sha) throw new JobObsolete(`superseded by new commits (${pr.headSha.slice(0, 7)})`);
    await this.post(job, findings, job.mode);
  }

  // Sends a prepared review to GitHub on the reviewed commit, as a pending draft or a
  // published comment review, and sets the labels.
  private async post(job: Job, findings: Finding[], mode: ReviewMode) {
    const posted = findings.filter((f) => f.status !== 'dropped');
    const hasBlocker = posted.some((f) => f.severity === 'blocker');
    const inline: InlineComment[] = posted
      .filter((f) => f.status === 'inline' && f.line !== null)
      .map((f) => ({ findingId: f.id, path: f.file, line: f.line!, body: inlineBody(f) }));

    this.step(job, mode === 'draft' ? 'Posting draft review (only you can see it)' : 'Posting review comment', 95);
    const res = await postReview(this.gh, job.repo, job.pr_number, job.head_sha, mode, job.review_body ?? '', inline);
    if (res.droppedInline) {
      this.db.event(job.id, 'GitHub rejected an inline comment position, so every finding went into the review body instead', 'warn');
      for (const f of inline) this.db.updateFinding(f.findingId, { status: 'summary' });
    }
    for (const [findingId, commentId] of res.commentIds) this.db.updateFinding(findingId, { comment_id: commentId });
    for (const f of posted) this.db.updateFinding(f.id, { outcome: mode === 'draft' ? 'pending' : 'published' });

    const labelOk = await this.labelFinish({ ...job, mode }, hasBlocker);
    this.db.setState(job.id, 'done', {
      mode,
      dry_run: 0, // from here on it's a real review: follow-ups build on it and kept comments are tracked
      review_id: res.id,
      review_url: res.url,
      review_state: res.state,
      label_ok: labelOk ? 1 : 0,
      progress: 100,
      step: mode === 'draft' ? 'Draft review ready for you on GitHub' : 'Review posted',
    });
    this.db.event(job.id, `Review ${res.state.toLowerCase()} with ${res.commentIds.size} inline comment(s): ${res.url}`);
  }

  // ---- posting a dry-run review from the dashboard

  private readonly posting = new Set<number>();

  private postable(id: number): Job {
    const job = this.db.job(id);
    if (!job) throw new PostRefused('Review not found');
    if (!job.dry_run || job.review_id) throw new PostRefused('This review is already on GitHub');
    if (job.state !== 'done' || job.review_state !== 'DRY_RUN') throw new PostRefused('Only finished dry-run reviews can be posted');
    if (!this.cfg.isRepoAllowed(job.repo)) throw new PostRefused('This repo is no longer in your repos list');
    if (this.posting.has(id)) throw new PostRefused('Already posting this review');
    return job;
  }

  // What posting would do, checked against the PR as it is now.
  async previewPost(id: number): Promise<PostPreview> {
    const job = this.postable(id);
    const pr = await getPr(this.gh, job.repo, job.pr_number);
    if (pr.state !== 'open') throw new PostRefused('This PR is no longer open');
    const findings = this.db.findings(id).filter((f) => f.status !== 'dropped');
    return {
      inline: findings.filter((f) => f.status === 'inline' && f.line !== null).length,
      inSummary: findings.filter((f) => f.status === 'summary' || (f.status === 'inline' && f.line === null)).length,
      reviewedSha: job.head_sha,
      currentSha: pr.headSha,
      defaultMode: this.cfg.modeFor(job.repo),
      doneLabel: this.cfg.labelName('done'),
      blockerLabel: findings.some((f) => f.severity === 'blocker') ? this.cfg.labelName('blocker') : null,
      blockerLabelInDraft: this.cfg.labels.blockerLabelInDraft,
    };
  }

  async postDryRun(id: number, mode: ReviewMode): Promise<Job> {
    const job = this.postable(id);
    this.posting.add(id);
    try {
      const pr = await getPr(this.gh, job.repo, job.pr_number);
      if (pr.state !== 'open') throw new PostRefused('This PR is no longer open');
      this.db.event(id, `Posting to GitHub from the dashboard as a ${mode === 'draft' ? 'draft' : 'published review'}`);
      if (pr.headSha !== job.head_sha) {
        this.db.event(
          id,
          `The PR moved on to ${pr.headSha.slice(0, 7)}; comments go on the reviewed commit ${job.head_sha.slice(0, 7)} and may show as outdated`,
          'warn',
        );
      }
      await this.post(job, this.db.findings(id), mode);
      return this.db.job(id)!;
    } catch (err) {
      // Put the review back as it was, ready to try again.
      this.db.updateJob(id, { step: 'Dry run: not posted', progress: 100 });
      if (err instanceof PendingReviewExists) {
        throw new PostRefused('You already have an unsubmitted review on this PR. Submit or discard it on GitHub, then try again.');
      }
      if (!(err instanceof PostRefused)) this.db.event(id, `Posting failed: ${err instanceof Error ? err.message : err}`, 'error');
      throw err;
    } finally {
      this.posting.delete(id);
    }
  }

  private async labelStart(job: Job) {
    if (job.dry_run) return;
    const ok = await addLabel(this.gh, job.repo, job.pr_number, this.cfg.labelName('running'));
    if (!ok) this.db.event(job.id, 'Can\'t set labels on this repo (needs triage access); the review body carries a marker instead', 'warn');
    await removeLabel(this.gh, job.repo, job.pr_number, this.cfg.labelName('failed'));
  }

  private async labelFinish(job: Job, hasBlocker: boolean): Promise<boolean> {
    const { repo, pr_number: n } = job;
    await removeLabel(this.gh, repo, n, this.cfg.labelName('running'));
    const ok = await addLabel(this.gh, repo, n, this.cfg.labelName('done'));
    const showBlocker = hasBlocker && (job.mode === 'publish' || this.cfg.labels.blockerLabelInDraft);
    if (showBlocker) await addLabel(this.gh, repo, n, this.cfg.labelName('blocker'));
    else await removeLabel(this.gh, repo, n, this.cfg.labelName('blocker'));
    return ok;
  }

  async labelFailed(job: Job) {
    if (job.dry_run) return;
    await removeLabel(this.gh, job.repo, job.pr_number, this.cfg.labelName('running'));
    await addLabel(this.gh, job.repo, job.pr_number, this.cfg.labelName('failed'));
  }

  async labelCancelled(job: Job) {
    if (job.dry_run) return;
    await removeLabel(this.gh, job.repo, job.pr_number, this.cfg.labelName('running'));
  }
}

function parseReview(output: unknown, pass: string): ReviewOut {
  const parsed = ReviewOut.safeParse(output);
  if (!parsed.success) throw new Error(`${pass} pass returned an unexpected shape: ${parsed.error.issues[0]?.message ?? ''}`);
  return parsed.data;
}

function toCandidate(f: ReviewOut['findings'][number], pass: 'main' | 'security', model: Provider, modelId: string | null): Candidate {
  return {
    ...f,
    category: pass === 'security' ? 'security' : f.category,
    pass,
    model,
    model_id: modelId,
    original_severity: f.severity,
    verification: 'not_needed',
    verified_by: null,
    verify_reason: null,
  };
}
