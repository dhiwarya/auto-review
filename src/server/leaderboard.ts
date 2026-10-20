import type { Db } from '../db.ts';
import type { Leaderboard, LeaderboardKind, LeaderboardRow } from '../types.ts';

const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

function models(db: Db): Leaderboard {
  const findings = db.all<{
    model: string; pass: string; raised: number; posted: number; refuted: number; bad_evidence: number;
    blockers: number; confirmed_blockers: number; kept: number; deleted: number;
  }>(`
    SELECT COALESCE(model_id, model) AS model, pass,
      COUNT(*) AS raised,
      SUM(status != 'dropped') AS posted,
      SUM(verification = 'refuted') AS refuted,
      SUM(drop_reason LIKE 'quoted evidence%' OR drop_reason LIKE 'file not found%') AS bad_evidence,
      SUM(status != 'dropped' AND severity = 'blocker') AS blockers,
      SUM(status != 'dropped' AND original_severity = 'blocker' AND verification = 'confirmed') AS confirmed_blockers,
      SUM(outcome IN ('kept', 'edited')) AS kept,
      SUM(outcome = 'deleted') AS deleted
    FROM findings GROUP BY COALESCE(model_id, model), pass`);
  const runs = db.all<{ provider: string; purpose: string; runs: number; avg_ms: number; failed: number; fallbacks: number }>(`
    SELECT COALESCE(model, provider) AS provider, purpose, COUNT(*) AS runs, AVG(CASE WHEN ok = 1 THEN duration_ms END) AS avg_ms,
      SUM(ok = 0) AS failed, SUM(fell_back) AS fallbacks
    FROM runs GROUP BY COALESCE(model, provider), purpose`);

  const rows = new Map<string, LeaderboardRow>();
  const row = (provider: string, pass: string) => {
    const key = `${provider} · ${pass}`;
    if (!rows.has(key)) {
      rows.set(key, { key, runs: 0, avg_ms: null, failed: 0, fallbacks: 0, raised: 0, posted: 0, refuted: 0, bad_evidence: 0, blockers: 0, kept: 0, deleted: 0, keep_rate: null });
    }
    return rows.get(key)!;
  };
  for (const r of runs) Object.assign(row(r.provider, r.purpose), { runs: r.runs, avg_ms: r.avg_ms, failed: r.failed, fallbacks: r.fallbacks });
  for (const f of findings) {
    Object.assign(row(f.model, f.pass), {
      raised: f.raised, posted: f.posted, refuted: f.refuted, bad_evidence: f.bad_evidence,
      blockers: f.blockers, kept: f.kept, deleted: f.deleted, keep_rate: ratio(f.kept, f.kept + f.deleted),
    });
  }

  return {
    kind: 'models',
    columns: [
      { key: 'runs', label: 'Runs', format: 'num' },
      { key: 'avg_ms', label: 'Avg time', format: 'ms' },
      { key: 'failed', label: 'Failed', format: 'num' },
      { key: 'fallbacks', label: 'Stood in', hint: 'Runs where this model covered for the first-choice model', format: 'num' },
      { key: 'raised', label: 'Raised', format: 'num' },
      { key: 'posted', label: 'Posted', hint: 'Survived verification and the code checks', format: 'num' },
      { key: 'refuted', label: 'Refuted', hint: 'Rejected by the double-check', format: 'num' },
      { key: 'bad_evidence', label: 'Bad evidence', hint: 'Quoted code or file that doesn\'t exist', format: 'num' },
      { key: 'blockers', label: 'Blockers', format: 'num' },
      { key: 'kept', label: 'You kept', format: 'num' },
      { key: 'deleted', label: 'You deleted', format: 'num' },
      { key: 'keep_rate', label: 'Keep rate', hint: 'Kept ÷ (kept + deleted) in submitted drafts', format: 'pct' },
    ],
    rows: [...rows.values()],
  };
}

function groupedBy(db: Db, field: 'repo' | 'author'): LeaderboardRow[] {
  const perPr = db.all<{
    key: string; repo: string; pr_number: number; reviews: number; findings: number; blockers: number;
    serious: number; security: number; requirement: number; kept: number; deleted: number;
  }>(`
    SELECT j.${field} AS key, j.repo, j.pr_number,
      COUNT(DISTINCT j.id) AS reviews,
      COALESCE(SUM(f.status != 'dropped'), 0) AS findings,
      COALESCE(SUM(f.status != 'dropped' AND f.severity = 'blocker'), 0) AS blockers,
      COALESCE(SUM(f.status != 'dropped' AND f.severity IN ('blocker', 'major')), 0) AS serious,
      COALESCE(SUM(f.status != 'dropped' AND f.category = 'security'), 0) AS security,
      COALESCE(SUM(f.status != 'dropped' AND f.category = 'requirement'), 0) AS requirement,
      COALESCE(SUM(f.outcome IN ('kept', 'edited')), 0) AS kept,
      COALESCE(SUM(f.outcome = 'deleted'), 0) AS deleted
    FROM jobs j LEFT JOIN findings f ON f.job_id = j.id
    WHERE j.state = 'done'
    GROUP BY j.${field}, j.repo, j.pr_number`);

  const rows = new Map<string, { prs: number; reviews: number; findings: number; blockers: number; clean: number; security: number; requirement: number; kept: number; deleted: number }>();
  for (const p of perPr) {
    const r = rows.get(p.key) ?? { prs: 0, reviews: 0, findings: 0, blockers: 0, clean: 0, security: 0, requirement: 0, kept: 0, deleted: 0 };
    r.prs++;
    r.reviews += p.reviews;
    r.findings += p.findings;
    r.blockers += p.blockers;
    r.security += p.security;
    r.requirement += p.requirement;
    r.kept += p.kept;
    r.deleted += p.deleted;
    if (p.serious === 0) r.clean++;
    rows.set(p.key, r);
  }
  return [...rows.entries()].map(([key, r]) => ({
    key,
    prs: r.prs,
    reviews: r.reviews,
    clean_rate: ratio(r.clean, r.prs),
    findings_per_pr: ratio(r.findings, r.prs),
    blockers: r.blockers,
    security: r.security,
    requirement: r.requirement,
    keep_rate: ratio(r.kept, r.kept + r.deleted),
  }));
}

const groupedColumns: Leaderboard['columns'] = [
  { key: 'prs', label: 'PRs', format: 'num' },
  { key: 'reviews', label: 'Reviews', hint: 'Including follow-ups after new commits', format: 'num' },
  { key: 'clean_rate', label: 'Clean PRs', hint: 'PRs with no blocker or major finding', format: 'pct' },
  { key: 'findings_per_pr', label: 'Findings / PR', format: 'num' },
  { key: 'blockers', label: 'Blockers', format: 'num' },
  { key: 'security', label: 'Security', format: 'num' },
  { key: 'requirement', label: 'Requirement gaps', format: 'num' },
  { key: 'keep_rate', label: 'Keep rate', hint: 'How often you kept the bot\'s comments here', format: 'pct' },
];

export function leaderboard(db: Db, kind: LeaderboardKind): Leaderboard {
  if (kind === 'models') return models(db);
  return { kind, columns: groupedColumns, rows: groupedBy(db, kind === 'repos' ? 'repo' : 'author') };
}
