import { execFileSync } from 'node:child_process';
import { Octokit } from 'octokit';

export interface RateLimit {
  resource: string; // core, search, graphql, ...
  limit: number;
  remaining: number;
  reset: string; // ISO time the window resets
}

export interface GitHub {
  octokit: Octokit;
  token: string;
  me: string;
  authSource: 'GITHUB_TOKEN' | 'gh CLI';
  // Latest numbers GitHub reported for each limit, from response headers.
  rateLimits: Map<string, RateLimit>;
}

// GITHUB_TOKEN (a fine-grained token limited to your repos) is preferred.
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

function recordLimits(map: Map<string, RateLimit>, headers: Record<string, string | number | undefined> | undefined) {
  if (!headers) return;
  const resource = headers['x-ratelimit-resource'];
  const limit = headers['x-ratelimit-limit'];
  const remaining = headers['x-ratelimit-remaining'];
  const reset = headers['x-ratelimit-reset'];
  if (resource === undefined || limit === undefined || remaining === undefined || reset === undefined) return;
  map.set(String(resource), {
    resource: String(resource),
    limit: Number(limit),
    remaining: Number(remaining),
    reset: new Date(Number(reset) * 1000).toISOString(),
  });
}

export async function connectGitHub(): Promise<GitHub> {
  const { token, source } = resolveToken();
  const rateLimits = new Map<string, RateLimit>();
  const octokit = new Octokit({
    auth: token,
    userAgent: 'auto-reviewer',
    // Only wait-and-retry when GitHub asks for a short pause. Anything longer is handled by
    // the poller's back-off, so a rate limit never silently blocks the app for an hour.
    throttle: {
      onRateLimit: (retryAfter: number, _options: unknown, _octokit: unknown, retryCount: number) => retryAfter <= 30 && retryCount < 1,
      onSecondaryRateLimit: (retryAfter: number, _options: unknown, _octokit: unknown, retryCount: number) => retryAfter <= 30 && retryCount < 1,
    },
  });
  octokit.hook.after('request', (response) => recordLimits(rateLimits, response.headers as Record<string, string>));
  octokit.hook.error('request', (error) => {
    recordLimits(rateLimits, (error as { response?: { headers?: Record<string, string> } }).response?.headers);
    throw error;
  });
  // Asks GitHub who this token belongs to. That account is "you": its review requests
  // are the ones picked up, and reviews are posted as it.
  const { data } = await octokit.rest.users.getAuthenticated();
  return { octokit, token, me: data.login, authSource: source, rateLimits };
}

export function splitRepo(repo: string): { owner: string; repo: string } {
  const [owner, name] = repo.split('/');
  return { owner, repo: name };
}

export function httpStatus(err: unknown): number | undefined {
  return typeof err === 'object' && err && 'status' in err ? Number((err as { status: unknown }).status) : undefined;
}

export interface RateLimited {
  kind: 'primary' | 'secondary';
  // When GitHub said to come back, if it did.
  resetAt: Date | null;
}

// Primary: the hourly (or per-minute, for search) budget is used up; GitHub says when it resets.
// Secondary: too many requests too quickly; GitHub may or may not say how long to wait.
export function rateLimited(err: unknown): RateLimited | null {
  const status = httpStatus(err);
  if (status !== 403 && status !== 429) return null;
  const response = (err as { response?: { headers?: Record<string, string | undefined>; data?: unknown } }).response;
  const headers = response?.headers ?? {};
  const message = `${(err as Error).message ?? ''} ${JSON.stringify(response?.data ?? '')}`;
  if (headers['x-ratelimit-remaining'] === '0' && headers['x-ratelimit-reset']) {
    return { kind: 'primary', resetAt: new Date(Number(headers['x-ratelimit-reset']) * 1000) };
  }
  const retryAfter = headers['retry-after'] ? new Date(Date.now() + Number(headers['retry-after']) * 1000) : null;
  if (retryAfter || status === 429 || /secondary rate limit|abuse/i.test(message)) {
    return { kind: 'secondary', resetAt: retryAfter };
  }
  return null; // an ordinary 403: no access
}

export function errorText(err: unknown): string {
  if (typeof err === 'object' && err && 'response' in err) {
    const data = (err as { response?: { data?: unknown } }).response?.data;
    if (data) return JSON.stringify(data).slice(0, 500);
  }
  return err instanceof Error ? err.message : String(err);
}
