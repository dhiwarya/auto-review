import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assess, atLeast, openBlockers, type ConfidenceInput } from '../src/review/confidence.ts';
import type { Finding, Severity } from '../src/types.ts';

const finding = (severity: Severity, status: Finding['status'] = 'inline') => ({ severity, status }) as Finding;
const input = (over: Partial<ConfidenceInput> = {}): ConfidenceInput => ({
  findings: [],
  openEarlier: [],
  specStatus: 'aligned',
  questions: 0,
  large: false,
  truncated: false,
  injection: false,
  passes: [
    { level: 'high', reason: 'Read every changed path' },
    { level: 'high', reason: 'No untrusted input reaches anything dangerous' },
  ],
  ...over,
});

describe('confidence', () => {
  it('is high for a clean review, minors and nits included', () => {
    assert.deepEqual(assess(input({ findings: [finding('minor'), finding('nit')], specStatus: 'no_spec' })), { level: 'high', reasons: [] });
  });

  it('drops to medium for majors, open questions, partial requirements and large changes', () => {
    for (const over of [
      { findings: [finding('major')] },
      { openEarlier: [finding('major')] },
      { questions: 2 },
      { specStatus: 'partial' as const },
      { large: true },
      { truncated: true },
    ]) {
      const a = assess(input(over));
      assert.equal(a.level, 'medium', JSON.stringify(over));
      assert.equal(a.reasons.length, 1);
    }
  });

  it('drops to low when the code does not match the issue, or the PR tried to extract a secret', () => {
    assert.equal(assess(input({ specStatus: 'misaligned' })).level, 'low');
    assert.equal(assess(input({ injection: true })).level, 'low');
  });

  it("takes the less sure review pass, with its reason", () => {
    const a = assess(input({ passes: [{ level: 'high', reason: '' }, { level: 'medium', reason: "Couldn't see the auth service" }] }));
    assert.deepEqual(a, { level: 'medium', reasons: ["Couldn't see the auth service"] });
  });

  it('keeps every reason but the lowest level', () => {
    const a = assess(input({ findings: [finding('major')], specStatus: 'misaligned', large: true }));
    assert.equal(a.level, 'low');
    assert.equal(a.reasons.length, 3);
  });

  it('counts open blockers apart from confidence, ignoring dropped ones', () => {
    assert.equal(openBlockers([finding('blocker'), finding('blocker', 'dropped'), finding('major')]), 1);
    assert.equal(assess(input({ findings: [finding('blocker')] })).level, 'high', 'blockers stop approval on their own');
  });

  it('compares levels', () => {
    assert.ok(atLeast('high', 'medium'));
    assert.ok(atLeast('medium', 'medium'));
    assert.ok(!atLeast('medium', 'high'));
    assert.ok(!atLeast('low', 'medium'));
  });
});
