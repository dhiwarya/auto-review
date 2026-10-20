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
  return <span className={`badge state-${state}`}>{STATE_LABEL[state]}</span>;
}

const SEV_LABEL: Record<Severity, string> = { blocker: 'Blocker', major: 'Major', minor: 'Minor', nit: 'Nit' };

export function SeverityChip({ severity, count }: { severity: Severity; count?: number }) {
  return (
    <span className={`sev sev-${severity}`} title={SEV_LABEL[severity]}>
      {count !== undefined ? count : SEV_LABEL[severity]}
      {count !== undefined && <span className="sr-only"> {SEV_LABEL[severity]}</span>}
    </span>
  );
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
