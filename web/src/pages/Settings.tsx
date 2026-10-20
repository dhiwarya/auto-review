import { useEffect, useState } from 'react';
import type { Overview } from '../../../src/types.ts';
import { getJson, postJson } from '../api.ts';
import { clockTime } from '../ui.tsx';

export function SettingsPage({ overview }: { overview: Overview | null }) {
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    getJson<Record<string, unknown>>('/api/config').then(setConfig).catch(() => {});
  }, []);

  return (
    <div className="stack">
      <section>
        <h2>Models</h2>
        <div className="grid">
          {overview?.providers.map((p) => (
            <div key={p.provider} className="card">
              <div className="card-top">
                <strong>{p.provider === 'claude' ? 'Claude Code' : 'Codex'}</strong>
                <span className={`pill push ${p.blocked_until ? 'pill-warn' : 'pill-ok'}`}>
                  <span className="dot" />
                  {p.blocked_until ? `paused until ${clockTime(p.blocked_until)}` : 'ready'}
                </span>
              </div>
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
          ))}
        </div>
      </section>

      <section>
        <h2>Configuration</h2>
        <p className="muted small">
          Read-only here. Edit <code>{String(config?.configPath ?? 'reviewer.config.json')}</code> and restart the app to change
          it.
        </p>
        <pre className="preview">{config ? JSON.stringify(config, null, 2) : 'Loading…'}</pre>
      </section>
    </div>
  );
}
