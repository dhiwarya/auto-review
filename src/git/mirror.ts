// A local copy of each reviewed repo, kept between reviews. Only new commits are
// downloaded, each review gets its own throwaway worktree, and history, diffs and files
// at any commit are available locally instead of through GitHub's API.

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export const CHECKOUT_ROOT = path.join(os.tmpdir(), 'auto-reviewer');

export class HeadMovedError extends Error {}

export interface Checkout {
  dir: string;
  cleanup(): Promise<void>;
}

export interface DiffFile {
  filename: string;
  previousFilename?: string;
  status: 'added' | 'removed' | 'modified' | 'renamed';
  additions: number;
  deletions: number;
  patch?: string;
}

export interface FileHistory {
  file: string;
  commits: { sha: string; date: string; author: string; subject: string }[];
}

// The token reaches git through environment config, so it's never written to the cache's
// config (which review agents can read through their worktree) or shown in the process list.
function gitEnv(token: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    SystemRoot: process.env.SystemRoot,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    GIT_TERMINAL_PROMPT: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  if (token) {
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  }
  return env;
}

export class RepoCache {
  private readonly root: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly urlFor: (repo: string) => string;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(root: string, token: string | null, urlFor = (repo: string) => `https://github.com/${repo}.git`) {
    this.root = root;
    this.env = gitEnv(token);
    this.urlFor = urlFor;
  }

  gitDir(repo: string): string {
    const [owner, name] = repo.toLowerCase().split('/');
    return path.join(this.root, owner, `${name}.git`);
  }

  private async git(repo: string, args: string[], cwd?: string): Promise<string> {
    const { stdout } = await exec('git', ['-c', 'core.symlinks=false', '-c', 'core.quotePath=false', `--git-dir=${this.gitDir(repo)}`, ...args], {
      cwd,
      env: this.env,
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  }

  // One git operation per repo at a time: two reviews fetching into the same copy at once
  // would fight over its lock files.
  private async withLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
    const key = repo.toLowerCase();
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    this.locks.set(key, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === run) this.locks.delete(key);
    }
  }

  async exists(repo: string): Promise<boolean> {
    return fs.access(path.join(this.gitDir(repo), 'HEAD')).then(
      () => true,
      () => false,
    );
  }

  private async ensure(repo: string) {
    const dir = this.gitDir(repo);
    try {
      await fs.access(path.join(dir, 'HEAD'));
      return;
    } catch {
      // first time
    }
    await fs.mkdir(dir, { recursive: true });
    await this.git(repo, ['init', '--bare', '-q']);
    await this.git(repo, ['config', 'remote.origin.url', this.urlFor(repo)]);
    await this.git(repo, ['config', 'core.symlinks', 'false']);
  }

  // Brings the copy up to date with the PR's head and its base branch. The first time
  // downloads the repo; after that only new commits.
  async fetchPr(repo: string, prNumber: number, headSha: string, baseRef: string, baseSha: string): Promise<void> {
    await this.withLock(repo, async () => {
      await this.ensure(repo);
      await this.git(repo, [
        'fetch', '-q', '--no-tags', '--prune', 'origin',
        `+refs/heads/${baseRef}:refs/remotes/origin/${baseRef}`,
        `+refs/pull/${prNumber}/head:refs/prs/${prNumber}`,
      ]);
      const head = (await this.git(repo, ['rev-parse', `refs/prs/${prNumber}`])).trim();
      if (head !== headSha) throw new HeadMovedError(`PR head moved to ${head.slice(0, 7)} while fetching ${headSha.slice(0, 7)}`);
      if (!(await this.hasCommit(repo, baseSha))) await this.git(repo, ['fetch', '-q', '--no-tags', 'origin', baseSha]);
    });
  }

