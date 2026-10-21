import type { SettingsStore } from '../settings.ts';
import { nowIso, type Db } from '../db.ts';
import { rateLimited, type GitHub } from '../github/client.ts';
import { getPr, type PrInfo } from '../github/prs.ts';
import { RepoWatcher, type OpenPr } from '../github/watch.ts';
import { bus } from '../bus.ts';
import { ACTIVE_STATES, type Job } from '../types.ts';
import type { Worker } from './worker.ts';
import type { OutcomeSync } from './sync.ts';

// Polling stops when fewer than this many requests are left in the hourly budget, so
// posting reviews and labels still works.
const CORE_RESERVE = 300;
const MAX_BACKOFF_MIN = 15;

// GitHub states of a review that was submitted, as opposed to a pending draft.
const SUBMITTED = ['APPROVED', 'COMMENTED', 'CHANGES_REQUESTED'];
// How long after a review is posted before its PR can count as re-requested.
const RECHECK_SETTLE_MS = 60_000;

export interface PollerStatus {
  pausedUntil: string | null;
  pauseReason: string | null;
}

export class Poller {
  private readonly gh: GitHub;
  private readonly cfg: SettingsStore;
  private readonly db: Db;
  private readonly worker: Worker;
  private readonly sync: OutcomeSync;
  readonly watcher: RepoWatcher;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private polling = false;
  private pausedUntil = 0;
  private pauseReason: string | null = null;
  private strikes = 0; // consecutive "slow down" answers without a retry time
  private lastSyncAt = 0;

  constructor(gh: GitHub, cfg: SettingsStore, db: Db, worker: Worker, sync: OutcomeSync, watcher?: RepoWatcher) {
    this.gh = gh;
    this.cfg = cfg;
    this.db = db;
    this.worker = worker;
    this.sync = sync;
    this.watcher = watcher ?? new RepoWatcher(gh, cfg);
  }

  start() {
    bus.on('settings', this.onSettings);
    this.scheduleNext(0);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    bus.off('settings', this.onSettings);
  }

  status(): PollerStatus {
    const paused = this.pausedUntil > Date.now();
    return { pausedUntil: paused ? new Date(this.pausedUntil).toISOString() : null, pauseReason: paused ? this.pauseReason : null };
  }

  // Saving settings checks again right away, for example to pick up repos you just added.
  private readonly onSettings = () => this.scheduleNext(500);

