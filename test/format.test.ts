import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { countsLine, inlineBody, summaryBody, type SummaryInput } from '../src/review/format.ts';
import type { Finding, Severity } from '../src/types.ts';

const finding = (id: number, severity: Severity, over: Partial<Finding> = {}) =>
  ({
    id, severity, category: 'bug', title: `Title ${id}`, problem: 'It breaks\nwhen empty.', suggestion: 'Check for empty.',
    file: 'src/a.ts', line: 3, status: 'inline', model: 'codex', model_id: 'gpt-6.1-sol', confidence: 'high', ...over,
  }) as Finding;

const summary = (over: Partial<SummaryInput> = {}) =>
  summaryBody({
    repo: 'acme/api', headSha: 'a'.repeat(40), summaries: ['Adds retries.', ''], specStatus: 'no_spec', specNotes: '', issues: [],
    findings: [], questions: [], resolved: [], large: false, excluded: [], inlineFailed: false, jobId: 7, ...over,
  });

const EMOJI = /\p{Extended_Pictographic}/u;

describe('comment format', () => {
  it('writes inline comments plainly, signed Auto Reviewer, with a hidden marker', () => {
    const body = inlineBody(finding(12, 'blocker'));
    assert.equal(
      body,
      '**Blocker (bug):** Title 12\n\nIt breaks\nwhen empty.\n\n**Suggestion:** Check for empty.\n\n<sub>Auto Reviewer</sub>\n<!-- ai-finding:12 -->',
    );
    assert.doesNotMatch(body, EMOJI);
    assert.doesNotMatch(body, /AI-assisted|gpt-6|confidence/i, 'no model details on GitHub');
  });

  it('counts findings in words', () => {
    assert.equal(countsLine([finding(1, 'blocker'), finding(2, 'blocker'), finding(3, 'major'), finding(4, 'major'), finding(5, 'nit')]), '2 blockers, 2 major, 1 nit');
    assert.equal(countsLine([]), '');
  });

  it('opens the summary with the counts, or says nothing was found', () => {
    assert.match(summary(), /^\*\*No issues found\.\*\*\n\nAdds retries\.\n\n\*\*Requirements:\*\* No linked issue to check against\./);
    assert.match(summary({ findings: [finding(1, 'major'), finding(2, 'minor')] }), /^\*\*1 major, 1 minor\*\*/);
  });

  it('names linked issues briefly and leaves the requirements line out when not checked', () => {
    const issues = [
      { repo: 'acme/api', number: 398, url: 'u', title: '', body: '', comments: [] },
      { repo: 'acme/web', number: 5, url: 'u', title: '', body: '', comments: [] },
    ];
    assert.match(summary({ specStatus: 'partial', specNotes: 'Asks for five retries; does three.', issues }), /\*\*Requirements:\*\* Partly matches #398, acme\/web#5\. Asks for five retries; does three\./);
    assert.doesNotMatch(summary({ specStatus: 'not_checked' }), /Requirements/);
  });

  it('adds only the sections that have something in them, and signs at the end', () => {
    const body = summary({
      findings: [finding(1, 'minor', { status: 'summary', line: null })],
      questions: ['Should it notify the merchant?'],
      resolved: [finding(2, 'nit', { title: 'Unused import' })],
      large: true,
      excluded: ['package-lock.json'],
    });
    assert.match(body, /\*\*Not tied to a changed line\*\*\n\n- \*\*Minor \(bug\):\*\* Title 1 \(`src\/a\.ts`\)\n  It breaks when empty\.\n  Suggestion: Check for empty\.\n  <!-- ai-finding:1 -->/);
    assert.match(body, /\*\*Questions\*\*\n\n- Should it notify the merchant\?/);
    assert.match(body, /\*\*Fixed since the last review\*\*\n\n- ~~Unused import~~ \(`src\/a\.ts`\)/);
    assert.match(body, /Large change: only the highest risks are covered\. Skipped 1 generated or lock file\.\n\n<sub>Auto Reviewer<\/sub>\n<!-- ai-review sha=a{40} job=7 -->$/);
    assert.doesNotMatch(body, EMOJI);
    assert.doesNotMatch(summary(), /Questions|Fixed since|Not tied/);
  });
});
