import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, it } from 'node:test';
import { evaluateReviews } from '../src/review/evaluation.ts';

const fixtures = JSON.parse(fs.readFileSync(new URL('./fixtures/strict-reviews.json', import.meta.url), 'utf8'));
describe('review quality evaluation', () => {
  it('reports missed defects, false positives, duplicate findings, incomplete runs and resource use separately', () => {
    const results = evaluateReviews(fixtures, { reviews: [
      { caseId: 'zero-limit', profile: 'strict', complete: true, durationMs: 100, inputTokens: 30, outputTokens: 10, findings: [{ matchedExpectedId: 'empty-default-results' }, { matchedExpectedId: 'empty-default-results' }, { matchedExpectedId: null }] },
      { caseId: 'retry-side-effect', profile: 'strict', complete: false, durationMs: 300, inputTokens: null, outputTokens: null, findings: [] },
    ] });
    const strict = results[1];
    assert.equal(strict.matched, 1); assert.equal(strict.missed, 1); assert.equal(strict.falsePositives, 1); assert.equal(strict.duplicates, 1);
    assert.equal(strict.precision, 0.5); assert.equal(strict.recall, 0.5); assert.equal(strict.incomplete, 1);
    assert.equal(strict.averageDurationMs, 200); assert.equal(strict.averageInputTokens, 30); assert.equal(strict.missingCases.length, 3);
    assert.equal(results[0].recall, null);
  });
  it('rejects duplicate runs and unsupported human match labels', () => {
    const row = { caseId: 'zero-limit', profile: 'strict', complete: true, durationMs: 1, inputTokens: null, outputTokens: null, findings: [] };
    assert.throws(() => evaluateReviews(fixtures, { reviews: [row, row] }), /Duplicate/);
    assert.throws(() => evaluateReviews(fixtures, { reviews: [{ ...row, findings: [{ matchedExpectedId: 'invented' }] }] }), /Unknown expected/);
  });
});
