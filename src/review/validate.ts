// Deterministic checks between the model output and GitHub. Nothing here trusts the model.

import fs from 'node:fs';
import path from 'node:path';
import { parsePatch, type ParsedPatch } from '../github/diff.ts';
import type { PrFile } from '../github/prs.ts';
import type { Confidence, Finding, FindingStatus, Pass, Provider, Severity, Verification } from '../types.ts';
import type { FindingOut } from './schema.ts';

export interface Candidate extends FindingOut {
  pass: Pass;
  model: Provider;
  model_id: string | null;
  original_severity: Severity;
  verification: Verification;
  verified_by: Provider | null;
  verify_reason: string | null;
}

export interface Placed extends Candidate {
  status: FindingStatus;
  drop_reason: string | null;
}

export interface PlaceOptions {
  checkoutDir: string;
  prFiles: PrFile[];
  previous: Pick<Finding, 'file' | 'line' | 'title'>[];
  maxNits: number;
}

const SEVERITY_RANK: Record<Severity, number> = { blocker: 0, major: 1, minor: 2, nit: 3 };
const CONFIDENCE_RANK: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

export function findSecrets(text: string): string[] {
  return SECRET_PATTERNS.flatMap((re) => [...text.matchAll(re)].map((m) => m[0]));
}

export const redact = (secret: string) => `${secret.slice(0, 4)}…[redacted]`;

