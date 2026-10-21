import type { SettingsStore } from '../settings.ts';
import type { Db } from '../db.ts';
import type { GitHub } from '../github/client.ts';
import { removeLabel, showLabel } from '../github/labels.ts';
import { getPr } from '../github/prs.ts';
import { FINDING_MARKER, getReview, listReviewComments } from '../github/publish.ts';
import type { Finding, Job } from '../types.ts';

const stripMarker = (body: string) => body.replace(FINDING_MARKER, '').trim();

// Comments posted before the wording changed have no stored copy; they were written like this.
const LEGACY_SEVERITY = { blocker: '🔴 Blocker', major: '🟠 Major', minor: '🟡 Minor', nit: '⚪ Nit' } as const;
const LEGACY_PROVIDER = { claude: 'Claude', codex: 'Codex' } as const;
export function legacyInlineBody(f: Finding): string {
  const who = f.model_id ? `${LEGACY_PROVIDER[f.model]} (${f.model_id})` : LEGACY_PROVIDER[f.model];
  const parts = [`AI-assisted · ${who}`, `confidence ${f.confidence}`];
  if (f.verification === 'confirmed') parts.push(`confirmed by ${LEGACY_PROVIDER[f.verified_by ?? f.model]}`);
  if (f.verification === 'uncertain') parts.push(`unconfirmed by ${LEGACY_PROVIDER[f.verified_by ?? f.model]}`);
  return [`**${LEGACY_SEVERITY[f.severity]} · ${f.category}**: ${f.title}`, '', f.problem, '', `**Suggestion:** ${f.suggestion}`, '', `<sub>${parts.join(' · ')}</sub>`].join('\n');
}

// Learns what you did with each draft: which comments you kept, edited or deleted
// before submitting, which is what the leaderboards' keep rate is built on. Once you
// submit, the PR's label follows what you chose: approved, or feedback.
export class OutcomeSync {
  private readonly gh: GitHub;
  private readonly cfg: SettingsStore;
  private readonly db: Db;

  constructor(gh: GitHub, cfg: SettingsStore, db: Db) {
    this.gh = gh;
    this.cfg = cfg;
    this.db = db;
  }

  async syncOnce() {
    const monthAgo = new Date(Date.now() - 30 * 86400_000).toISOString();
    const jobs = this.db.all<Job>(
      `SELECT * FROM jobs WHERE state = 'done' AND dry_run = 0 AND mode = 'draft' AND review_id IS NOT NULL
         AND review_state = 'PENDING' AND finished_at >= ? ORDER BY finished_at DESC LIMIT 20`,
      monthAgo,
    );
    for (const job of jobs) {
      try {
        await this.syncJob(job);
      } catch (err) {
        console.error(`[sync] job ${job.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  private async syncJob(job: Job) {
    const review = await getReview(this.gh, job.repo, job.pr_number, job.review_id!);
    const findings = this.db.findings(job.id).filter((f) => f.status !== 'dropped');

    if (!review) {
      this.db.updateJob(job.id, { review_state: 'DELETED' });
      for (const f of findings) this.db.updateFinding(f.id, { outcome: 'deleted' });
      this.db.event(job.id, 'You discarded the draft review');
      await removeLabel(this.gh, job.repo, job.pr_number, this.cfg.labels.reviewing);
      return;
    }
    if (review.state === 'PENDING') return;

    const comments = await listReviewComments(this.gh, job.repo, job.pr_number, job.review_id!);
    const byFinding = new Map<number, string>();
    for (const c of comments) {
      const m = FINDING_MARKER.exec(c.body);
      if (m) byFinding.set(Number(m[1]), c.body);
    }
    const commentById = new Map(comments.map((c) => [c.id, c.body]));

    let kept = 0;
    for (const f of findings) {
      const outcome = this.outcomeFor(f, byFinding, commentById, review.body);
      if (outcome === 'kept' || outcome === 'edited') kept++;
      this.db.updateFinding(f.id, { outcome });
    }
    this.db.updateJob(job.id, { review_state: review.state });
    this.db.event(job.id, `You submitted the review (${review.state.toLowerCase()})${findings.length ? `: kept ${kept} of ${findings.length} finding(s)` : ''}`);

    const pr = await getPr(this.gh, job.repo, job.pr_number);
    await showLabel(this.gh, job.repo, job.pr_number, this.cfg.labels, review.state === 'APPROVED' ? 'approved' : 'feedback', pr.labels);
  }

  private outcomeFor(f: Finding, byFinding: Map<number, string>, byCommentId: Map<number, string>, reviewBody: string): Finding['outcome'] {
    if (f.status === 'summary') {
      // Summary findings live in the review body; their marker survives unless you cut them.
      return reviewBody.includes(`ai-finding:${f.id}`) ? 'kept' : 'unknown';
    }
    const body = byFinding.get(f.id) ?? (f.comment_id ? byCommentId.get(f.comment_id) : undefined);
    if (body === undefined) return 'deleted';
    return stripMarker(body) === stripMarker(f.posted_body ?? legacyInlineBody(f)) ? 'kept' : 'edited';
  }
}
