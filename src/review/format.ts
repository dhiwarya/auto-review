import { findingMarker, SIGNATURE } from '../github/publish.ts';
import type { LinkedIssue } from '../github/prs.ts';
import type { Finding, Severity, SpecStatus } from '../types.ts';

// Plain markdown: no emoji, no model details. Every comment ends with the signature.

const SEVERITY_LABEL: Record<Severity, string> = { blocker: 'Blocker', major: 'Major', minor: 'Minor', nit: 'Nit' };
const SEVERITIES: Severity[] = ['blocker', 'major', 'minor', 'nit'];

const heading = (f: Finding) => `**${SEVERITY_LABEL[f.severity]} (${f.category}):** ${f.title}`;
const oneLine = (text: string) => text.replace(/\s*\n+\s*/g, ' ').trim();

export function inlineBody(f: Finding): string {
  return [heading(f), '', f.problem, '', `**Suggestion:** ${f.suggestion}`, '', SIGNATURE, findingMarker(f.id)].join('\n');
}

// "2 blockers, 1 major, 3 minor"
export function countsLine(findings: Finding[]): string {
  return SEVERITIES.map((sev) => ({ sev, n: findings.filter((f) => f.severity === sev).length }))
    .filter((c) => c.n > 0)
    .map(({ sev, n }) => `${n} ${sev}${n > 1 && (sev === 'blocker' || sev === 'nit') ? 's' : ''}`)
    .join(', ');
}

function requirementsLine(status: SpecStatus, notes: string, issues: LinkedIssue[], repo: string): string | null {
  if (status === 'not_checked') return null;
  if (status === 'no_spec' || !issues.length) return 'No linked issue to check against.';
  const refs = issues.map((i) => (i.repo.toLowerCase() === repo.toLowerCase() ? `#${i.number}` : `${i.repo}#${i.number}`)).join(', ');
  const verdict = { aligned: `Matches ${refs}.`, partial: `Partly matches ${refs}.`, misaligned: `Doesn't match ${refs}.` }[status];
  return notes.trim() ? `${verdict} ${oneLine(notes)}` : verdict;
}

export interface SummaryInput {
  repo: string;
  headSha: string;
  summaries: string[];
  specStatus: SpecStatus;
  specNotes: string;
  issues: LinkedIssue[];
  findings: Finding[]; // posted ones (inline + summary)
  questions: string[];
  resolved: Finding[];
  large: boolean;
  excluded: string[];
  inlineFailed: boolean;
  jobId: number;
}

export function summaryBody(s: SummaryInput): string {
  const counts = countsLine(s.findings);
  const out: string[] = [counts ? `**${counts}**` : '**No issues found.**', ''];
  for (const text of s.summaries.map((t) => t.trim()).filter(Boolean)) out.push(text, '');

  const requirements = requirementsLine(s.specStatus, s.specNotes, s.issues, s.repo);
  if (requirements) out.push(`**Requirements:** ${requirements}`, '');

  const general = s.findings.filter((f) => f.status === 'summary');
  if (general.length) {
    out.push(s.inlineFailed ? '**Findings**' : '**Not tied to a changed line**', '');
    for (const f of general) {
      const where = f.file ? ` (\`${f.file}${f.line ? `:${f.line}` : ''}\`)` : '';
      out.push(`- ${heading(f)}${where}`);
      out.push(`  ${oneLine(f.problem)}`);
      out.push(`  Suggestion: ${oneLine(f.suggestion)}`);
      out.push(`  ${findingMarker(f.id)}`);
    }
    out.push('');
  }

  if (s.questions.length) out.push('**Questions**', '', ...s.questions.map((q) => `- ${oneLine(q)}`), '');

  if (s.resolved.length) {
    out.push('**Fixed since the last review**', '', ...s.resolved.map((f) => `- ~~${f.title}~~${f.file ? ` (\`${f.file}\`)` : ''}`), '');
  }

  const notes: string[] = [];
  if (s.large) notes.push('Large change: only the highest risks are covered.');
  if (s.excluded.length) notes.push(`Skipped ${s.excluded.length} generated or lock file${s.excluded.length > 1 ? 's' : ''}.`);
  if (notes.length) out.push(notes.join(' '), '');

  out.push(SIGNATURE, `<!-- ai-review sha=${s.headSha} job=${s.jobId} -->`);
  return out.join('\n');
}

export interface RecheckInput {
  headSha: string;
  summary: string;
  open: { finding: Finding; reason: string }[];
  resolved: { finding: Finding; reason: string }[];
  jobId: number;
}

// A re-check after the review was requested again without new commits: which earlier
// findings are still open, and which turned out not to hold.
export function recheckBody(r: RecheckInput): string {
  const lead = `**No new commits since the last review (\`${r.headSha.slice(0, 7)}\`).**`;
  const out: string[] = [];
  if (r.open.length) {
    const n = r.open.length;
    out.push(`${lead} ${n} finding${n > 1 ? 's' : ''} from earlier reviews ${n > 1 ? 'are' : 'is'} still open: ${countsLine(r.open.map((o) => o.finding))}.`, '');
  } else {
    out.push(`${lead} ${r.resolved.length ? 'Every finding from earlier reviews is resolved.' : 'No findings from earlier reviews are open.'}`, '');
  }
  if (r.summary.trim()) out.push(r.summary.trim(), '');

  if (r.open.length) {
    out.push('**Still open**', '');
    for (const { finding: f, reason } of r.open) {
      out.push(`- ${heading(f)}${f.file ? ` (\`${f.file}${f.line ? `:${f.line}` : ''}\`)` : ''}`);
      if (reason.trim()) out.push(`  ${oneLine(reason)}`);
    }
    out.push('');
  }
  if (r.resolved.length) {
    out.push('**Resolved**', '');
    for (const { finding: f, reason } of r.resolved) out.push(`- ~~${f.title}~~${f.file ? ` (\`${f.file}\`)` : ''}${reason.trim() ? `: ${oneLine(reason)}` : ''}`);
    out.push('');
  }

  out.push(SIGNATURE, `<!-- ai-review sha=${r.headSha} job=${r.jobId} recheck -->`);
  return out.join('\n');
}
