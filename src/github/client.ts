import { execFileSync } from 'node:child_process';
import { Octokit } from 'octokit';

export interface GitHub {
  octokit: Octokit;
  token: string;
  me: string;
  authSource: 'GITHUB_TOKEN' | 'gh CLI';
}

// GITHUB_TOKEN (a fine-grained token limited to your allowlisted repos) is preferred.
// Falling back to the GitHub CLI's login keeps local setup simple.
function resolveToken(): { token: string; source: GitHub['authSource'] } {
  const fromEnv = process.env.GITHUB_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, source: 'GITHUB_TOKEN' };
  try {
    const token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (token) return { token, source: 'gh CLI' };
  } catch {
    // fall through
  }
  throw new Error('No GitHub token. Set GITHUB_TOKEN in .env, or sign in with `gh auth login`.');
}

export async function connectGitHub(): Promise<GitHub> {
  const { token, source } = resolveToken();
  const octokit = new Octokit({ auth: token, userAgent: 'auto-reviewer' });
  // Asks GitHub who this token belongs to. That account is "you": its review requests
  // are the ones picked up, and reviews are posted as it.
  const { data } = await octokit.rest.users.getAuthenticated();
  return { octokit, token, me: data.login, authSource: source };
}

export function splitRepo(repo: string): { owner: string; repo: string } {
  const [owner, name] = repo.split('/');
  return { owner, repo: name };
}

export function httpStatus(err: unknown): number | undefined {
  return typeof err === 'object' && err && 'status' in err ? Number((err as { status: unknown }).status) : undefined;
}

// When GitHub refused a request for rate limiting, the time it says to come back.
export function rateLimitResetAt(err: unknown): Date | null {
  const status = httpStatus(err);
  if (status !== 403 && status !== 429) return null;
  const headers = (err as { response?: { headers?: Record<string, string | undefined> } }).response?.headers ?? {};
  if (headers['retry-after']) return new Date(Date.now() + Number(headers['retry-after']) * 1000);
  if (headers['x-ratelimit-remaining'] === '0' && headers['x-ratelimit-reset']) {
    return new Date(Number(headers['x-ratelimit-reset']) * 1000);
  }
  return status === 429 ? new Date(Date.now() + 60_000) : null;
}

export function errorText(err: unknown): string {
  if (typeof err === 'object' && err && 'response' in err) {
    const data = (err as { response?: { data?: unknown } }).response?.data;
    if (data) return JSON.stringify(data).slice(0, 500);
  }
  return err instanceof Error ? err.message : String(err);
}
