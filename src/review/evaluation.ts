import { z } from 'zod';

export const EvaluationCases = z.object({
  version: z.literal(1),
  cases: z.array(z.object({ id: z.string(), expected: z.array(z.object({ id: z.string() })) })),
});
export const EvaluationRuns = z.object({
  reviews: z.array(z.object({
    caseId: z.string(), profile: z.enum(['standard', 'strict']), complete: z.boolean(),
    durationMs: z.number().nonnegative(), inputTokens: z.number().nonnegative().nullable(), outputTokens: z.number().nonnegative().nullable(),
    // Human-adjudicated matches, not labels invented by the reviewing model.
    findings: z.array(z.object({ matchedExpectedId: z.string().nullable() })),
  })),
});

export function evaluateReviews(casesInput: unknown, runsInput: unknown) {
  const fixtures = EvaluationCases.parse(casesInput);
  const runs = EvaluationRuns.parse(runsInput).reviews;
  const ids = new Map(fixtures.cases.map((c) => [c.id, new Set(c.expected.map((e) => e.id))]));
  if (ids.size !== fixtures.cases.length) throw new Error('Duplicate fixture case IDs');
  const seen = new Set<string>();
  for (const run of runs) {
    const key = `${run.profile}/${run.caseId}`;
    if (seen.has(key)) throw new Error(`Duplicate evaluation run: ${key}`);
    seen.add(key);
    const expected = ids.get(run.caseId);
    if (!expected) throw new Error(`Unknown fixture: ${run.caseId}`);
    for (const f of run.findings) if (f.matchedExpectedId && !expected.has(f.matchedExpectedId)) throw new Error(`Unknown expected finding: ${f.matchedExpectedId}`);
  }
  return (['standard', 'strict'] as const).map((profile) => {
    const reviews = runs.filter((r) => r.profile === profile);
    let matched = 0; let missed = 0; let falsePositives = 0; let duplicates = 0;
    for (const run of reviews) {
      const matches = run.findings.map((f) => f.matchedExpectedId).filter((id): id is string => id !== null);
      const unique = new Set(matches);
      matched += unique.size; missed += ids.get(run.caseId)!.size - unique.size;
      falsePositives += run.findings.filter((f) => f.matchedExpectedId === null).length;
      duplicates += matches.length - unique.size;
    }
    const mean = (key: 'durationMs' | 'inputTokens' | 'outputTokens') => {
      const values = reviews.map((r) => r[key]).filter((v): v is number => v !== null);
      return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    };
    return {
      profile, cases: reviews.length, missingCases: fixtures.cases.filter((c) => !reviews.some((r) => r.caseId === c.id)).map((c) => c.id),
      incomplete: reviews.filter((r) => !r.complete).length, matched, missed, falsePositives, duplicates,
      precision: matched + falsePositives ? matched / (matched + falsePositives) : null,
      recall: matched + missed ? matched / (matched + missed) : null,
      averageDurationMs: mean('durationMs'), averageInputTokens: mean('inputTokens'), averageOutputTokens: mean('outputTokens'),
    };
  });
}
