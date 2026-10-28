import { SettingsSchema, type Settings } from '../settings-schema.ts';
import type { Finding, Job, StrictReport } from '../types.ts';

export const POLICY_VERSION = 2;
export interface ReviewPolicy { version: number; settings: Settings }

export function readPolicy(job: Job): ReviewPolicy | null {
  try {
    const raw = JSON.parse(job.review_policy ?? 'null');
    if (raw?.version !== POLICY_VERSION && raw?.version !== 1) return null;
    return { version: raw.version, settings: SettingsSchema.parse(raw.settings) };
  } catch { return null; }
}

export function readReport(job: Job): StrictReport | null {
  try {
    const r = JSON.parse(job.review_report ?? 'null');
    return (r?.version === POLICY_VERSION || r?.version === 1) && Array.isArray(r.stages) && Array.isArray(r.gaps) && Array.isArray(r.approvalBlocks) ? r : null;
  } catch { return null; }
}

export function hasStrictCoverage(job: Job | undefined): boolean {
  const policy = job && readPolicy(job);
  if (!job || policy?.version !== POLICY_VERSION || policy.settings.reviewProfile !== 'strict') return false;
  const report = readReport(job);
  return !!report && report.version === POLICY_VERSION && report.complete && !report.gaps.length
    && ['main/', 'security/', 'adversarial/'].every((purpose) => report.stages.some((s) => s.purpose.startsWith(purpose) && s.state === 'done'))
    && report.stages.every((s) => s.state === 'done');
}

export function strictApprovalBlocks(job: Job, findings: Finding[], currentlyStrict = false): string[] {
  const policy = readPolicy(job);
  if (!currentlyStrict && policy?.settings.reviewProfile !== 'strict') return [];
  const blocks: string[] = [];
  if (policy?.settings.reviewProfile !== 'strict') blocks.push('This job has no Strict review policy; run a full Strict review');
  const report = readReport(job);
  if (!report) blocks.push('Strict coverage and completion records are missing');
  else {
    if (report.version !== POLICY_VERSION) blocks.push('This review predates complete-context Strict coverage; run a full Strict review');
    blocks.push(...report.gaps, ...report.approvalBlocks);
    if (!report.complete && !report.gaps.length) blocks.push('Strict review is incomplete');
    for (const purpose of ['main/', 'security/', 'adversarial/']) {
      if (!report.stages.some((s) => s.purpose.startsWith(purpose) && s.state === 'done')) blocks.push(`Required ${purpose.slice(0, -1)} review did not complete`);
    }
    if (report.stages.some((s) => s.state !== 'done')) blocks.push('A required Strict stage is incomplete');
  }
  if (findings.some((f) => f.status !== 'dropped' && (f.severity === 'major' || f.severity === 'blocker'))) blocks.push('Blockers or majors remain open');
  if (findings.some((f) => f.status !== 'dropped' && (f.original_severity === 'major' || f.original_severity === 'blocker') && f.verification !== 'confirmed')) blocks.push('A serious finding has not been confirmed');
  if (job.confidence !== 'high') blocks.push('Strict approval requires high confidence');
  if (!job.spec_status || job.spec_status === 'not_checked' || job.spec_status === 'partial' || job.spec_status === 'misaligned') blocks.push('Requirements have not been fully assessed and aligned');
  return [...new Set(blocks)];
}
