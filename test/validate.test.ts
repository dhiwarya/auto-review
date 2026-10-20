import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { parsePatch } from '../src/github/diff.ts';
import type { PrFile } from '../src/github/prs.ts';
import { findSecrets, normalizePath, placeFindings, similarity, type Candidate } from '../src/review/validate.ts';

const patch = [
  '@@ -1,4 +1,5 @@',
  ' import { db } from "./db";',
  '-export function getUser(id) {',
  '+export function getUser(id: string) {',
  '+  const sql = "SELECT * FROM users WHERE id = " + id;',
  '   return db.query(sql);',
  ' }',
].join('\n');

const fileContent = [
  'import { db } from "./db";',
  'export function getUser(id: string) {',
  '  const sql = "SELECT * FROM users WHERE id = " + id;',
  '  return db.query(sql);',
  '}',
  '',
  'export function helper() {',
  '  return 42;',
  '}',
].join('\n');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prr-test-'));
fs.mkdirSync(path.join(dir, 'src'));
fs.writeFileSync(path.join(dir, 'src/user.ts'), fileContent);
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const prFiles: PrFile[] = [{ filename: 'src/user.ts', status: 'modified', additions: 2, deletions: 1, patch }];

function candidate(over: Partial<Candidate>): Candidate {
  return {
    category: 'security',
    severity: 'blocker',
    confidence: 'high',
    file: 'src/user.ts',
    line: 3,
    title: 'SQL injection in getUser',
    evidence: 'const sql = "SELECT * FROM users WHERE id = " + id;',
    problem: 'id is concatenated into SQL',
    suggestion: 'Use a parameterised query',
    pass: 'security',
    model: 'codex',
    model_id: 'gpt-6.1-sol',
    original_severity: 'blocker',
    verification: 'not_needed',
    verified_by: null,
    verify_reason: null,
    ...over,
  };
}

const opts = { checkoutDir: dir, prFiles, previous: [], maxNits: 1 };

describe('parsePatch', () => {
  it('marks added and context lines as commentable on the new side', () => {
    const p = parsePatch(patch);
    assert.deepEqual([...p.commentableLines].sort(), [1, 2, 3, 4, 5]);
    assert.equal(p.addedLines.get(3), '  const sql = "SELECT * FROM users WHERE id = " + id;');
    assert.deepEqual(p.removedText, ['export function getUser(id) {']);
  });
});

describe('placeFindings', () => {
  it('keeps a finding on a changed line inline', () => {
    const [f] = placeFindings([candidate({})], opts);
    assert.equal(f.status, 'inline');
    assert.equal(f.line, 3);
  });

  it('moves a finding to the changed line that matches its evidence', () => {
    const [f] = placeFindings([candidate({ line: 40 })], opts);
    assert.equal(f.status, 'inline');
    assert.equal(f.line, 3);
  });

  it('puts findings on unchanged code into the summary', () => {
    const [f] = placeFindings([candidate({ line: 8, evidence: 'return 42;', title: 'Magic number', category: 'design', severity: 'minor' })], opts);
    assert.equal(f.status, 'summary');
  });

  it('drops findings whose quoted code does not exist', () => {
    const [f] = placeFindings([candidate({ evidence: 'eval(userInput)' })], opts);
    assert.equal(f.status, 'dropped');
    assert.match(f.drop_reason ?? '', /evidence/);
  });

  it('drops findings about files that do not exist', () => {
    const [f] = placeFindings([candidate({ file: 'src/ghost.ts' })], opts);
    assert.equal(f.status, 'dropped');
  });

  it('normalises a/ b/ and absolute paths', () => {
    assert.equal(normalizePath('b/src/user.ts', dir), 'src/user.ts');
    assert.equal(normalizePath(`${dir}/src/user.ts`, dir), 'src/user.ts');
  });

  it('collapses the same issue raised by both passes, keeping the more severe one', () => {
    const placed = placeFindings(
      [
        candidate({ pass: 'main', model: 'claude', category: 'bug', severity: 'major', title: 'Unsafe SQL string in getUser' }),
        candidate({}),
      ],
      opts,
    );
    assert.equal(placed[0].status, 'dropped');
    assert.match(placed[0].drop_reason ?? '', /duplicate/);
    assert.equal(placed[1].status, 'inline');
  });

  it('drops findings already raised in an earlier review', () => {
    const [f] = placeFindings([candidate({})], { ...opts, previous: [{ file: 'src/user.ts', line: 3, title: 'SQL injection' }] });
    assert.equal(f.status, 'dropped');
    assert.match(f.drop_reason ?? '', /already raised/);
  });

  it('drops refuted findings', () => {
    const [f] = placeFindings([candidate({ verification: 'refuted', verified_by: 'claude', verify_reason: 'id is validated upstream' })], opts);
    assert.equal(f.status, 'dropped');
  });

  it('caps nits', () => {
    const nit = (title: string, line: number) =>
      candidate({ severity: 'nit', category: 'design', title, line, evidence: fileContent.split('\n')[line - 1] });
    const placed = placeFindings([nit('Rename import alias', 1), nit('Prefer arrow function style', 2)], opts);
    assert.equal(placed.filter((p) => p.status !== 'dropped').length, 1);
  });

  it('drops output carrying a credential the PR did not add', () => {
    const [f] = placeFindings([candidate({ suggestion: 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789AB' })], opts);
    assert.equal(f.status, 'dropped');
    assert.match(f.drop_reason ?? '', /exfiltration/);
  });

  it('redacts a credential the PR itself adds', () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789AB';
    const withSecret: PrFile[] = [
      ...prFiles,
      { filename: 'config.ts', status: 'added', additions: 1, deletions: 0, patch: `@@ -0,0 +1 @@\n+export const token = "${secret}";` },
    ];
    fs.writeFileSync(path.join(dir, 'config.ts'), `export const token = "${secret}";\n`);
    const [f] = placeFindings(
      [candidate({ file: 'config.ts', line: 1, title: 'Hard-coded GitHub token', evidence: `export const token = "${secret}";` })],
      { ...opts, prFiles: withSecret },
    );
    assert.equal(f.status, 'inline');
    assert.ok(!f.evidence.includes(secret));
    assert.match(f.evidence, /redacted/);
  });
});

describe('helpers', () => {
  it('finds common secret formats', () => {
    assert.equal(findSecrets('AKIAABCDEFGHIJKLMNOP').length, 1);
    assert.equal(findSecrets('nothing here').length, 0);
  });

  it('scores title similarity', () => {
    assert.ok(similarity('SQL injection in getUser', 'Possible SQL injection in getUser query') > 0.5);
    assert.ok(similarity('SQL injection', 'Missing null check') < 0.2);
  });
});
