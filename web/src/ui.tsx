import { useEffect, useState } from 'react';
import type { JobState, Severity } from '../../src/types.ts';

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const s = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < -60) return `in ${duration(-s * 1000)}`;
  if (s < 45) return 'just now';
  return `${duration(s * 1000)} ago`;
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
}

export const clockTime = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const STATE_LABEL: Record<JobState, string> = {
  queued: 'Queued',
  running: 'Reviewing',
  waiting: 'Waiting',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
};

export function StateBadge({ state }: { state: JobState }) {
  return <span className={`state state-${state}`}>{STATE_LABEL[state]}</span>;
}

const SEV_LABEL: Record<Severity, string> = { blocker: 'Blocker', major: 'Major', minor: 'Minor', nit: 'Nit' };

// "Blocker", or with a count, "2 blockers".
export function SeverityChip({ severity, count }: { severity: Severity; count?: number }) {
  const label = SEV_LABEL[severity];
  const text = count === undefined ? label : `${count} ${label.toLowerCase()}${count === 1 || severity === 'major' || severity === 'minor' ? '' : 's'}`;
  return <span className={`sev sev-${severity}`}>{text}</span>;
}

export function SeverityCounts({ counts }: { counts?: Record<Severity, number> }) {
  if (!counts) return null;
  const items = (['blocker', 'major', 'minor', 'nit'] as Severity[]).filter((s) => counts[s] > 0);
  if (!items.length) return <span className="muted">none</span>;
  return (
    <span className="sev-row">
      {items.map((s) => (
        <SeverityChip key={s} severity={s} count={counts[s]} />
      ))}
    </span>
  );
}

export function Progress({ value }: { value: number }) {
  return (
    <div className="progress" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
      <div style={{ width: `${Math.max(3, Math.min(100, value))}%` }} />
    </div>
  );
}

export const shortSha = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : '');

// 41234 -> "41.2k"
export function compact(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

// Light or dark. Follows the system until you pick one; index.html applies the saved
// choice before the page draws.
type Theme = 'light' | 'dark';
const THEME_KEY = 'auto-reviewer.theme';
const darkQuery = () => window.matchMedia('(prefers-color-scheme: dark)');

function savedTheme(): Theme | null {
  try {
    const t = localStorage.getItem(THEME_KEY);
    return t === 'light' || t === 'dark' ? t : null;
  } catch {
    return null;
  }
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => savedTheme() ?? (darkQuery().matches ? 'dark' : 'light'));
  useEffect(() => {
    const q = darkQuery();
    const on = () => savedTheme() === null && setTheme(q.matches ? 'dark' : 'light');
    q.addEventListener('change', on);
    return () => q.removeEventListener('change', on);
  }, []);
  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  const toggle = () => {
    document.documentElement.dataset.theme = next;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Private windows can refuse storage; the switch still works until reload.
    }
    setTheme(next);
  };
  return (
    <button type="button" className="icon-btn" onClick={toggle} aria-label={`Switch to ${next} mode`} title={`Switch to ${next} mode`}>
      {theme === 'dark' ? (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
        </svg>
      )}
    </button>
  );
}
