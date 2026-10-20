import { findingMarker } from '../github/publish.ts';
import type { LinkedIssue } from '../github/prs.ts';
import type { Finding, Severity, SpecStatus } from '../types.ts';

const SEVERITY_LABEL: Record<Severity, string> = {
  blocker: '🔴 Blocker',
  major: '🟠 Major',
  minor: '🟡 Minor',
  nit: '⚪ Nit',
};

const SPEC_LABEL: Record<SpecStatus, string> = {
  aligned: '✅ Matches the linked issue',
  partial: '🟡 Partly matches the linked issue',
  misaligned: '🔴 Doesn\'t match the linked issue',
  no_spec: '➖ No linked issue to compare against',
  not_checked: '➖ Not checked',
};

const PROVIDER_NAME = { claude: 'Claude', codex: 'Codex' } as const;

function provenance(f: Finding): string {
  const who = f.model_id ? `${PROVIDER_NAME[f.model]} (${f.model_id})` : PROVIDER_NAME[f.model];
  const parts = [`AI-assisted · ${who}`, `confidence ${f.confidence}`];
  if (f.verification === 'confirmed') parts.push(`confirmed by ${PROVIDER_NAME[f.verified_by ?? f.model]}`);
  if (f.verification === 'uncertain') parts.push(`unconfirmed by ${PROVIDER_NAME[f.verified_by ?? f.model]}`);
  return parts.join(' · ');
}

export function inlineBody(f: Finding): string {
  return [
    `**${SEVERITY_LABEL[f.severity]} · ${f.category}**: ${f.title}`,
    '',
    f.problem,
    '',
    `**Suggestion:** ${f.suggestion}`,
    '',
    `<sub>${provenance(f)}</sub>`,
    findingMarker(f.id),
  ].join('\n');
}

export interface SummaryInput {
  headSha: string;
  sinceSha: string | null;
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
  const out: string[] = ['## 🤖 AI-assisted review', ''];
  out.push(...s.summaries.filter(Boolean).map((t) => `${t}\n`));

  const issueRefs = s.issues.map((i) => `[${i.repo}#${i.number}](${i.url})`).join(', ');
  out.push(`**Requirements:** ${SPEC_LABEL[s.specStatus]}${issueRefs ? ` (${issueRefs})` : ''}${s.specNotes ? `. ${s.specNotes}` : ''}`, '');

  const counts = (['blocker', 'major', 'minor', 'nit'] as Severity[])
    .map((sev) => ({ sev, n: s.findings.filter((f) => f.severity === sev).length }))
    .filter((c) => c.n > 0);
  out.push(counts.length ? `**Findings:** ${counts.map((c) => `${SEVERITY_LABEL[c.sev]} ${c.n}`).join(' · ')}` : '**Findings:** none worth raising.', '');

  const general = s.findings.filter((f) => f.status === 'summary');
  if (general.length) {
    out.push(s.inlineFailed ? '### Findings' : '### Findings not tied to a changed line', '');
    for (const f of general) {
      const where = f.file ? `\`${f.file}${f.line ? `:${f.line}` : ''}\`` : '';
      out.push(`- **${SEVERITY_LABEL[f.severity]} · ${f.category}** ${where}: ${f.title}`);
      out.push(`  ${f.problem.replace(/\n+/g, ' ')}`);
      out.push(`  *Suggestion:* ${f.suggestion.replace(/\n+/g, ' ')} <sub>${provenance(f)}</sub>`);
      out.push(`  ${findingMarker(f.id)}`);
    }
    out.push('');
  }

  if (s.questions.length) {
    out.push('### Questions for the author', '', ...s.questions.map((q) => `- ${q}`), '');
  }

  if (s.resolved.length) {
    out.push('### Fixed since the last review', '', ...s.resolved.map((f) => `- ~~${f.title}~~ (\`${f.file}\`)`), '');
  }

  const notes: string[] = [];
  if (s.large) notes.push('Large change: this review covers the highest risks only.');
  if (s.excluded.length) notes.push(`Skipped ${s.excluded.length} generated or lock file(s).`);
  const scope = s.sinceSha ? `changes ${s.sinceSha.slice(0, 7)}..${s.headSha.slice(0, 7)}` : `commit ${s.headSha.slice(0, 7)}`;
  notes.push(`Reviewed ${scope}.`);
  out.push(`<sub>${notes.join(' ')}</sub>`);
  out.push(`<!-- ai-review sha=${s.headSha} job=${s.jobId} -->`);
  return out.join('\n');
}
