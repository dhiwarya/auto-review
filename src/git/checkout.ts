import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export const CHECKOUT_ROOT = path.join(os.tmpdir(), 'auto-reviewer');

export interface Checkout {
  dir: string;
  cleanup(): Promise<void>;
}

// The token goes to git through environment config, so it never lands in .git/config
// inside the checkout (which the review agents can read) or in the process list.
function gitEnv(token: string): NodeJS.ProcessEnv {
  const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
  return {
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
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

// A shallow, throwaway checkout of the PR head. Symlinks are checked out as plain
// files so nothing in the PR can point the agents at files outside the checkout.
export async function checkoutPr(token: string, repo: string, prNumber: number, headSha: string, keep = false): Promise<Checkout> {
  await fs.mkdir(CHECKOUT_ROOT, { recursive: true });
  const dir = await fs.mkdtemp(path.join(CHECKOUT_ROOT, `${repo.replace('/', '-')}-${prNumber}-`));
  const env = gitEnv(token);
  const git = (...args: string[]) => exec('git', ['-c', 'core.symlinks=false', ...args], { cwd: dir, env, maxBuffer: 16 * 1024 * 1024 });
  const cleanup = async () => {
    if (!keep) await fs.rm(dir, { recursive: true, force: true });
  };

  try {
    await git('init', '-q');
    await git('config', 'core.symlinks', 'false');
    await git('remote', 'add', 'origin', `https://github.com/${repo}.git`);
    await git('fetch', '-q', '--depth=1', '--no-tags', 'origin', `pull/${prNumber}/head`);
    const { stdout } = await git('rev-parse', 'FETCH_HEAD');
    if (stdout.trim() !== headSha) {
      throw new HeadMovedError(`PR head moved to ${stdout.trim().slice(0, 7)} while checking out ${headSha.slice(0, 7)}`);
    }
    await git('checkout', '-q', '--detach', 'FETCH_HEAD');
    return { dir, cleanup };
  } catch (err) {
    await fs.rm(dir, { recursive: true, force: true });
    throw err;
  }
}

export class HeadMovedError extends Error {}

// Leftovers from a crash or a restart mid-review.
export async function cleanupStaleCheckouts() {
  await fs.rm(CHECKOUT_ROOT, { recursive: true, force: true }).catch(() => {});
}
