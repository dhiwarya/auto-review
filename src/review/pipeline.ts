import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SettingsStore } from '../settings.ts';
import type { Db } from '../db.ts';
import type { Checkout, RepoCache } from '../git/mirror.ts';
import type { GitHub } from '../github/client.ts';
import { removeLabel, showLabel } from '../github/labels.ts';
import { getPr, type PrInfo } from '../github/prs.ts';
import { myVerdict, PendingReviewExists, postReview, type InlineComment, type ReviewEvent } from '../github/publish.ts';
import { NoProviderAvailable, type Router } from '../llm/router.ts';
import { containsSecret, ownSecrets } from '../secrets.ts';
import type { Finding, Job, PostPreview, Provider, ReviewMode } from '../types.ts';
import { assess, atLeast, openBlockers } from './confidence.ts';
import { buildContext, type ReviewContext } from './context.ts';
import { inlineBody, summaryBody } from './format.ts';
import { mainInstructions, securityInstructions, verifyInstructions } from './prompts.ts';
import { ReviewOut, reviewSchema, VerifyOut, verifySchema } from './schema.ts';
import { addedTextOf, lowerSeverity, minSeverity, placeFindings, scrubText, type Candidate } from './validate.ts';

// The job no longer needs doing: PR closed, or new commits replaced it.
export class JobObsolete extends Error {}

// Posting a dry-run review isn't possible right now; the message says why.
export class PostRefused extends Error {}

