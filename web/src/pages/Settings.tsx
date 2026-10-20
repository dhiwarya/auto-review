import { useEffect, useState } from 'react';
import type { Overview, Provider, ProviderStatus, ReviewerSettings } from '../../../src/types.ts';
import { getJson, postJson } from '../api.ts';
import { clockTime } from '../ui.tsx';

const NAME: Record<Provider, string> = { codex: 'Codex', claude: 'Claude' };
const other = (p: Provider): Provider => (p === 'codex' ? 'claude' : 'codex');

function ModelChain({ p, role }: { p: ProviderStatus; role: string }) {
  return (
    <div className="card">
      <div className="card-top">
        <strong>{p.provider === 'claude' ? 'Claude Code' : 'Codex'}</strong>
        <span className="muted small">{role}</span>
        <span className={`pill push ${p.blocked_until ? 'pill-warn' : 'pill-ok'}`}>
          <span className="dot" />
          {p.blocked_until ? `paused until ${clockTime(p.blocked_until)}` : 'ready'}
        </span>
      </div>
      <ol className="model-chain small">
        {p.models.map((m, i) => (
          <li key={`${m.model}-${i}`}>
            <code>{m.model ?? '(CLI default)'}</code>
            <span className="muted">{i === 0 ? ' · first choice' : ' · fallback'}</span>
            {m.blocked_until ? (
              <span className="warn-text" title={m.last_error ?? undefined}>
                {' '}
                · paused until {clockTime(m.blocked_until)}
              </span>
            ) : (
              p.active_model === m.model && <span className="ok-text"> · in use</span>
            )}
          </li>
        ))}
      </ol>
      {p.last_error && <p className="small error">{p.last_error}</p>}
      <p className="small muted">
        {p.provider === 'claude'
          ? 'Uses your Claude subscription through the claude CLI. Sign in with: claude auth login'
          : 'Uses your ChatGPT plan through the codex CLI. Sign in with: codex login'}
      </p>
      {p.blocked_until && (
        <button className="btn btn-small btn-ghost" onClick={() => postJson(`/api/providers/${p.provider}/reset`)}>
          Try again now
        </button>
      )}
    </div>
  );
}

function ReviewerControls({ settings }: { settings: ReviewerSettings }) {
  const [state, setState] = useState<{ saving: boolean; message: string | null; error: boolean }>({ saving: false, message: null, error: false });

  const save = async (patch: Partial<ReviewerSettings>) => {
    setState({ saving: true, message: null, error: false });
    try {
      await postJson('/api/settings', patch);
      setState({ saving: false, message: 'Saved. Applies from the next model run.', error: false });
    } catch (err) {
      setState({ saving: false, message: err instanceof Error ? err.message : String(err), error: true });
    }
  };

  const backup = other(settings.provider);
  return (
    <div className="card settings-card">
      <div>
        <div className="field-label">Who reviews</div>
        <div className="segmented" role="radiogroup" aria-label="Review provider">
          {(['codex', 'claude'] as Provider[]).map((p) => (
            <button
              key={p}
              role="radio"
              aria-checked={settings.provider === p}
              className={settings.provider === p ? 'active' : ''}
              disabled={state.saving}
              onClick={() => settings.provider !== p && save({ provider: p })}
            >
              {NAME[p]}
            </button>
          ))}
        </div>
        <p className="small muted">One provider does the whole review: the code and requirements pass, the security pass and the double-check.</p>
      </div>

      <label className="check">
        <input
          type="checkbox"
          checked={settings.fallbackToOther}
          disabled={state.saving}
          onChange={(e) => save({ fallbackToOther: e.target.checked })}
        />
        <span>
          If {NAME[settings.provider]} runs out, use {NAME[backup]} instead
          <span className="small muted block">
            When every {NAME[settings.provider]} model hits its usage limit or you're signed out. Off: reviews wait until{' '}
            {NAME[settings.provider]} is available again.
          </span>
        </span>
      </label>

      <label className="check">
        <input type="checkbox" checked={settings.doubleCheck} disabled={state.saving} onChange={(e) => save({ doubleCheck: e.target.checked })} />
        <span>
          Double-check blockers and majors before posting
          <span className="small muted block">A second, separate run re-reads the code for each serious finding and drops the ones it can't confirm.</span>
        </span>
      </label>

      {state.message && <div className={`small ${state.error ? 'error' : 'ok-text'}`}>{state.message}</div>}
    </div>
  );
}

export function SettingsPage({ overview }: { overview: Overview | null }) {
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    getJson<Record<string, unknown>>('/api/config').then(setConfig).catch(() => {});
  }, [overview?.settings.provider, overview?.settings.fallbackToOther, overview?.settings.doubleCheck]);

  const settings = overview?.settings;
  const byProvider = new Map(overview?.providers.map((p) => [p.provider, p]));
  const order: Provider[] = settings ? [settings.provider, other(settings.provider)] : [];

  return (
    <div className="stack">
      <section>
        <h2>Reviewer</h2>
        {settings ? <ReviewerControls settings={settings} /> : <p className="empty">Loading…</p>}
      </section>

      <section>
        <h2>Models</h2>
        <div className="grid">
          {order.map((p, i) => {
            const status = byProvider.get(p);
            if (!status) return null;
            const role = i === 0 ? 'reviews' : settings!.fallbackToOther ? 'backup' : 'not used';
            return <ModelChain key={p} p={status} role={role} />;
          })}
        </div>
        <p className="small muted">
          Models are tried in order. Change them under <code>models.codex</code> and <code>models.claude</code> in the config file.
        </p>
      </section>

      <section>
        <h2>Configuration</h2>
        <p className="muted small">
          Everything else is read-only here. Edit <code>{String(config?.configPath ?? 'reviewer.config.json')}</code> and restart the
          app to change it.
        </p>
        <pre className="preview">{config ? JSON.stringify(config, null, 2) : 'Loading…'}</pre>
      </section>
    </div>
  );
}