export function normalizePath(file: string, checkoutDir: string): string {
  let f = file.trim().replace(/\\/g, '/');
  const root = checkoutDir.replace(/\\/g, '/');
  if (f.startsWith(root)) f = f.slice(root.length);
  return f.replace(/^\.\//, '').replace(/^[ab]\//, '').replace(/^\/+/, '');
}

const words = (s: string) => new Set(s.toLowerCase().split(/\W+/).filter((w) => w.length > 2));

export function similarity(a: string, b: string): number {
  const A = words(a);
  const B = words(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const w of A) if (B.has(w)) shared++;
  return shared / (A.size + B.size - shared);
}

const evidenceLines = (evidence: string) =>
  evidence
    .split('\n')
    .map((l) => l.replace(/^[+-](?=\s|\S)/, '').trim())
    .filter((l) => l && l !== '...' && l !== '…');

function readInside(checkoutDir: string, file: string): string | null {
  const full = path.resolve(checkoutDir, file);
  if (!full.startsWith(path.resolve(checkoutDir) + path.sep)) return null;
  try {
    const stat = fs.lstatSync(full);
    if (!stat.isFile() || stat.size > 2_000_000) return null;
    return fs.readFileSync(full, 'utf8');
  } catch {
    return null;
  }
}

function evidenceFound(evidence: string, content: string | null, patch: ParsedPatch | null): boolean {
  const lines = evidenceLines(evidence);
  if (!lines.length) return false;
  const haystack = new Set<string>();
  for (const l of (content ?? '').split('\n')) haystack.add(l.trim());
  for (const l of patch?.removedText ?? []) haystack.add(l.trim());
  const hits = lines.filter((l) => haystack.has(l) || (content ?? '').includes(l)).length;
  return hits >= Math.ceil(lines.length * 0.6);
}

// Moves a finding to a line GitHub will accept: the stated line if it's in the diff,
// otherwise the changed line that matches the evidence.
function commentLine(c: Candidate, patch: ParsedPatch): number | null {
  if (c.line !== null && patch.commentableLines.has(c.line)) return c.line;
  const first = evidenceLines(c.evidence)[0];
  if (!first) return null;
  for (const [line, text] of patch.addedLines) if (text.trim() === first) return line;
  return null;
}

export function placeFindings(candidates: Candidate[], opts: PlaceOptions): Placed[] {
  const patches = new Map<string, ParsedPatch>();
  const prFileByName = new Map(opts.prFiles.map((f) => [f.filename, f]));
  const addedText = opts.prFiles.flatMap((f) => [...parsePatch(f.patch).addedLines.values()]).join('\n');

  const placed: Placed[] = candidates.map((raw) => {
    const c: Placed = { ...raw, file: normalizePath(raw.file, opts.checkoutDir), status: 'inline', drop_reason: null };
    // Secrets: allowed only when the PR itself adds them (then they are the finding). Either
    // way they are redacted before anything is stored, shown or posted.
    const fields = ['title', 'evidence', 'problem', 'suggestion'] as const;
    const secrets = fields.flatMap((field) => findSecrets(c[field]));
    const scrub = (p: Placed): Placed => {
      if (!secrets.length) return p;
      const out = { ...p };
      for (const field of fields) for (const secret of secrets) out[field] = out[field].split(secret).join(redact(secret));
      return out;
    };
    const drop = (reason: string): Placed => scrub({ ...c, status: 'dropped', drop_reason: reason });

    if (secrets.some((secret) => !addedText.includes(secret))) {
      return drop('output contained a credential that is not in the PR (possible exfiltration attempt)');
    }
    if (c.verification === 'refuted') return drop(`refuted by ${c.verified_by}: ${c.verify_reason ?? ''}`.trim());
    if (c.severity === 'nit' && c.confidence === 'low') return drop('low-confidence nit');

    const prFile = prFileByName.get(c.file);
    const content = c.file ? readInside(opts.checkoutDir, c.file) : null;
    if (!prFile && content === null) {
      return c.category === 'requirement' && !c.file ? scrub({ ...c, status: 'summary' }) : drop(`file not found: ${c.file || '(none)'}`);
    }

    let patch: ParsedPatch | null = null;
    if (prFile) {
      patch = patches.get(prFile.filename) ?? parsePatch(prFile.patch);
      patches.set(prFile.filename, patch);
    }

    if (!evidenceFound(c.evidence, content, patch)) {
      if (c.category === 'requirement') return scrub({ ...c, status: 'summary' });
      return drop('quoted evidence not found in the file');
    }

    const line = patch ? commentLine(c, patch) : null;
    return scrub(line !== null ? { ...c, line, status: 'inline' } : { ...c, status: 'summary' });
  });

  // Duplicates within this run, across both passes: keep the most severe, most confident one.
  const order = placed
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => f.status !== 'dropped')
    .sort((a, b) => SEVERITY_RANK[a.f.severity] - SEVERITY_RANK[b.f.severity] || CONFIDENCE_RANK[a.f.confidence] - CONFIDENCE_RANK[b.f.confidence]);
  const kept: Placed[] = [];
  for (const { f, i } of order) {
    const dup = kept.find(
      (k) =>
        k.file === f.file &&
        ((k.line !== null && f.line !== null && Math.abs(k.line - f.line) <= 3 && (k.category === f.category || similarity(k.title, f.title) >= 0.4)) ||
          similarity(k.title, f.title) >= 0.7),
    );
    if (dup) placed[i] = { ...f, status: 'dropped', drop_reason: `duplicate of "${dup.title}"` };
    else kept.push(f);
  }

  // Already raised in an earlier review of this PR.
  for (let i = 0; i < placed.length; i++) {
    const f = placed[i];
    if (f.status === 'dropped') continue;
    const prev = opts.previous.find(
      (p) => p.file === f.file && ((p.line !== null && f.line !== null && Math.abs(p.line - f.line) <= 3) || similarity(p.title, f.title) >= 0.6),
    );
    if (prev) placed[i] = { ...f, status: 'dropped', drop_reason: `already raised: "${prev.title}"` };
  }

  // Cap nits.
  const nits = placed
    .map((f, i) => ({ f, i }))
    .filter(({ f }) => f.status !== 'dropped' && f.severity === 'nit')
    .sort((a, b) => CONFIDENCE_RANK[a.f.confidence] - CONFIDENCE_RANK[b.f.confidence]);
  for (const { f, i } of nits.slice(opts.maxNits)) placed[i] = { ...f, status: 'dropped', drop_reason: 'over the nit limit' };

  return placed;
}

export function lowerSeverity(s: Severity): Severity {
  return s === 'blocker' ? 'major' : s === 'major' ? 'minor' : 'nit';
}

export function minSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}
