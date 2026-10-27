import type { SettingsStore } from '../settings.ts';
import { nowIso, type Db } from '../db.ts';
import { HeadMovedError } from '../git/mirror.ts';
import { PendingReviewExists } from '../github/publish.ts';
import { NoProviderAvailable } from '../llm/router.ts';
import { JobObsolete, UnsafeToPost, type ReviewPipeline } from '../review/pipeline.ts';
import { bus } from '../bus.ts';
import type { Job } from '../types.ts';
import { StrictReviewWaiting } from '../review/strict.ts';

const minutesFromNow = (m: number) => new Date(Date.now() + m * 60_000).toISOString();

function inPauseWindow(window: { start: string; end: string } | null, now = new Date()): boolean {
  if (!window) return false;
  const mins = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = window.start.split(':').map(Number);
  const [eh, em] = window.end.split(':').map(Number);
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  return start <= end ? mins >= start && mins < end : mins >= start || mins < end; // overnight windows
}

export class Worker {
  private readonly db: Db;
  private readonly cfg: SettingsStore;
  private readonly pipeline: ReviewPipeline;
  private readonly running = new Map<number, AbortController>();
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(db: Db, cfg: SettingsStore, pipeline: ReviewPipeline) {
    this.db = db;
    this.cfg = cfg;
    this.pipeline = pipeline;
  }

  start() {
    // Anything still marked running was interrupted by a restart.
    for (const job of this.db.all<Job>(`SELECT * FROM jobs WHERE state = 'running'`)) {
      this.db.setState(job.id, 'queued', { step: 'Restarted after an interruption' });
    }
    this.timer = setInterval(() => this.tick(), 3000);
    this.tick();
  }

  // Reviews in progress go back to the queue and start over on the next launch.
  stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    for (const [id, c] of this.running) {
      this.db.event(id, 'Interrupted because the app stopped; it resumes on the next start');
      this.db.setState(id, 'queued', { step: 'Interrupted; resumes when the app starts again', progress: 0 });
      c.abort(new Error('shutting down'));
    }
  }

  pausedReason(): string | null {
    if (inPauseWindow(this.cfg.schedule.pauseBetween)) {
      return `Paused between ${this.cfg.schedule.pauseBetween!.start} and ${this.cfg.schedule.pauseBetween!.end}`;
    }
    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const started = this.db.get<{ n: number }>(`SELECT COUNT(DISTINCT job_id) AS n FROM runs WHERE (purpose IN ('main', 'recheck') OR purpose LIKE 'strict:%') AND created_at >= ?`, hourAgo)?.n ?? 0;
    if (started >= this.cfg.schedule.maxReviewsPerHour) return `Hourly limit reached (${this.cfg.schedule.maxReviewsPerHour} reviews per hour)`;
    return null;
  }

  private tick() {
    if (this.stopping) return;
    if (this.running.size >= this.cfg.schedule.concurrency) return;
    if (this.pausedReason()) return;
    const job = this.db.get<Job>(
      `SELECT * FROM jobs WHERE state IN ('queued', 'waiting') AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY created_at LIMIT 1`,
      nowIso(),
    );
    if (job) void this.execute(job);
  }

  private async execute(job: Job) {
    const controller = new AbortController();
    this.running.set(job.id, controller);
    const current = this.db.setState(job.id, 'running', { started_at: nowIso(), error: null, next_attempt_at: null, progress: 2, step: 'Starting' });
    bus.overviewChanged();
    try {
      await this.pipeline.run(current, controller.signal);
    } catch (err) {
      await this.handleFailure(job.id, err, controller.signal);
    } finally {
      this.running.delete(job.id);
      bus.overviewChanged();
    }
  }

  private async handleFailure(id: number, err: unknown, signal: AbortSignal) {
    if (this.stopping) return; // stop() already put the job back in the queue
    const job = this.db.job(id)!;
    const message = err instanceof Error ? err.message : String(err);

    if (signal.aborted) {
      // cancel() already set the state; make sure the running label goes away.
      if (job.state === 'running') this.db.setState(id, 'cancelled', { step: 'Cancelled' });
      await this.pipeline.labelCancelled(job).catch(() => {});
      return;
    }
    if (err instanceof JobObsolete || err instanceof HeadMovedError) {
      this.db.event(id, `Stopped: ${message}`);
      this.db.setState(id, 'cancelled', { step: `Stopped: ${message}`, skip_reason: 'obsolete' });
      await this.pipeline.labelCancelled(job).catch(() => {});
      return;
    }
    if (err instanceof UnsafeToPost) {
      this.db.event(id, message, 'error');
      this.db.setState(id, 'failed', { error: message, step: 'Failed' });
      await this.pipeline.labelFailed(job).catch(() => {});
      return;
    }
    if (err instanceof StrictReviewWaiting) {
      this.db.event(id, err.message, 'warn');
      this.db.setState(id, 'waiting', { step: err.message, next_attempt_at: err.retryAt.toISOString() });
      return;
    }
    if (err instanceof NoProviderAvailable) {
      this.db.event(id, message, 'warn');
      this.db.setState(id, 'waiting', { step: 'Waiting for Claude or Codex usage limits to reset', next_attempt_at: err.retryAt.toISOString() });
      return;
    }
    if (err instanceof PendingReviewExists) {
      this.db.event(id, 'You already have an unsubmitted review on this PR. Submit or discard it and the draft will be posted.', 'warn');
      this.db.setState(id, 'waiting', { step: 'Waiting: submit or discard your pending review on this PR', next_attempt_at: minutesFromNow(15) });
      return;
    }

    const attempts = job.attempts + 1;
    this.db.event(id, `Attempt ${attempts} failed: ${message}`, 'error');
    if (attempts >= this.cfg.limits.maxAttempts) {
      this.db.setState(id, 'failed', { attempts, error: message, step: 'Failed' });
      await this.pipeline.labelFailed(job).catch(() => {});
    } else {
      const delay = 5 * 2 ** (attempts - 1);
      this.db.setState(id, 'queued', { attempts, error: message, step: `Retrying in ${delay} min`, next_attempt_at: minutesFromNow(delay) });
    }
  }

  cancel(id: number, reason: string, skipReason: string | null = null) {
    const job = this.db.job(id);
    if (!job || !['queued', 'running', 'waiting'].includes(job.state)) return;
    this.db.event(id, `Cancelled: ${reason}`);
    this.db.setState(id, 'cancelled', { step: `Cancelled: ${reason}`, skip_reason: skipReason });
    this.running.get(id)?.abort(new Error(reason));
    bus.overviewChanged();
  }

  retry(id: number) {
    const job = this.db.job(id);
    // A done job already has a review on GitHub; retrying it would post a second one.
    if (!job || !['failed', 'cancelled', 'skipped', 'waiting'].includes(job.state)) return;
    this.db.event(id, 'Retry requested from the dashboard');
    this.db.setState(id, 'queued', { attempts: 0, error: null, next_attempt_at: null, finished_at: null, step: 'Queued', progress: 0 });
    bus.overviewChanged();
  }
}
