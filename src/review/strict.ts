import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db.ts';
import type { Router, RouterTask } from '../llm/router.ts';
import { NoProviderAvailable } from '../llm/router.ts';
import type { SettingsStore } from '../settings.ts';
import type { Job, Pass, Provider, StrictReport, StrictStage } from '../types.ts';
import type { ReviewContext } from './context.ts';
import { strictInstructions, verifyInstructions } from './prompts.ts';
import { POLICY_VERSION, hasStrictCoverage } from './policy.ts';
import { StrictReviewOut, strictSchemaForIssues, VerifyOut, verifySchema, type ReviewOut } from './schema.ts';
import { addedTextOf, minSeverity, placeFindings, scrubText, type Candidate, type PlaceOptions } from './validate.ts';
import { canonicalRequirements, criterionKey, requirementAssessmentGaps, requirementBlocks } from './requirements.ts';
import { untrusted } from './sources.ts';

export interface Section { id: string; file: string; patch: string; kind?: 'code' | 'context'; sourceId?: string; start?: number; end?: number }
export interface Batch { id: string; sections: Section[]; prompt: string }
const renderSections = (sections: Section[]) => sections.map((s) => `## Assigned section ${s.id}\n${s.kind === 'context' ? `Context document: ${s.file}; character range [${s.start}, ${s.end})` : `File: ${s.file}`}\n${untrusted(s.kind === 'context' ? 'context-document' : 'diff', s.patch)}`).join('\n\n');
export class StrictReviewWaiting extends Error {
  readonly retryAt: Date;
  constructor(retryAt: Date) { super('Strict review is incomplete; completed stages are saved and missing stages will retry'); this.retryAt = retryAt; }
}
export class StrictReviewIncomplete extends Error {}

// Hunk fragments have stable identities. Every fragment must be accounted for, even when
// a file has no textual patch or the workload budget prevents assigning another batch.
export function makeBatches(ctx: ReviewContext, cfg: SettingsStore): { batches: Batch[]; sections: Section[]; gaps: string[] } {
  const context = ctx.contextPrompt ?? ctx.prompt;
  const room = cfg.strict.maxDiffChars - context.length - 12_000;
  const fragmentSize = Math.max(1000, Math.floor(room / 2));
  const sections: Section[] = [];
  const gaps: string[] = [];
  for (const source of ctx.sources ?? []) {
    for (let start = 0; start < Math.max(source.text.length, 1); start += fragmentSize) {
      const end = Math.min(source.text.length, start + fragmentSize);
      sections.push({ id: `context:${source.id}:${start}-${end}`, file: source.path ?? source.title, patch: source.text.slice(start, end), kind: 'context', sourceId: source.id, start, end });
    }
  }
  for (const file of ctx.reviewFiles.filter((f) => !cfg.isExcludedFile(f.filename))) {
    if (!file.patch) {
      sections.push({ id: `${file.filename}:no-patch`, file: file.filename, patch: '(No textual diff. Read the file in the checkout; if unavailable mark unverified.)' });
      continue;
    }
    const hunks = file.patch.split(/(?=^@@ )/m).filter(Boolean);
    for (const [h, hunk] of hunks.entries()) {
      let fragment = ''; let part = 0;
      const push = () => {
        sections.push({ id: `${file.filename}:h${h + 1}:p${++part}`, file: file.filename, patch: fragment });
        fragment = '';
      };
      for (const line of hunk.split('\n')) {
        if (fragment && fragment.length + line.length + 1 > fragmentSize) push();
        // Even an enormous single line is bounded; every piece keeps a manifest entry.
        for (let offset = 0; offset < Math.max(line.length, 1); offset += fragmentSize) {
          const piece = line.slice(offset, offset + fragmentSize);
          if (fragment && fragment.length + piece.length + 1 > fragmentSize) push();
          fragment += `${piece}\n`;
        }
      }
      if (fragment) push();
    }
  }
  const batches: Batch[] = [];
  let assigned: Section[] = []; let length = 0;
  const flush = () => {
    if (!assigned.length) return;
    const id = `batch-${batches.length + 1}`;
    const material = renderSections(assigned);
    batches.push({ id, sections: assigned, prompt: `${context}\n\n${material}` });
    assigned = []; length = 0;
  };
  if (room <= 0) gaps.push('PR context exceeds the Strict per-run character budget');
  else for (const section of sections) {
    const size = section.patch.length + section.id.length + section.file.length + 200;
    if (size > room) continue;
    if (assigned.length && length + size > room) flush();
    if (batches.length >= cfg.strict.maxBatches) break;
    assigned.push(section); length += size;
  }
  if (batches.length < cfg.strict.maxBatches) flush();
  const assignedIds = new Set(batches.flatMap((b) => b.sections.map((s) => s.id)));
  const missing = sections.filter((s) => !assignedIds.has(s.id));
  if (missing.length) gaps.push(`Batch budget left ${missing.length} diff sections unassigned`);
  // Empty PRs still get context/requirement review and an independent review.
  if (!sections.length && room > 0) batches.push({ id: 'batch-1', sections: [], prompt: context });
  return { batches, sections, gaps };
}

