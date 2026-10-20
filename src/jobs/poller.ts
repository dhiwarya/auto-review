import type { LoadedConfig } from '../config.ts';
import { nowIso, type Db } from '../db.ts';
import { rateLimitResetAt, type GitHub } from '../github/client.ts';
import { getPr, searchRequestedPrs, type PrInfo } from '../github/prs.ts';
import { bus } from '../bus.ts';
import { ACTIVE_STATES, type Job } from '../types.ts';
import type { Worker } from './worker.ts';
import type { OutcomeSync } from './sync.ts';

export class Poller {
  private readonly gh: GitHub;
  private readonly cfg: LoadedConfig;
  private readonly db: Db;
  private readonly worker: Worker;
  private readonly sync: OutcomeSync;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  // PR -> updated_at from the last search. A PR is only re-read when GitHub says it
  // changed, so frequent polling costs one search request per check.
  private readonly seen = new Map<string, string>();
  private pausedUntil = 0;
  private lastSyncAt = 0;

  constructor(gh: GitHub, cfg: LoadedConfig, db: Db, worker: Worker, sync: OutcomeSync) {
    this.gh = gh;
    this.cfg = cfg;
    this.db = db;
    this.worker = worker;
    this.sync = sync;
  }

  start() {
    const every = this.cfg.schedule.pollIntervalSec * 1000;
    this.timer = setInterval(() => void this.pollOnce(), every);
    void this.pollOnce();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
  }

  async pollOnce(): Promise<void> {
    if (this.polling || Date.now() < this.pausedUntil) return;
    this.polling = true;
    try {
      const requested = await searchRequestedPrs(this.gh);
      const requestedKeys = new Set(requested.map((r) => `${r.repo}#${r.number}`));
      for (const key of this.seen.keys()) if (!requestedKeys.has(key)) this.seen.delete(key);

      for (const r of requested) {
        if (!this.cfg.isRepoAllowed(r.repo)) continue; // never touch repos outside the allowlist
        const key = `${r.repo}#${r.number}`;
        if (this.seen.get(key) === r.updatedAt) continue;
        try {
          const pr = await getPr(this.gh, r.repo, r.number);
          if (pr.state === 'open' && !pr.draft) this.enqueue(pr, 'request');
          this.seen.set(key, r.updatedAt);
        } catch (err) {
          if (rateLimitResetAt(err)) throw err;
          console.error(`[poll] ${key}: ${err instanceof Error ? err.message : err}`);
        }
      }

      // Review requests that went away (removed, PR closed or merged) cancel pending work.
      for (const job of this.db.all<Job>(`SELECT * FROM jobs WHERE source = 'request' AND state IN ('queued', 'running', 'waiting')`)) {
        if (!requestedKeys.has(`${job.repo}#${job.pr_number}`)) {
          this.worker.cancel(job.id, 'review request removed or PR closed', 'request-removed');
        }
      }

      // Checking what you did with submitted drafts doesn't need to be as quick.
      if (Date.now() - this.lastSyncAt >= this.cfg.schedule.syncIntervalSec * 1000) {
        this.lastSyncAt = Date.now();
        await this.sync.syncOnce();
      }
      this.db.setKv('last_poll_error', null);
    } catch (err) {
      const resetAt = rateLimitResetAt(err);
      if (resetAt) {
        this.pausedUntil = resetAt.getTime();
        this.db.setKv('last_poll_error', `GitHub rate limit reached; checking again at ${resetAt.toLocaleTimeString()}`);
      } else {
        this.db.setKv('last_poll_error', err instanceof Error ? err.message : String(err));
      }
      console.error('[poll] failed:', err instanceof Error ? err.message : err);
    } finally {
      const next = Math.max(Date.now() + this.cfg.schedule.pollIntervalSec * 1000, this.pausedUntil);
      this.db.setKv('last_poll_at', nowIso());
      this.db.setKv('next_poll_at', new Date(next).toISOString());
      this.polling = false;
      bus.overviewChanged();
    }
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

    const author = pr.author.toLowerCase();
    if (author === this.gh.me.toLowerCase() || this.cfg.skipAuthors.some((a) => a.toLowerCase() === author)) {
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
