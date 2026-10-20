import type { LoadedConfig } from '../config.ts';
import type { Db } from '../db.ts';
import type { Provider, ProviderStatus } from '../types.ts';
import { runClaude, runCodex, type AgentTask } from './agents.ts';
import { ProviderUnavailable } from './run.ts';
import { bus } from '../bus.ts';

export class NoProviderAvailable extends Error {
  readonly retryAt: Date;
  constructor(retryAt: Date) {
    super(`Claude and Codex are both unavailable until ${retryAt.toLocaleTimeString()}`);
    this.retryAt = retryAt;
  }
}

export type RouterTask = Omit<AgentTask, 'model'>;

// Picks Claude or Codex for each pass and switches to the other one when a provider
// reports a usage limit or isn't signed in. Blocks are remembered across restarts.
export class Router {
  private readonly db: Db;
  private readonly cfg: LoadedConfig;

  constructor(db: Db, cfg: LoadedConfig) {
    this.db = db;
    this.cfg = cfg;
  }

  blockedUntil(p: Provider): Date | null {
    const v = this.db.getKv(`blocked_until.${p}`);
    if (!v) return null;
    const d = new Date(v);
    return d.getTime() > Date.now() ? d : null;
  }

  status(): ProviderStatus[] {
    return (['claude', 'codex'] as Provider[]).map((p) => ({
      provider: p,
      blocked_until: this.blockedUntil(p)?.toISOString() ?? null,
      last_error: this.db.getKv(`last_error.${p}`),
    }));
  }

  private block(p: Provider, err: ProviderUnavailable) {
    const minutes = err.reason === 'quota' ? this.cfg.schedule.quotaBackoffMin : 10;
    this.db.setKv(`blocked_until.${p}`, new Date(Date.now() + minutes * 60_000).toISOString());
    this.db.setKv(`last_error.${p}`, `${err.reason}: ${err.message}`.slice(0, 300));
    bus.overviewChanged();
  }

  clear(p: Provider) {
    this.db.setKv(`blocked_until.${p}`, null);
    bus.overviewChanged();
  }

  // The model configured for a provider on any pass, used when it stands in for the other one.
  private modelFor(p: Provider, preferred: { provider: Provider; model: string | null }): string | null {
    if (preferred.provider === p) return preferred.model;
    const { main, security } = this.cfg.models;
    return [main, security].find((c) => c.provider === p)?.model ?? null;
  }

  async run(
    jobId: number,
    purpose: string,
    preferred: { provider: Provider; model: string | null },
    fallback: Provider | null,
    task: RouterTask,
  ): Promise<{ provider: Provider; output: unknown }> {
    const order = [preferred.provider, ...(fallback && fallback !== preferred.provider ? [fallback] : [])];
    let lastErr: unknown = null;

    for (const provider of order) {
      if (this.blockedUntil(provider)) continue;
      const model = this.modelFor(provider, preferred);
      const fellBack = provider !== preferred.provider;
      const started = Date.now();
      try {
        const res =
          provider === 'claude'
            ? await runClaude({ ...task, model }, { claudeMaxTurns: this.cfg.limits.claudeMaxTurns, claudeEffort: this.cfg.models.claudeEffort })
            : await runCodex({ ...task, model });
        this.db.insertRun({ job_id: jobId, purpose, provider, model, ok: 1, fell_back: fellBack ? 1 : 0, duration_ms: res.durationMs, error: null });
        if (this.db.getKv(`last_error.${provider}`)) this.db.setKv(`last_error.${provider}`, null);
        return { provider, output: res.output };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.db.insertRun({ job_id: jobId, purpose, provider, model, ok: 0, fell_back: fellBack ? 1 : 0, duration_ms: Date.now() - started, error: message.slice(0, 500) });
        if (task.signal?.aborted) throw err;
        if (err instanceof ProviderUnavailable) {
          this.block(provider, err);
          this.db.event(jobId, `${provider} unavailable (${err.reason}); trying the other provider`, 'warn');
          lastErr = err;
          continue;
        }
        throw err; // a real failure of this run; the job's retry logic handles it
      }
    }

    const retryAts = order.map((p) => this.blockedUntil(p)).filter((d): d is Date => d !== null);
    if (retryAts.length === order.length) {
      throw new NoProviderAvailable(new Date(Math.min(...retryAts.map((d) => d.getTime()))));
    }
    throw lastErr ?? new Error('no provider ran');
  }
}