  // Re-reads the interval after every check, so a change in Settings applies to the next one.
  private scheduleNext(ms: number) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      await this.pollOnce();
      this.scheduleNext(this.cfg.schedule.pollIntervalSec * 1000);
    }, ms);
  }

  private pause(until: number, reason: string) {
    this.pausedUntil = until;
    this.pauseReason = reason;
    this.db.setKv('last_poll_error', `${reason}; checking again at ${new Date(until).toLocaleTimeString()}`);
    console.error(`[poll] ${reason}; pausing until ${new Date(until).toLocaleTimeString()}`);
  }

  async pollOnce(): Promise<void> {
    if (this.polling || Date.now() < this.pausedUntil) return;
    this.polling = true;
    this.watcher.startCycle();
    try {
      // Nothing to do until you add repos in Settings, so don't spend GitHub requests.
      if (this.cfg.needsSetup) {
        this.db.setKv('last_poll_error', null);
        return;
      }
      const core = this.gh.rateLimits.get('core');
      if (core && core.remaining < CORE_RESERVE) {
        this.pause(new Date(core.reset).getTime(), `Only ${core.remaining} GitHub requests left this hour, kept for posting reviews`);
        return;
      }

      const me = this.gh.me.toLowerCase();
      const requestedKeys = new Set<string>();
      const polled = new Set<string>();
      for (const repo of await this.watcher.watchedRepos()) {
        let prs: OpenPr[];
        try {
          prs = await this.watcher.openPrs(repo);
        } catch (err) {
          if (rateLimited(err)) throw err;
          console.error(`[poll] ${repo}: ${err instanceof Error ? err.message : err}`);
          continue;
        }
        polled.add(repo.toLowerCase());
        for (const pr of prs) {
          if (pr.draft || !pr.requestedReviewers.some((u) => u.toLowerCase() === me)) continue;
          requestedKeys.add(`${pr.repo}#${pr.number}`.toLowerCase());
          const need = this.needsJob(pr);
          if (!need) continue;
          try {
            const info = await getPr(this.gh, pr.repo, pr.number);
            if (info.state !== 'open' || info.draft) continue;
            if (need === 'review') this.enqueue(info, 'request');
            // Read fresh, so a list that hasn't caught up with the review just posted can't re-trigger it.
            else if (info.headSha === pr.headSha && info.requestedReviewers.some((u) => u.toLowerCase() === me)) this.enqueueRecheck(info, 'request');
          } catch (err) {
            if (rateLimited(err)) throw err;
            console.error(`[poll] ${pr.repo}#${pr.number}: ${err instanceof Error ? err.message : err}`);
          }
        }
      }

      // Review requests that went away (removed, PR closed or merged) cancel pending work.
      // Only for repos checked successfully just now: a failed check says nothing.
      for (const job of this.db.all<Job>(`SELECT * FROM jobs WHERE source = 'request' AND state IN ('queued', 'running', 'waiting')`)) {
        if (!this.cfg.isRepoAllowed(job.repo)) {
          this.worker.cancel(job.id, 'repo removed from your list', 'obsolete');
        } else if (polled.has(job.repo.toLowerCase()) && !requestedKeys.has(`${job.repo}#${job.pr_number}`.toLowerCase())) {
          this.worker.cancel(job.id, 'review request removed or PR closed', 'request-removed');
        }
      }

      // Checking what you did with submitted drafts doesn't need to be as quick.
      if (Date.now() - this.lastSyncAt >= this.cfg.schedule.syncIntervalSec * 1000) {
        this.lastSyncAt = Date.now();
        await this.sync.syncOnce();
      }
      this.strikes = 0;
      this.pauseReason = null;
      this.db.setKv('last_poll_error', null);
    } catch (err) {
      const limited = rateLimited(err);
      if (limited?.kind === 'primary') {
        this.pause(limited.resetAt!.getTime(), 'GitHub rate limit reached');
      } else if (limited) {
        // GitHub asks for exponential back-off when it doesn't say how long to wait.
        const backoff = Math.min(MAX_BACKOFF_MIN, 2 ** this.strikes) * 60_000;
        this.strikes++;
        this.pause(Math.max(limited.resetAt?.getTime() ?? 0, Date.now() + backoff), 'GitHub asked the app to slow down');
      } else {
        this.db.setKv('last_poll_error', err instanceof Error ? err.message : String(err));
        console.error('[poll] failed:', err instanceof Error ? err.message : err);
      }
    } finally {
      const next = Math.max(Date.now() + this.cfg.schedule.pollIntervalSec * 1000, this.pausedUntil);
      this.db.setKv('last_poll_at', nowIso());
      this.db.setKv('next_poll_at', new Date(next).toISOString());
      this.db.setKv('last_poll_stats', JSON.stringify(this.watcher.stats));
      this.polling = false;
      bus.overviewChanged();
    }
  }

  // What a PR that requests you needs: a review of a commit not reviewed yet, or a re-check
  // when the review was requested again without new commits. Decided from the database
  // alone, so an unchanged PR costs no extra GitHub request.
  private needsJob(pr: OpenPr): 'review' | 'recheck' | null {
    const latest = this.db.jobsForPr(pr.repo, pr.number).find((j) => j.head_sha === pr.headSha);
    if (!latest || (latest.state === 'cancelled' && latest.skip_reason === 'request-removed')) return 'review';
    // Submitting a review takes you off the PR's requested reviewers, so being on it again
    // after one was submitted means the author asked again. Drafts not yet submitted and
    // dry runs leave the request in place, so they never count.
    const answered = latest.state === 'done' && !latest.dry_run && SUBMITTED.includes(latest.review_state ?? '');
    const settled = Date.now() - Date.parse(latest.finished_at ?? latest.updated_at) > RECHECK_SETTLE_MS;
    return answered && settled ? 'recheck' : null;
  }

  // Re-checks the open findings on the PR's current commit, which was already reviewed.
  enqueueRecheck(pr: PrInfo, source: Job['source']): Job {
    const lastDone = this.db.jobsForPr(pr.repo, pr.number).find((j) => j.head_sha === pr.headSha && j.state === 'done');
    const job = this.db.insertJob({
      repo: pr.repo,
      pr_number: pr.number,
      pr_title: pr.title,
      pr_url: pr.url,
      author: pr.author,
      head_sha: pr.headSha,
      base_sha: pr.baseSha,
      since_sha: pr.headSha,
      kind: 'recheck',
      mode: this.cfg.modeFor(pr.repo),
      source,
      dry_run: this.cfg.dryRun ? 1 : 0,
      state: 'queued',
      additions: pr.additions,
      deletions: pr.deletions,
      changed_files: pr.changedFiles,
    });
    const why = source === 'manual' ? 'Re-check requested from the dashboard' : 'Review requested again';
    this.db.event(job.id, `${why} with no new commits since ${pr.headSha.slice(0, 7)}${lastDone ? ` (job ${lastDone.id})` : ''}: re-checking the open findings`);
    bus.overviewChanged();
    return job;
  }

  // The dashboard's "Re-check" on a finished review. Refused when the PR has moved on (that
  // needs a normal follow-up review) or something is already queued for it.
  async recheckFromDashboard(id: number): Promise<Job> {
    const done = this.db.job(id);
    if (!done || done.state !== 'done') throw new Error('Only finished reviews can be re-checked');
    if (!this.cfg.isRepoAllowed(done.repo)) throw new Error('This repo is no longer in your repos list');
    if (this.db.jobsForPr(done.repo, done.pr_number).some((j) => ACTIVE_STATES.includes(j.state))) {
      throw new Error('This PR already has a review queued or running');
    }
    const pr = await getPr(this.gh, done.repo, done.pr_number);
    if (pr.state !== 'open') throw new Error('This PR is no longer open');
    if (pr.headSha !== done.head_sha) throw new Error(`The PR has new commits (${pr.headSha.slice(0, 7)}); review it from the queue instead`);
    return this.enqueueRecheck(pr, 'manual');
  }

  // Creates the job for this PR's current head commit, if there isn't one yet.
  enqueue(pr: PrInfo, source: Job['source']): Job {
    const existing = this.db.jobsForPr(pr.repo, pr.number);
    const same = existing.find((j) => j.head_sha === pr.headSha);
    if (same) {
      // A request that briefly disappeared (or a manual retry) brings a cancelled job back.
      const revivable = same.state === 'cancelled' && (same.skip_reason === 'request-removed' || source === 'manual');
      if (revivable) {
        this.db.event(same.id, source === 'manual' ? 'Re-queued from the dashboard' : 'Review requested again');
        return this.db.setState(same.id, 'queued', { step: 'Queued', attempts: 0, error: null, skip_reason: null, finished_at: null, next_attempt_at: null, progress: 0 });
      }
      return same;
    }

    // New commits make any in-flight review of older commits pointless.
    for (const old of existing.filter((j) => ACTIVE_STATES.includes(j.state))) {
      this.worker.cancel(old.id, `superseded by ${pr.headSha.slice(0, 7)}`, 'obsolete');
    }

    const base = {
      repo: pr.repo,
      pr_number: pr.number,
      pr_title: pr.title,
      pr_url: pr.url,
      author: pr.author,
      head_sha: pr.headSha,
      base_sha: pr.baseSha,
      mode: this.cfg.modeFor(pr.repo),
      source,
      dry_run: this.cfg.dryRun ? 1 : 0,
      additions: pr.additions,
      deletions: pr.deletions,
      changed_files: pr.changedFiles,
    };

    // PRs you add from the dashboard always run, including your own (handy for testing).
    const author = pr.author.toLowerCase();
    const skipped = author === this.gh.me.toLowerCase() || this.cfg.skipAuthors.some((a) => a.toLowerCase() === author);
    if (source === 'request' && skipped) {
      return this.db.insertJob({ ...base, since_sha: null, state: 'skipped', skip_reason: `author ${pr.author} is on the skip list` });
    }

    // Follow-up reviews only look at commits since the last completed review of the same kind.
    const lastDone = existing.find((j) => j.state === 'done' && j.dry_run === base.dry_run);
    const job = this.db.insertJob({ ...base, since_sha: lastDone?.head_sha ?? null, state: 'queued' });
    this.db.event(job.id, `Queued ${lastDone ? `follow-up review since ${lastDone.head_sha.slice(0, 7)}` : 'review'} (${base.mode}${base.dry_run ? ', dry run' : ''})`);
    bus.overviewChanged();
    return job;
  }
}
