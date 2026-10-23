import type { SettingsStore } from '../settings.ts';
import type { Db } from '../db.ts';
import type { ModelStatus, Provider, ProviderStatus } from '../types.ts';
import { randomUUID } from 'node:crypto';
import { runClaude, runCodex, type AgentTask, type StepEvent } from './agents.ts';
import { ContentRefused, ProviderUnavailable } from './run.ts';
import { bus } from '../bus.ts';

export class NoProviderAvailable extends Error {
  readonly retryAt: Date;
  constructor(retryAt: Date) {
    super(`No Claude or Codex model is available until ${retryAt.toLocaleTimeString()}`);
    this.retryAt = retryAt;
  }
}

export type RouterTask = Omit<AgentTask, 'model' | 'onStep'>;

const modelKey = (p: Provider, model: string | null) => `${p}/${model ?? 'default'}`;

// Runs every pass on the chosen provider's models in order (e.g. Sol 6.1, then Sol 6), and
// on the other provider's models when none of them can take work and falling back is on. A model that hits a
// usage limit, isn't available or is overloaded is paused on its own; "not signed in"
// pauses the whole provider. Pauses are remembered across restarts. A model whose safety
// filter declines the content isn't paused: the run just moves on down the same chain.
export class Router {
  private readonly db: Db;
  private readonly cfg: SettingsStore;

  constructor(db: Db, cfg: SettingsStore) {
    this.db = db;
    this.cfg = cfg;
  }

  private until(key: string): Date | null {
    const v = this.db.getKv(`blocked_until.${key}`);
    if (!v) return null;
    const d = new Date(v);
    return d.getTime() > Date.now() ? d : null;
  }

  private providerBlockedUntil(p: Provider): Date | null {
    return this.until(p);
  }

  private modelBlockedUntil(p: Provider, model: string | null): Date | null {
    return this.until(modelKey(p, model));
  }

  // null when the provider can take work now; otherwise when it next can.
  private availableAt(p: Provider): Date | null {
    const whole = this.providerBlockedUntil(p);
    if (whole) return whole;
    const models = this.cfg.modelChain(p).map((m) => this.modelBlockedUntil(p, m));
    if (models.some((d) => d === null)) return null;
    return new Date(Math.min(...models.map((d) => d!.getTime())));
  }

  status(): ProviderStatus[] {
    return (['claude', 'codex'] as Provider[]).map((p) => {
      const models: ModelStatus[] = this.cfg.modelChain(p).map((model) => ({
        model,
        blocked_until: this.modelBlockedUntil(p, model)?.toISOString() ?? null,
        last_error: this.db.getKv(`last_error.${modelKey(p, model)}`),
      }));
      const providerBlocked = this.providerBlockedUntil(p) !== null;
      const active = providerBlocked ? undefined : models.find((m) => m.blocked_until === null);
      return {
        provider: p,
        blocked_until: this.availableAt(p)?.toISOString() ?? null,
        last_error: this.db.getKv(`last_error.${p}`) ?? models.find((m) => m.blocked_until && m.last_error)?.last_error ?? null,
        active_model: active ? active.model : null,
        models,
      };
    });
  }

  private block(p: Provider, model: string | null, err: ProviderUnavailable) {
    const minutes = { quota: this.cfg.schedule.quotaBackoffMin, model: 60, overloaded: 5, auth: 10, missing: 10 }[err.reason];
    const key = err.reason === 'auth' || err.reason === 'missing' ? p : modelKey(p, model);
    this.db.setKv(`blocked_until.${key}`, new Date(Date.now() + minutes * 60_000).toISOString());
    this.db.setKv(`last_error.${key}`, `${err.reason}: ${err.message}`.slice(0, 300));
    bus.overviewChanged();
  }

  clear(p: Provider) {
    this.db.setKv(`blocked_until.${p}`, null);
    this.db.setKv(`last_error.${p}`, null);
    for (const m of this.cfg.modelChain(p)) {
      this.db.setKv(`blocked_until.${modelKey(p, m)}`, null);
      this.db.setKv(`last_error.${modelKey(p, m)}`, null);
    }
    bus.overviewChanged();
  }