// The review contains one of the app's own credentials. Never retried.
export class UnsafeToPost extends Error {}

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

    await this.labelStart(job, pr);

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
      // Free text is posted as written, so it gets the same secret check as the findings.
      const addedText = addedTextOf(ctx.prFiles);
      let smuggled = false;
      const clean = (text: string) => {
        const scrubbed = scrubText(text, addedText);
        smuggled ||= scrubbed.smuggled;
        return scrubbed.text;
      };
      const summaries = [clean(mainOut.summary), clean(secOut.summary)];
      const questions = [...mainOut.questions_for_author, ...secOut.questions_for_author].slice(0, 4).map(clean);
      const passes = [mainOut.review_confidence, secOut.review_confidence].map((p) => ({ level: p.level, reason: clean(p.reason) }));
      const specNotes = clean(mainOut.spec_alignment.notes);
      if (smuggled) {
        this.db.event(job.id, 'A model put a credential that is not in the PR into its summary or questions. It was redacted; check the PR for prompt injection.', 'warn');
      }
      const body = summaryBody({
        repo: job.repo,
        headSha: job.head_sha,
        summaries,
        specStatus: mainOut.spec_alignment.status,
        specNotes,
        issues: ctx.issues,
        findings: posted,
        questions,
        resolved,
        large: ctx.large,
        excluded: ctx.excluded,
        inlineFailed: false,
        jobId: job.id,
      });
      const assessment = assess({
        findings: posted,
        openEarlier: previous.filter((f) => !resolvedIds.has(f.id)),
        specStatus: mainOut.spec_alignment.status,
        questions: questions.length,
        large: ctx.large,
        truncated: ctx.truncated,
        injection: smuggled || placed.some((p) => p.drop_reason?.includes('exfiltration')),
        passes,
      });
      this.db.event(job.id, `Confidence ${assessment.level}${assessment.reasons.length ? `: ${assessment.reasons.join('; ')}` : ''}`);
      job = this.db.updateJob(job.id, {
        review_body: body,
        spec_status: mainOut.spec_alignment.status,
        confidence: assessment.level,
        confidence_notes: assessment.reasons.join('\n') || null,
      });

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
    await this.post(job, findings, job.mode, pr);
  }

  // Why this review shouldn't approve the PR, or null when it should. Checked again right
  // before posting, against the PR as it is then.
  private async whyNotApprove(job: Job, pr: PrInfo, posted: Finding[]): Promise<string | null> {
    const { enabled, minConfidence } = this.cfg.approval;
    if (!enabled) return 'Approving is turned off in Settings';
    const blockers = openBlockers([...posted, ...this.previousFindings(job)]);
    if (blockers) return `${blockers} blocker${blockers === 1 ? '' : 's'} still open`;
    if (!job.confidence) return 'This review has no confidence level (it was made before approvals existed)';
    if (!atLeast(job.confidence, minConfidence)) return `Confidence is ${job.confidence}; approving needs ${minConfidence}`;
    if (pr.draft) return 'The PR is still a draft';
    if (pr.author.toLowerCase() === this.gh.me.toLowerCase()) return "GitHub doesn't let you approve your own PR";
    if (pr.headSha !== job.head_sha) return 'The PR has new commits since this review';
    if ((await myVerdict(this.gh, job.repo, job.pr_number)) === 'CHANGES_REQUESTED') return 'You requested changes on this PR yourself';
    return null;
  }

  // Sends a prepared review to GitHub on the reviewed commit and sets the label. Drafts are
  // pending reviews only you can see; published reviews approve the PR when nothing stands
  // in the way, and comment otherwise.
  private async post(job: Job, findings: Finding[], mode: ReviewMode, pr: PrInfo) {
    const posted = findings.filter((f) => f.status !== 'dropped');
    const inline: InlineComment[] = posted
      .filter((f) => f.status === 'inline' && f.line !== null)
      .map((f) => ({ findingId: f.id, path: f.file, line: f.line!, body: inlineBody(f) }));
    // The last check before anything leaves: none of the app's own credentials, in any form.
    if (containsSecret([job.review_body ?? '', ...inline.map((c) => c.body)], ownSecrets([this.gh.token]))) {
      throw new UnsafeToPost("The review contains one of the app's own credentials, so nothing was posted. Check the PR for prompt injection.");
    }
    const approveNote = await this.whyNotApprove(job, pr, posted);
    const approve = mode === 'publish' && approveNote === null;
    const event: ReviewEvent = mode === 'draft' ? null : approve ? 'APPROVE' : 'COMMENT';

    this.step(job, mode === 'draft' ? 'Posting draft review (only you can see it)' : approve ? 'Approving the PR' : 'Posting review comment', 95);
    const res = await postReview(this.gh, job.repo, job.pr_number, job.head_sha, event, job.review_body ?? '', inline);
    if (res.droppedInline) {
      this.db.event(job.id, 'GitHub rejected an inline comment position, so every finding went into the review body instead', 'warn');
      for (const f of inline) this.db.updateFinding(f.findingId, { status: 'summary' });
    } else {
      for (const c of inline) this.db.updateFinding(c.findingId, { posted_body: c.body });
    }
    for (const [findingId, commentId] of res.commentIds) this.db.updateFinding(findingId, { comment_id: commentId });
    for (const f of posted) this.db.updateFinding(f.id, { outcome: mode === 'draft' ? 'pending' : 'published' });

    const label = mode === 'draft' ? 'reviewing' : approve ? 'approved' : 'feedback';
    const labelOk = await showLabel(this.gh, job.repo, job.pr_number, this.cfg.labels, label, pr.labels);
    this.db.setState(job.id, 'done', {
      mode,
      dry_run: 0, // from here on it's a real review: follow-ups build on it and kept comments are tracked
      review_id: res.id,
      review_url: res.url,
      review_state: res.state,
      approve_note: approveNote,
      label_ok: labelOk ? 1 : 0,
      progress: 100,
      step: mode === 'draft' ? 'Draft review ready for you on GitHub' : approve ? 'Approved' : 'Review posted',
    });
    this.db.event(job.id, `Review ${res.state.toLowerCase()} with ${res.commentIds.size} inline comment(s): ${res.url}`);
    if (approve) this.db.event(job.id, `Approved the PR for you (confidence ${job.confidence})`);
    else if (mode === 'publish') this.db.event(job.id, `Not approved: ${approveNote}`);
    else if (approveNote === null) this.db.event(job.id, 'No blockers and confidence is high enough: submit the draft as an approval if you agree');
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
    const approveNote = await this.whyNotApprove(job, pr, findings);
    return {
      inline: findings.filter((f) => f.status === 'inline' && f.line !== null).length,
      inSummary: findings.filter((f) => f.status === 'summary' || (f.status === 'inline' && f.line === null)).length,
      reviewedSha: job.head_sha,
      currentSha: pr.headSha,
      defaultMode: this.cfg.modeFor(job.repo),
      approveNote,
      labels: { draft: this.cfg.labels.reviewing, publish: approveNote === null ? this.cfg.labels.approved : this.cfg.labels.feedback },
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
      await this.post(job, this.db.findings(id), mode, pr);
      return this.db.job(id)!;
    } catch (err) {
      // Put the review back as it was, ready to try again.
      this.db.updateJob(id, { step: 'Dry run: not posted', progress: 100 });
      if (err instanceof PendingReviewExists) {
        throw new PostRefused('You already have an unsubmitted review on this PR. Submit or discard it on GitHub, then try again.');
      }
      if (err instanceof UnsafeToPost) {
        this.db.event(id, err.message, 'error');
        throw new PostRefused(err.message);
      }
      if (!(err instanceof PostRefused)) this.db.event(id, `Posting failed: ${err instanceof Error ? err.message : err}`, 'error');
      throw err;
    } finally {
      this.posting.delete(id);
    }
  }

  private async labelStart(job: Job, pr: PrInfo) {
    if (job.dry_run) return;
    const ok = await showLabel(this.gh, job.repo, job.pr_number, this.cfg.labels, 'reviewing', pr.labels);
    if (!ok) this.db.event(job.id, 'Can\'t set labels on this repo (needs triage access); the review body carries a marker instead', 'warn');
  }

  // A review that stops early takes its "on review" label with it.
  async labelFailed(job: Job) {
    if (job.dry_run) return;
    await removeLabel(this.gh, job.repo, job.pr_number, this.cfg.labels.reviewing);
  }

  async labelCancelled(job: Job) {
    await this.labelFailed(job);
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
