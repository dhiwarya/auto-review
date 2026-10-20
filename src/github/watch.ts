// Finds PRs that request your review by watching each repo's open-PR list with
// conditional requests. GitHub answers "304 Not Modified" when nothing changed, and those
// answers don't count against your rate limit, so frequent checks are close to free.
// (Search, used before, has a 30-a-minute budget and no "not modified" answer.)

import { httpStatus, splitRepo, type GitHub } from './client.ts';
import type { SettingsStore } from '../settings.ts';

export interface OpenPr {
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string;
  draft: boolean;
  headSha: string;
  requestedReviewers: string[];
}

export interface WatchStatus {
  repo: string;
  ok: boolean;
  error: string | null;
  openPrs: number;
  requestingYou: number;
  checkedAt: string | null;
}

export interface CycleStats {
  requests: number; // sent to GitHub
  notModified: number; // of those, free "nothing changed" answers
}

interface CachedPage {
  etag: string;
  items: unknown[];
  hasNext: boolean;
}

const DISCOVERY_EVERY_MS = 10 * 60_000;
const MAX_PAGES = 10;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isPattern = (p: string) => /[*?]/.test(p);

export class RepoWatcher {
  private readonly gh: GitHub;
  private readonly cfg: SettingsStore;
  private readonly minGapMs: number;
  private readonly pages = new Map<string, CachedPage>();
  private readonly status = new Map<string, WatchStatus>();
  private discovered: string[] = [];
  private discoveredAt = 0;
  private discoveryKey = '';
  private lastRequestAt = 0;
  stats: CycleStats = { requests: 0, notModified: 0 };

  // minGapMs: at least this long between requests, so many repos never turn into a burst.
  constructor(gh: GitHub, cfg: SettingsStore, minGapMs = 1000) {
    this.gh = gh;
    this.cfg = cfg;
    this.minGapMs = minGapMs;
  }

  startCycle() {
    this.stats = { requests: 0, notModified: 0 };
  }

  watchStatus(): WatchStatus[] {
    return [...this.status.values()].sort((a, b) => a.repo.localeCompare(b.repo));
  }

  // Exact entries are watched directly; patterns are expanded from the repos you can access.
  async watchedRepos(): Promise<string[]> {
    const allow = this.cfg.repos.allow;
    const exact = allow.filter((p) => !isPattern(p));
    const patterns = allow.filter(isPattern);
    let fromPatterns: string[] = [];
    if (patterns.length) {
      const key = patterns.join(',');
      if (key !== this.discoveryKey || Date.now() - this.discoveredAt > DISCOVERY_EVERY_MS) {
        const repos = await this.list<{ full_name: string; archived: boolean }>('GET /user/repos', {
          affiliation: 'owner,collaborator,organization_member',
          sort: 'full_name',
        });
        this.discovered = repos.filter((r) => !r.archived).map((r) => r.full_name);
        this.discoveredAt = Date.now();
        this.discoveryKey = key;
      }
      fromPatterns = this.discovered;
    }
    const watched = [...new Map([...exact, ...fromPatterns].map((r) => [r.toLowerCase(), r])).values()].filter((r) =>
      this.cfg.isRepoAllowed(r),
    );
    // Forget repos that are no longer watched.
    const keep = new Set(watched.map((r) => r.toLowerCase()));
    for (const key of this.status.keys()) if (!keep.has(key)) this.status.delete(key);
    return watched;
  }

  async openPrs(repo: string): Promise<OpenPr[]> {
    try {
      const items = await this.list<{
        number: number;
        title: string;
        html_url: string;
        user: { login: string } | null;
        draft?: boolean;
        head: { sha: string };
        base: { repo: { full_name: string } };
        requested_reviewers?: { login: string }[] | null;
      }>('GET /repos/{owner}/{repo}/pulls', { ...splitRepo(repo), state: 'open' });
      const prs = items.map((p) => ({
        repo: p.base.repo.full_name, // GitHub's own spelling, whatever case you typed
        number: p.number,
        title: p.title,
        url: p.html_url,
        author: p.user?.login ?? 'unknown',
        draft: Boolean(p.draft),
        headSha: p.head.sha,
        requestedReviewers: (p.requested_reviewers ?? []).map((u) => u.login),
      }));
      const me = this.gh.me.toLowerCase();
      this.status.set(repo.toLowerCase(), {
        repo,
        ok: true,
        error: null,
        openPrs: prs.length,
        requestingYou: prs.filter((p) => p.requestedReviewers.some((u) => u.toLowerCase() === me)).length,
        checkedAt: new Date().toISOString(),
      });
      return prs;
    } catch (err) {
      const status = httpStatus(err);
      const error = status === 404 ? 'not found, or this login has no access' : err instanceof Error ? err.message : String(err);
      this.status.set(repo.toLowerCase(), { repo, ok: false, error, openPrs: 0, requestingYou: 0, checkedAt: new Date().toISOString() });
      throw err;
    }
  }

  // Every page of a list endpoint, each asked with If-None-Match from the last answer.
  private async list<T>(route: string, params: Record<string, string | number>): Promise<T[]> {
    const items: unknown[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const key = `${route} ${JSON.stringify({ ...params, page })}`;
      const cached = this.pages.get(key);
      const result = await this.conditionalGet(route, { ...params, per_page: 100, page }, cached);
      if (result !== cached) this.pages.set(key, result);
      items.push(...result.items);
      if (!result.hasNext) break;
    }
    return items as T[];
  }

  private async conditionalGet(route: string, params: Record<string, string | number>, cached: CachedPage | undefined): Promise<CachedPage> {
    const wait = this.lastRequestAt + this.minGapMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();
    this.stats.requests++;
    try {
      const res = await this.gh.octokit.request(route, {
        ...params,
        headers: cached ? { 'if-none-match': cached.etag } : {},
      });
      const link = String(res.headers.link ?? '');
      return {
        etag: String(res.headers.etag ?? ''),
        items: Array.isArray(res.data) ? res.data : [],
        hasNext: /rel="next"/.test(link),
      };
    } catch (err) {
      if (httpStatus(err) === 304 && cached) {
        this.stats.notModified++;
        return cached;
      }
      throw err;
    }
  }
}
