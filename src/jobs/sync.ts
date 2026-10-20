import type { LoadedConfig } from '../config.ts';
import type { Db } from '../db.ts';
import type { GitHub } from '../github/client.ts';
import { addLabel } from '../github/labels.ts';
import { FINDING_MARKER, getReview, listReviewComments } from '../github/publish.ts';
import { inlineBody } from '../review/format.ts';
import type { Finding, Job } from '../types.ts';

const stripMarker = (body: string) => body.replace(FINDING_MARKER, '').trim();

// Learns what you did with each draft: which comments you kept, edited or deleted
// before submitting. This is what the leaderboards' keep rate is built on.
export class OutcomeSync {
  private readonly gh: GitHub;
  private readonly cfg: LoadedConfig;
  private readonly db: Db;

  constructor(gh: GitHub, cfg: LoadedConfig, db: Db) {
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

    let keptBlocker = false;
    let kept = 0;
    for (const f of findings) {
      const outcome = this.outcomeFor(f, byFinding, commentById, review.body);
      if (outcome === 'kept' || outcome === 'edited') {
        kept++;
        if (f.severity === 'blocker') keptBlocker = true;
      }
      this.db.updateFinding(f.id, { outcome });
    }
    this.db.updateJob(job.id, { review_state: review.state });
    this.db.event(job.id, `You submitted the review (${review.state.toLowerCase()}): kept ${kept} of ${findings.length} finding(s)`);

    if (keptBlocker && !this.cfg.labels.blockerLabelInDraft) {
      await addLabel(this.gh, job.repo, job.pr_number, this.cfg.labelName('blocker'));
    }
  }

  private outcomeFor(f: Finding, byFinding: Map<number, string>, byCommentId: Map<number, string>, reviewBody: string): Finding['outcome'] {
    if (f.status === 'summary') {
      // Summary findings live in the review body; their marker survives unless you cut them.
      return reviewBody.includes(`ai-finding:${f.id}`) ? 'kept' : 'unknown';
    }
    const body = byFinding.get(f.id) ?? (f.comment_id ? byCommentId.get(f.comment_id) : undefined);
    if (body === undefined) return 'deleted';
    return stripMarker(body) === stripMarker(inlineBody(f)) ? 'kept' : 'edited';
  }
}