  async hasCommit(repo: string, sha: string): Promise<boolean> {
    try {
      await this.git(repo, ['cat-file', '-e', `${sha}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  }

  // A throwaway working copy of one commit. Symlinks are checked out as plain files so
  // nothing in the PR can point the review agents at files outside it.
  async worktree(repo: string, sha: string, keep = false): Promise<Checkout> {
    await fs.mkdir(CHECKOUT_ROOT, { recursive: true });
    const dir = await fs.mkdtemp(path.join(CHECKOUT_ROOT, `${repo.replace('/', '-')}-${sha.slice(0, 7)}-`));
    await fs.rmdir(dir); // git creates it
    await this.withLock(repo, () => this.git(repo, ['worktree', 'add', '-q', '--detach', dir, sha]));
    return {
      dir,
      cleanup: async () => {
        if (keep) return;
        await this.withLock(repo, async () => {
          await this.git(repo, ['worktree', 'remove', '--force', dir]).catch(() => fs.rm(dir, { recursive: true, force: true }));
          await this.git(repo, ['worktree', 'prune']).catch(() => {});
        });
      },
    };
  }

  async mergeBase(repo: string, a: string, b: string): Promise<string> {
    return (await this.git(repo, ['merge-base', a, b])).trim();
  }

  async isAncestor(repo: string, ancestor: string, sha: string): Promise<boolean> {
    try {
      await this.git(repo, ['merge-base', '--is-ancestor', ancestor, sha]);
      return true;
    } catch {
      return false;
    }
  }

  // The unified diff of one file between two commits (3 lines of context, like GitHub).
  async filePatch(repo: string, from: string, to: string, file: string, previous?: string): Promise<string | undefined> {
    const paths = previous && previous !== file ? [previous, file] : [file];
    const out = await this.git(repo, ['diff', '--no-color', '-M', '--unified=3', from, to, '--', ...paths]);
    const hunk = out.indexOf('\n@@');
    return hunk === -1 ? undefined : out.slice(hunk + 1).replace(/\n$/, '');
  }

  // Files changed between two commits, with patches.
  async diffFiles(repo: string, from: string, to: string, maxPatches = 300): Promise<DiffFile[]> {
    const raw = await this.git(repo, ['diff', '--no-color', '-M', '--numstat', '-z', from, to]);
    const statusRaw = await this.git(repo, ['diff', '--no-color', '-M', '--name-status', '-z', from, to]);
    const statuses = new Map<string, DiffFile['status']>();
    const st = statusRaw.split('\0');
    for (let i = 0; i < st.length - 1; ) {
      const code = st[i];
      if (code.startsWith('R') || code.startsWith('C')) {
        statuses.set(st[i + 2], 'renamed');
        i += 3;
      } else {
        statuses.set(st[i + 1], code === 'A' ? 'added' : code === 'D' ? 'removed' : 'modified');
        i += 2;
      }
    }
    const files: DiffFile[] = [];
    const parts = raw.split('\0');
    for (let i = 0; i < parts.length - 1; ) {
      const [adds, dels, name] = parts[i].split('\t');
      let filename = name;
      let previousFilename: string | undefined;
      if (name === '') {
        // rename: "adds\tdels\t" then old and new names as separate fields
        previousFilename = parts[i + 1];
        filename = parts[i + 2];
        i += 3;
      } else {
        i += 1;
      }
      files.push({
        filename,
        previousFilename,
        status: statuses.get(filename) ?? 'modified',
        additions: adds === '-' ? 0 : Number(adds),
        deletions: dels === '-' ? 0 : Number(dels),
      });
    }
    for (const f of files.slice(0, maxPatches)) f.patch = await this.filePatch(repo, from, to, f.filename, f.previousFilename);
    return files;
  }

  // The last few commits that touched each file, up to and including `sha`.
  async history(repo: string, sha: string, files: string[], perFile = 3): Promise<FileHistory[]> {
    const out: FileHistory[] = [];
    for (const file of files) {
      const log = await this.git(repo, ['log', `-n${perFile}`, '--no-merges', '--format=%h%x09%as%x09%an%x09%s', sha, '--', file]).catch(() => '');
      const commits = log
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const [s, date, author, ...subject] = l.split('\t');
          return { sha: s, date, author, subject: subject.join('\t') };
        });
      if (commits.length) out.push({ file, commits });
    }
    return out;
  }

  // A file's contents at a commit, or null if it isn't there.
  async readFile(repo: string, sha: string, file: string): Promise<string | null> {
    try {
      return await this.git(repo, ['show', `${sha}:${file}`]);
    } catch {
      return null;
    }
  }

  // Worktrees whose folders vanished (a restart, the OS clearing temp files) are forgotten.
  async pruneAll() {
    let owners: string[] = [];
    try {
      owners = await fs.readdir(this.root);
    } catch {
      return;
    }
    for (const owner of owners) {
      for (const name of await fs.readdir(path.join(this.root, owner)).catch(() => [] as string[])) {
        if (name.endsWith('.git')) await this.git(`${owner}/${name.slice(0, -4)}`, ['worktree', 'prune']).catch(() => {});
      }
    }
  }
}

// Leftovers from a crash or a restart mid-review.
export async function cleanupStaleCheckouts() {
  await fs.rm(CHECKOUT_ROOT, { recursive: true, force: true }).catch(() => {});
}
