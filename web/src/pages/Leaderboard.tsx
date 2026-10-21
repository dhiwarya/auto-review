import { useEffect, useState } from 'react';
import type { Leaderboard, LeaderboardKind } from '../../../src/types.ts';
import { getJson, useStream } from '../api.ts';
import { compact, duration } from '../ui.tsx';

const TABS: { kind: LeaderboardKind; label: string; blurb: string; keyLabel: string; defaultSort: string }[] = [
  {
    kind: 'models',
    label: 'Models',
    blurb: 'How each model performs per pass. Keep rate is the share of its comments you kept when submitting a draft.',
    keyLabel: 'Model · pass',
    defaultSort: 'keep_rate',
  },
  {
    kind: 'repos',
    label: 'Repos',
    blurb: 'Where the risk is. Clean PRs had no blocker or major finding.',
    keyLabel: 'Repository',
    defaultSort: 'blockers',
  },
  {
    kind: 'authors',
    label: 'Authors',
    blurb: 'Whose PRs come through clean. Only visible here, on your machine.',
    keyLabel: 'Author',
    defaultSort: 'clean_rate',
  },
];

function fmt(value: string | number | null, format?: 'pct' | 'num' | 'ms' | 'tokens') {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string') return value;
  if (format === 'pct') return `${Math.round(value * 100)}%`;
  if (format === 'ms') return duration(value);
  if (format === 'tokens') return compact(value);
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

export function LeaderboardPage({ kind }: { kind: LeaderboardKind }) {
  const tab = TABS.find((t) => t.kind === kind) ?? TABS[0];
  const [data, setData] = useState<Leaderboard | null>(null);
  const [sort, setSort] = useState<{ key: string; desc: boolean }>({ key: tab.defaultSort, desc: true });
  const [version, setVersion] = useState(0);

  useEffect(() => setSort({ key: tab.defaultSort, desc: true }), [tab.defaultSort]);
  useEffect(() => {
    setData(null);
    getJson<Leaderboard>(`/api/leaderboard/${tab.kind}`).then(setData).catch(() => {});
  }, [tab.kind]);
  useEffect(() => {
    if (version) getJson<Leaderboard>(`/api/leaderboard/${tab.kind}`).then(setData).catch(() => {});
  }, [version, tab.kind]);
  // Refresh when a review finishes.
  useStream((m) => m.type === 'job' && m.job.state === 'done' && setVersion((v) => v + 1));

  const rows = [...(data?.rows ?? [])].sort((a, b) => {
    const av = a[sort.key];
    const bv = b[sort.key];
    if (av === bv) return 0;
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
    return sort.desc ? -cmp : cmp;
  });

  const header = (key: string, label: string, hint?: string) => (
    <th title={hint}>
      <button className="sort" onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : true }))}>
        {label}
        {sort.key === key ? (sort.desc ? ' ↓' : ' ↑') : ''}
      </button>
    </th>
  );

  return (
    <div className="stack">
      <div className="page-intro">
        <nav className="subtabs" aria-label="Leaderboards">
          {TABS.map((t) => (
            <a key={t.kind} href={`#/leaderboard/${t.kind}`} className={t.kind === tab.kind ? 'active' : ''}>
              {t.label}
            </a>
          ))}
        </nav>
        <p className="muted">{tab.blurb}</p>
      </div>
      {!data ? (
        <p className="empty">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="empty">No finished reviews yet. This fills in as reviews complete.</p>
      ) : (
        <div className="table-wrap">
          <table className="table numeric">
            <thead>
              <tr>
                {header('key', tab.keyLabel)}
                {data.columns.map((c) => header(c.key, c.label, c.hint))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.key}>
                  <td className="key-cell">
                    <span className="rank">{i + 1}</span>
                    {tab.kind === 'authors' ? `@${r.key}` : r.key}
                  </td>
                  {data.columns.map((c) => (
                    <td key={c.key}>{fmt(r[c.key], c.format)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
