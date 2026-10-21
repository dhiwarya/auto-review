import type { Confidence, Finding, SpecStatus } from '../types.ts';

// How sure a review is that nothing blocks the PR. It starts at high and anything that
// leaves doubt lowers it; open blockers are counted separately because they always stop
// an approval, whatever the confidence.

const RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

export const atLeast = (level: Confidence, min: Confidence) => RANK[level] >= RANK[min];

export interface ConfidenceInput {
  findings: Finding[]; // this review's posted findings
  openEarlier: Finding[]; // findings from earlier reviews of the PR that are still open
  specStatus: SpecStatus;
  questions: number;
  large: boolean;
  truncated: boolean;
  injection: boolean; // a model tried to output a credential that isn't in the PR
  passes: { level: Confidence; reason: string }[]; // each pass's own rating
}

export interface Assessment {
  level: Confidence;
  reasons: string[]; // what lowered it
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function assess(i: ConfidenceInput): Assessment {
  let level: Confidence = 'high';
  const reasons: string[] = [];
  const lower = (to: Confidence, why: string) => {
    if (RANK[to] < RANK[level]) level = to;
    reasons.push(why);
  };

  const majors = [...i.findings, ...i.openEarlier].filter((f) => f.severity === 'major').length;
  if (majors) lower('medium', `${plural(majors, 'major finding')} open`);
  if (i.specStatus === 'misaligned') lower('low', "Doesn't match the linked issue");
  if (i.specStatus === 'partial') lower('medium', 'Only partly matches the linked issue');
  if (i.questions) lower('medium', `${plural(i.questions, 'open question')} for the author`);
  if (i.large) lower('medium', 'Large change: only the highest risks were reviewed');
  if (i.truncated) lower('medium', 'The diff was too long to send in full');
  if (i.injection) lower('low', 'The PR tried to get a credential out of the reviewer');
  for (const p of i.passes) {
    if (p.level !== 'high') lower(p.level, p.reason.trim() || `A review pass rated its confidence ${p.level}`);
  }
  return { level, reasons };
}

export const openBlockers = (findings: Finding[]) => findings.filter((f) => f.status !== 'dropped' && f.severity === 'blocker').length;