  // Every model run of a review goes through here: the chosen provider's models first,
  // then (if falling back is on) the other provider's.
  async run(jobId: number, purpose: string, task: RouterTask): Promise<{ provider: Provider; model: string | null; output: unknown }> {
    const providers = this.cfg.providerOrder();
    const preferred = providers[0];
    const firstChoice = this.cfg.modelChain(preferred)[0];
    let lastErr: unknown = null;

    for (const provider of providers) {
      if (this.providerBlockedUntil(provider)) continue;
      for (const model of this.cfg.modelChain(provider)) {
        if (this.modelBlockedUntil(provider, model)) continue;
        const fellBack = provider !== preferred || model !== firstChoice;
        const started = Date.now();
        // Everything this run does is recorded under its key, live, for the job's page.
        const runKey = randomUUID();
        const promptChars = task.instructions.length + task.prompt.length;
        let reportedError = false;
        const step = (s: StepEvent) => {
          reportedError ||= s.kind === 'error';
          this.db.recordStep({ job_id: jobId, run_key: runKey, purpose, provider, model, ...s });
          bus.stepsChanged(jobId);
        };
        step({ ref: null, kind: 'start', title: `Started ${provider} ${model ?? '(default model)'}${fellBack ? ' as a stand-in' : ''}`, status: 'ok' });
        try {
          const run = { ...task, model, onStep: step };
          const res =
            provider === 'claude'
              ? await runClaude(run, { claudeMaxTurns: this.cfg.limits.claudeMaxTurns, claudeEffort: this.cfg.models.claudeEffort })
              : await runCodex(run);
          const u = res.usage;
          this.db.insertRun({
            job_id: jobId, run_key: runKey, purpose, provider, model, ok: 1, fell_back: fellBack ? 1 : 0, duration_ms: res.durationMs, error: null,
            turns: u.turns, tool_calls: u.toolCalls, input_tokens: u.inputTokens, cached_input_tokens: u.cachedInputTokens,
            output_tokens: u.outputTokens, cost_usd: u.costUsd, prompt_chars: promptChars, output: JSON.stringify(res.output),
          });
          bus.stepsChanged(jobId);
          this.db.setKv(`last_error.${modelKey(provider, model)}`, null);
          this.db.setKv(`last_error.${provider}`, null);
          return { provider, model, output: res.output };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.db.insertRun({
            job_id: jobId, run_key: runKey, purpose, provider, model, ok: 0, fell_back: fellBack ? 1 : 0, duration_ms: Date.now() - started, error: message.slice(0, 500),
            turns: null, tool_calls: null, input_tokens: null, cached_input_tokens: null, output_tokens: null, cost_usd: null, prompt_chars: promptChars,
          });
          if (!reportedError) step({ ref: null, kind: 'error', title: message.split('\n')[0].slice(0, 200), detail: message, status: 'failed' });
          if (task.signal?.aborted) throw err;
          if (err instanceof ContentRefused) {
            this.db.event(jobId, `${provider} ${model ?? '(default model)'} declined the ${purpose} pass (flagged by its safety filter); trying the next model`, 'warn');
            lastErr = err;
            continue;
          }
          if (!(err instanceof ProviderUnavailable)) throw err; // a real failure of this run; job retries handle it
          this.block(provider, model, err);
          this.db.event(jobId, `${provider} ${model ?? '(default model)'} unavailable (${err.reason}); trying the next model`, 'warn');
          lastErr = err;
          if (err.reason === 'auth' || err.reason === 'missing') break; // no point trying this provider's other models
        }
      }
    }

    const retryAts = providers.map((p) => this.availableAt(p));
    if (retryAts.every((d) => d !== null)) {
      throw new NoProviderAvailable(new Date(Math.min(...retryAts.map((d) => d!.getTime()))));
    }
    if (lastErr instanceof ContentRefused) throw new ContentRefused(`Every available model declined the ${purpose} pass; the last one was ${lastErr.message}`);
    throw lastErr ?? new Error('no model ran');
  }
}
