import type { LinkedIssue } from '../github/prs.ts';
import type { StrictReviewOut } from './schema.ts';

type Requirement = StrictReviewOut['requirements'][number];
export const criterionKey = (r: Requirement) => `${r.ref.toLowerCase()}:${r.criterion.trim().replace(/\s+/g, ' ').toLowerCase()}`;
const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();

// Context-document IDs identify provenance; requirements belong to their parent issue.
// Resolve only known issues and real comment ordinals, never by stripping arbitrary suffixes.
export function canonicalRequirements(issues: LinkedIssue[], requirements: Requirement[]): Requirement[] {
  return requirements.map((r) => {
    const supplied = r.ref.trim().replace(/^issue:/i, '');
    const issue = issues.find((i) => {
      const ref = `${i.repo}#${i.number}`;
      if (supplied.toLowerCase() === ref.toLowerCase()) return true;
      const comment = /^(.*):comment-([1-9]\d*)$/i.exec(supplied);
      if (comment?.[1].toLowerCase() === ref.toLowerCase() && Number(comment[2]) <= i.comments.length) return true;
      return !!i.url && (supplied === i.url || supplied.startsWith(`${i.url}#issuecomment-`) && /^\d+$/.test(supplied.slice(`${i.url}#issuecomment-`.length)));
    });
    return { ...r, ref: issue ? `${issue.repo}#${issue.number}` : r.ref };
  });
}

export function requirementAssessmentGaps(issues: LinkedIssue[], requirements: Requirement[], terminal: boolean): string[] {
  const gaps: string[] = [];
  for (const r of requirements) {
    if (!issues.some((i) => `${i.repo}#${i.number}`.toLowerCase() === r.ref.toLowerCase())) gaps.push(`Unknown issue ref ${r.ref}; use an exact parent issue ref from the manifest`);
    if (requirements.filter((other) => criterionKey(other) === criterionKey(r)).length > 1) gaps.push(`Duplicate assessment for ${r.ref}: ${r.criterion}; return one consolidated verdict`);
    if (terminal && r.status === 'not_checked') gaps.push(`Unfinished assessment for ${r.ref}: ${r.criterion}; inspect the source and code and return a final status`);
  }
  if (terminal) for (const i of issues) {
    const ref = `${i.repo}#${i.number}`;
    if (!requirements.some((r) => r.ref.toLowerCase() === ref.toLowerCase())) gaps.push(`Missing assessment for ${ref}; read its full issue and comments and return its applicable criteria`);
  }
  return [...new Set(gaps)];
}

export function requirementBlocks(issues: LinkedIssue[], final: Requirement[], independent: Requirement[]): string[] {
  const blocks: string[] = [];
  for (const issue of issues) {
    const ref = `${issue.repo}#${issue.number}`;
    const entries = final.filter((r) => r.ref.toLowerCase() === ref.toLowerCase());
    if (!entries.length) { blocks.push(`Requirement ${ref} has no completed scope assessment`); continue; }
    const source = normalize(`${issue.title}\n${issue.body}\n${issue.comments.map((c) => c.body).join('\n')}`);
    for (const r of entries) {
      const label = `Requirement ${ref}: ${r.criterion}`;
      if (!r.criterion.trim() || !source.includes(normalize(r.criterion)) || !r.reason.trim()) {
        blocks.push(`${label} lacks a source-backed criterion and reason`); continue;
      }
      if (entries.filter((e) => criterionKey(e) === criterionKey(r)).length !== 1) { blocks.push(`${label} has duplicate or contradictory assessments`); continue; }
      if (r.status === 'missing' || r.status === 'externally_unverifiable' || r.status === 'not_checked') {
        blocks.push(`${label} is ${r.status.replace(/_/g, ' ')}`); continue;
      }
      const others = independent.filter((e) => criterionKey(e) === criterionKey(r));
      if (others.some((e) => e.status === 'missing' || e.status === 'externally_unverifiable')) blocks.push(`${label} has an unresolved independent-review disagreement`);
      if (r.status === 'out_of_scope' || r.status === 'deferred') {
        const quote = normalize(r.scope_evidence);
        if (issue.linkedBy === 'closes' || !quote || !source.includes(quote) || !others.some((e) => e.status === r.status && normalize(e.scope_evidence) && source.includes(normalize(e.scope_evidence)))) {
          blocks.push(`${label} cannot be excluded without source evidence and independent agreement; closing issues require their full promised scope`);
        }
      }
    }
  }
  for (const entry of final) if (!issues.some((i) => `${i.repo}#${i.number}`.toLowerCase() === entry.ref.toLowerCase())) blocks.push(`Requirement ${entry.ref} was not part of the retrieved issue manifest`);
  return [...new Set(blocks)];
}
