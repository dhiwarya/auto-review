import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { LinkedIssue, LinkedPr } from '../github/prs.ts';

export interface ContextSource {
  id: string;
  kind: 'pr-description' | 'issue' | 'issue-comment' | 'guideline' | 'pr-comment' | 'prior-review';
  title: string;
  text: string;
  digest: string;
  path?: string;
}

export interface ContextSnapshot {
  version: 2;
  headSha: string;
  baseSha: string;
  issues: LinkedIssue[];
  prs: LinkedPr[];
  sources: ContextSource[];
  gaps: string[];
  directory?: string;
}

export function contextSource(id: string, kind: ContextSource['kind'], title: string, text: string): ContextSource {
  return { id, kind, title, text, digest: createHash('sha256').update(text).digest('hex') };
}

export const untrusted = (kind: string, text: string) =>
  `<untrusted kind="${kind}">\n${text.replace(/<\/?untrusted/gi, (m) => m.replace(/untrusted/i, 'untrusted_'))}\n</untrusted>`;

export async function materializeSources(snapshot: ContextSnapshot, checkout: string): Promise<void> {
  for (const source of snapshot.sources) {
    if (!source.path) continue;
    const target = path.resolve(checkout, source.path);
    const root = path.dirname(target);
    if (!target.startsWith(path.resolve(checkout) + path.sep) || !snapshot.directory || root !== path.resolve(checkout, snapshot.directory)) throw new Error('Invalid app context document path');
    await fs.mkdir(root, { recursive: true });
    if (await fs.realpath(root) !== path.join(await fs.realpath(checkout), snapshot.directory)) throw new Error('App context directory must not be a symlink');
    try { await fs.writeFile(target, source.text, { flag: 'wx' }); }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || !(await fs.lstat(target)).isFile() || await fs.readFile(target, 'utf8') !== source.text) throw err;
    }
  }
}