export function coverageGaps(stage: StrictStage, sections: Section[]): string[] {
  const gaps: string[] = [];
  for (const section of sections) {
    const entries = stage.coverage.filter((c) => c.section_id === section.id);
    if (entries.length !== 1 || !entries[0].notes.trim()) gaps.push(`${stage.purpose}: ${section.id} has missing, duplicate or unverified coverage`);
    else if (entries[0].status !== 'examined') gaps.push(`${stage.purpose}: ${section.id} is unverified: ${entries[0].notes}`);
  }
  if (stage.coverage.some((c) => !sections.some((s) => s.id === c.section_id))) gaps.push(`${stage.purpose}: coverage contains an unknown section`);
  return gaps;
}

export async function runStrictReview(opts: {
  job: Job; ctx: ReviewContext; cfg: SettingsStore; db: Db; router: Router;
  task: Omit<RouterTask, 'instructions' | 'prompt' | 'schema'>; placeOpts: PlaceOptions;
}) {
  const { job, ctx, cfg, db, router, task, placeOpts } = opts;
  const { batches, sections, gaps } = makeBatches(ctx, cfg);
  const report: StrictReport = { version: POLICY_VERSION, sections: sections.map(({ id, file }) => ({ id, file })), excluded: ctx.excluded, stages: [], gaps, approvalBlocks: [], complete: false };
  report.gaps.push(...ctx.contextGaps ?? []);
  report.sources = (ctx.sources ?? []).map((s) => ({ id: s.id, title: s.title, kind: s.kind, chars: s.text.length, digest: s.digest, sections: sections.filter((section) => section.sourceId === s.id).length }));
  report.recovery = ctx.recovery;
  const plannedDiscoveryRuns = batches.length * 3;
  const synthesisRuns = batches.length > 1 ? 2 : 0;
  const verificationReserve = Math.min(cfg.strict.verificationReserve, Math.max(0, cfg.strict.maxRuns - plannedDiscoveryRuns - synthesisRuns));
  report.workload = { plannedDiscoveryRuns, synthesisRuns, verificationReserve, maxRuns: cfg.strict.maxRuns };
  if (plannedDiscoveryRuns + synthesisRuns > cfg.strict.maxRuns) report.gaps.push(`Planned workload requires ${plannedDiscoveryRuns + synthesisRuns} discovery/synthesis runs, above the ${cfg.strict.maxRuns} attempt budget`);
  if (ctx.incremental) {
    const baseline = db.jobsForPr(job.repo, job.pr_number).find((j) => j.id !== job.id && j.state === 'done' && j.head_sha === ctx.evidence.diff?.sinceSha && j.dry_run === job.dry_run);
    report.inheritedFrom = baseline?.id;
    if (!hasStrictCoverage(baseline)) {
      report.gaps.push('The incremental baseline lacks complete current-policy Strict coverage; full-review recovery is required');
    }
  }
  const outputs: { purpose: string; batchId: string; provider: Provider; model: string | null; out: StrictReviewOut }[] = [];
  const retryTimes: Date[] = [];
  let injection = false;
  const added = addedTextOf(ctx.prFiles);
  const clean = (text: string) => { const s = scrubText(text, added); injection ||= s.smuggled; return s.text; };
  const save = () => db.updateJob(job.id, { review_report: JSON.stringify(report) });
  const run = async (purpose: string, prompt: string, instructions: string, schema: object, providers: Provider[], parse: (v: unknown) => unknown) => {
    const digest = createHash('sha256').update(JSON.stringify({ prompt, instructions, schema, providers })).digest('hex').slice(0, 16);
    const key = `strict:${purpose}:${digest}`;
    // Only reuse successful, schema-valid answers for exactly this input and policy.
    const cached = db.runs(job.id).filter((r) => r.purpose === key && r.ok && r.output && providers.includes(r.provider)).reverse();
    for (const r of cached) {
      try { return { provider: r.provider, model: r.model, output: parse(JSON.parse(r.output!)), key }; } catch { /* try a fresh run */ }
    }
    const futureStages = Math.max(0, plannedDiscoveryRuns + synthesisRuns - report.stages.length);
    const cap = purpose.startsWith('verify:') ? cfg.strict.maxRuns : cfg.strict.maxRuns - verificationReserve - futureStages;
    const result = await router.run(job.id, key, { ...task, instructions, prompt, schema }, { providers, config: cfg, maxJobRuns: cap });
    if (!providers.includes(result.provider)) throw new Error('The required independent provider did not perform this stage');
    return { ...result, output: parse(result.output), key };
  };
  const primary = cfg.models.provider;
  const other: Provider = primary === 'codex' ? 'claude' : 'codex';
  const requirementRefs = ctx.issues.map((i) => `${i.repo}#${i.number}`);
  const reviewSchema = strictSchemaForIssues(requirementRefs);
  const discovery = async (purpose: 'main' | 'security' | 'adversarial' | 'synthesis', batch: Batch) => {
    const stage: StrictStage = { key: `${purpose}:${batch.id}`, purpose: `${purpose}/${batch.id}`, provider: null, model: null, state: 'incomplete', error: null, coverage: [] };
    report.stages.push(stage); save();
    db.updateJob(job.id, { step: `Strict ${stage.purpose}`, progress: Math.min(68, 25 + report.stages.length * 2) });
    let combined: StrictReviewOut | null = null;
    let remaining = batch.sections;
    let unknownCoverage = false;
    let requirementGaps: string[] = [];
    const terminal = batch.id === 'all-batches' || (batches.length === 1 && purpose !== 'security');
    for (let attempt = 0; attempt <= cfg.strict.maxContinuations; attempt++) {
      stage.continuations = attempt;
      const prior = combined ? { summary: clean(combined.summary), requirements: combined.requirements.map((r) => ({ ...r, reason: clean(r.reason), scope_evidence: clean(r.scope_evidence) })), questions: combined.questions_for_author.map(clean) } : null;
      const prompt = !attempt ? batch.prompt : `${ctx.contextPrompt ?? ctx.prompt}\n\n${renderSections(remaining)}\n\nContinue your own ${purpose} stage. Complete only the remaining assigned coverage and unfinished requirement assessments. Read full local context documents as needed. Return a consolidated summary and carry forward unresolved questions and requirement criteria. Do not repeat already completed coverage. If no sections are assigned above, return coverage: []; completed coverage is already saved.\n${untrusted('repair-diagnostics', JSON.stringify({ coverage: coverageGaps(stage, batch.sections), requirements: requirementGaps, previousError: stage.error, validIssueRefs: requirementRefs }))}\n${untrusted('your-prior-stage-assessment', JSON.stringify(prior))}`;
      try {
        if (prompt.length + 12_000 > cfg.strict.maxDiffChars) throw new Error('Continuation exceeds the per-run character budget');
        const instructions = `${strictInstructions(purpose, ctx.me, cfg.limits.maxNits)}${batch.id === 'all-batches' ? '\nThis is final cross-batch consolidation: inspect all assigned sections and their interactions, finish the full requirement checklist, and reassess all previously raised finding IDs. Read the full local source documents; do not just summarize earlier outputs.\n' : ''}${ctx.recheckOnly ? '\nThis is a same-commit recheck: raise no new findings. Reassess the previously listed findings, using the code and current source documents. Report the IDs you can confirm are resolved.\n' : ''}`;
        const result = await run(`${purpose}:${batch.id}${attempt ? `:continuation-${attempt}` : ''}`, prompt, instructions, reviewSchema,
          [purpose === 'adversarial' ? other : primary], (v) => StrictReviewOut.parse(v));
        const out = result.output as StrictReviewOut;
        out.requirements = canonicalRequirements(ctx.issues, out.requirements);
        stage.provider = result.provider; stage.model = result.model; stage.error = null;
        const coverage = new Map(stage.coverage.map((c) => [c.section_id, c]));
        const targets = attempt ? remaining : batch.sections;
        unknownCoverage = out.coverage.some((c) => !targets.some((s) => s.id === c.section_id));
        for (const section of targets) {
          const matches = out.coverage.filter((c) => c.section_id === section.id);
          const entry = matches.length === 1 ? matches[0] : null;
          if (!entry) { coverage.delete(section.id); continue; }
          const checked = [...entry.dependencies, ...entry.tests, ...entry.configuration];
          const invalid = checked.some((file) => {
            const full = path.resolve(task.cwd, file);
            return !file || file.startsWith('/') || /^[A-Za-z]:/.test(file) || file.split(/[\\/]/).includes('..') || !full.startsWith(path.resolve(task.cwd) + path.sep) || !fs.existsSync(full) || !fs.lstatSync(full).isFile();
          });
          coverage.set(section.id, { ...entry, status: invalid ? 'unverified' : entry.status, notes: clean(`${entry.notes}${invalid ? ' (invalid or missing checked-file path)' : ''}`), dependencies: entry.dependencies.map(clean), tests: entry.tests.map(clean), configuration: entry.configuration.map(clean) });
        }
        stage.coverage = [...coverage.values()];
        const previous = combined as StrictReviewOut | null;
        // Invalid refs are protocol errors to repair, not criteria to carry forever.
        // Valid unresolved criteria remain until the same source quotation is assessed.
        const requirements = new Map<string, StrictReviewOut['requirements'][number]>((previous?.requirements ?? []).filter((r) => requirementRefs.includes(r.ref)).map((r) => [criterionKey(r), r]));
        for (const r of out.requirements) {
          const duplicate = out.requirements.filter((entry) => criterionKey(entry) === criterionKey(r)).length > 1;
          requirements.set(criterionKey(r), duplicate ? { ...r, status: 'not_checked' } : r);
        }
        combined = { ...out, coverage: stage.coverage, findings: ctx.recheckOnly ? [] : [...(previous?.findings ?? []), ...out.findings], requirements: [...requirements.values()], resolved_previous_ids: [...new Set([...(previous?.resolved_previous_ids ?? []), ...out.resolved_previous_ids])] };
        remaining = batch.sections.filter((s) => coverageGaps({ ...stage, coverage: stage.coverage.filter((c) => c.section_id === s.id) }, [s]).length > 0);
        if (unknownCoverage) remaining = batch.sections;
        requirementGaps = [...new Set([
          ...requirementAssessmentGaps(ctx.issues, out.requirements, false),
          ...requirementAssessmentGaps(ctx.issues, combined.requirements, terminal),
        ])];
        if (!remaining.length && !unknownCoverage && !requirementGaps.length) break;
      } catch (err) {
        if (task.signal?.aborted) throw err;
        stage.error = clean(err instanceof Error ? err.message : String(err));
        if (err instanceof NoProviderAvailable) { retryTimes.push(err.retryAt); break; }
      }
      save();
    }
    const missing = coverageGaps(stage, batch.sections);
    if (unknownCoverage) missing.push(`${stage.purpose}: coverage contains an unknown section`);
    if (requirementGaps.length) missing.push(...requirementGaps.map((gap) => `${stage.purpose}: ${gap}`));
    if (stage.error) missing.push(`${stage.purpose}: ${stage.error}`);
    report.gaps.push(...missing);
    stage.state = missing.length || !combined ? 'incomplete' : 'done';
    if (combined && stage.provider) {
      report.requirements ??= [];
      report.requirements.push(...combined.requirements.map((r) => ({ stage: stage.purpose, ref: clean(r.ref), criterion: clean(r.criterion), status: r.status, reason: clean(r.reason), scopeEvidence: clean(r.scope_evidence) })));
      outputs.push({ purpose, batchId: batch.id, provider: stage.provider, model: stage.model, out: combined });
    }
    save();
  };
  // Independent prompts never include other passes' answers. Sequential scheduling also
  // makes the total run budget predictable and avoids simultaneous quota failures.
  for (const batch of plannedDiscoveryRuns + synthesisRuns <= cfg.strict.maxRuns ? batches : []) {
    await discovery('main', batch);
    await discovery('security', batch);
    await discovery('adversarial', batch);
  }
  if (batches.length > 1 && plannedDiscoveryRuns + synthesisRuns <= cfg.strict.maxRuns) {
    for (const purpose of ['synthesis', 'adversarial'] as const) {
      const summaries = outputs.filter((o) => purpose !== 'adversarial' || o.purpose === 'adversarial').map((o) => ({ pass: o.purpose, summary: clean(o.out.summary), requirements: o.out.requirements.map((r) => ({ ...r, reason: clean(r.reason), scope_evidence: clean(r.scope_evidence) })) }));
      const prompt = `${ctx.contextPrompt ?? ctx.prompt}\n\nAssigned sections (inspect their code and interactions):\n${sections.map((s) => `${s.id} (${s.file})`).join('\n')}\n\n${untrusted('batch-assessments', JSON.stringify(summaries))}`;
      if (prompt.length + 12_000 <= cfg.strict.maxDiffChars) await discovery(purpose, { id: 'all-batches', sections, prompt });
      else report.gaps.push(`${purpose} cross-batch consolidation exceeds the per-run character budget`);
    }
  }
  const candidates: Candidate[] = outputs.flatMap(({ purpose, provider, model, out }) => out.findings.map((f) => ({
    ...f, category: purpose === 'security' ? 'security' as const : f.category,
    pass: (purpose === 'security' ? 'security' : purpose === 'adversarial' ? 'adversarial' : 'main') as Pass,
    model: provider, model_id: model, original_severity: f.severity, verification: 'not_needed' as const,
    verified_by: null, verify_reason: null,
  })));
  for (const [i, c] of candidates.entries()) {
    if (placeFindings(candidates, { ...placeOpts, strict: true })[i].status === 'dropped' || (c.severity !== 'major' && c.severity !== 'blocker')) continue;
    const stage: StrictStage = { key: `verify:${i}`, purpose: `verify/finding-${i}`, provider: null, model: null, state: 'incomplete', error: null, coverage: [] };
    report.stages.push(stage); save();
    db.updateJob(job.id, { step: `Strict ${stage.purpose}`, progress: 72 });
    c.verification = 'skipped';
    try {
      const verifier: Provider = c.model === 'codex' ? 'claude' : 'codex';
      const prompt = `${ctx.contextPrompt ?? ctx.prompt}\n\n<untrusted kind="finding-to-verify">\n${JSON.stringify({ id: i, ...c }).replace(/<\/?untrusted/gi, '<untrusted_')}\n</untrusted>\nRead the actual code in the checkout. Your reason must name the repository files checked.`;
      if (prompt.length + 12_000 > cfg.strict.maxDiffChars) throw new Error('Verification exceeds per-run character budget');
      const result = await run(`verify:${i}`, prompt, verifyInstructions(), verifySchema, [verifier], (v) => VerifyOut.parse(v));
      const verdicts = (result.output as VerifyOut).verdicts;
      if (verdicts.length !== 1 || verdicts[0].id !== i || !verdicts[0].reason.trim()) throw new Error('Verification must return exactly one reasoned verdict for the assigned finding');
      const verdict = verdicts[0];
      stage.provider = result.provider; stage.model = result.model; stage.state = 'done';
      c.verification = verdict.verdict; c.verified_by = result.provider; c.verify_reason = clean(verdict.reason);
      if (verdict.verdict === 'confirmed') c.severity = minSeverity(c.severity, verdict.adjusted_severity);
      // Uncertainty preserves severity and blocks approval; it must not vanish by downgrade.
    } catch (err) {
      if (task.signal?.aborted) throw err;
      stage.error = clean(err instanceof Error ? err.message : String(err));
      c.verify_reason = stage.error;
      if (err instanceof NoProviderAvailable) retryTimes.push(err.retryAt);
    }
    if (c.verification !== 'confirmed' && c.verification !== 'refuted') {
      c.confidence = 'low';
      report.approvalBlocks.push(`Finding ${i + 1} has unresolved serious verification`);
    }
    save();
  }
  const relevant = outputs.filter((o) => o.purpose !== 'security');
  const finalRequirements = outputs.filter((o) => o.purpose === (batches.length > 1 ? 'synthesis' : 'main'));
  const independentRequirements = outputs.filter((o) => o.purpose === 'adversarial' && (batches.length === 1 || o.batchId === 'all-batches'));
  report.approvalBlocks.push(...requirementBlocks(ctx.issues, finalRequirements.flatMap((o) => o.out.requirements), independentRequirements.flatMap((o) => o.out.requirements)));
  const questions = [...new Set(outputs.flatMap((o) => o.out.questions_for_author.map(clean)))];
  if (questions.length) report.approvalBlocks.push('Unresolved questions affect review confidence');
  if (outputs.some((o) => o.out.review_confidence.level !== 'high')) report.approvalBlocks.push('A required pass reported less than high confidence');
  if (!batches.length || outputs.length < batches.length * 3) report.gaps.push('Required discovery stages did not all complete');
  report.gaps = report.gaps.map(clean);
  report.approvalBlocks = report.approvalBlocks.map(clean);
  if (injection) report.approvalBlocks.push('Review output attempted to disclose credentials');
  report.gaps = [...new Set(report.gaps)]; report.approvalBlocks = [...new Set(report.approvalBlocks)];
  report.complete = report.gaps.length === 0 && report.stages.every((s) => s.state === 'done');
  save();
  const rank = { high: 2, medium: 1, low: 0 };
  const rating = outputs.map((o) => o.out.review_confidence).sort((a, b) => rank[a.level] - rank[b.level])[0];
  const resolutionReviews = batches.length > 1 ? relevant.filter((o) => o.batchId === 'all-batches') : relevant;
  const mainOut: ReviewOut = {
    summary: outputs.map((o) => clean(o.out.summary)).filter(Boolean).join('\n\n'),
    findings: [], questions_for_author: questions,
    // Resolving earlier findings requires agreement across all non-security reviewers.
    resolved_previous_ids: report.complete && resolutionReviews.length >= 2 ? resolutionReviews[0].out.resolved_previous_ids.filter((id) => resolutionReviews.every((o) => o.out.resolved_previous_ids.includes(id))) : [],
    spec_alignment: {
      status: !ctx.issues.length ? 'no_spec' : report.approvalBlocks.some((s) => s.startsWith('Requirement ')) ? 'partial' : 'aligned',
      notes: finalRequirements.map((o) => clean(o.out.spec_alignment.notes)).filter(Boolean).join('\n'),
    },
    review_confidence: !report.complete ? { level: 'low', reason: 'Required review coverage or verification is incomplete' } : rating ? { level: rating.level, reason: clean(rating.reason) } : { level: 'low', reason: 'No required pass completed' },
  };
  const retryAt = retryTimes.length ? new Date(Math.min(...retryTimes.map((d) => d.getTime()))) : null;
  return { report, candidates, mainOut, retryAt, injection };
}
