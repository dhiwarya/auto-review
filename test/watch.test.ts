import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Db } from '../src/db.ts';
import { rateLimited, type GitHub } from '../src/github/client.ts';
import { RepoWatcher } from '../src/github/watch.ts';
import { Poller } from '../src/jobs/poller.ts';
import { SettingsStore } from '../src/settings.ts';

const pr = (repo: string, number: number, reviewers: string[], extra: Record<string, unknown> = {}) => ({
  number,
  title: `PR ${number}`,
  html_url: `https://github.com/${repo}/pull/${number}`,
  user: { login: 'author' },
  draft: false,
  head: { sha: `sha${number}` },
  base: { repo: { full_name: repo } },
  requested_reviewers: reviewers.map((login) => ({ login })),
  ...extra,
});

// A stand-in for GitHub that answers 304 when the caller already has the current version.
function fakeGitHub(responses: Record<string, unknown[]>) {
  const calls: { route: string; params: Record<string, unknown> }[] = [];
  const version = new Map<string, number>();
  const gh = {
    me: 'me',
    rateLimits: new Map(),
    octokit: {
      request: async (route: string, params: Record<string, unknown> & { headers?: Record<string, string> }) => {
        calls.push({ route, params });
        const key = route.includes('{owner}') ? `${params.owner}/${params.repo}` : route;
        if (!(key in responses)) throw Object.assign(new Error('Not Found'), { status: 404 });
        const etag = `"v${version.get(key) ?? 1}"`;
        if (params.headers?.['if-none-match'] === etag) throw Object.assign(new Error('Not modified'), { status: 304 });
        return { data: responses[key], headers: { etag } };
      },
    },
  } as unknown as GitHub;
  return { gh, calls, bump: (key: string) => version.set(key, (version.get(key) ?? 1) + 1) };
}

describe('RepoWatcher', () => {
  let dir: string;
  let db: Db;
  let cfg: SettingsStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prr-watch-'));
    db = new Db(dir);
    cfg = new SettingsStore(db);
  });
  afterEach(() => {
    db.sql.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('asks again with the last ETag and reuses the answer when GitHub says nothing changed', async () => {
    cfg.update({ ...cfg.all, repos: { allow: ['acme/api'], deny: [] } });
    const fake = fakeGitHub({ 'acme/api': [pr('acme/api', 1, ['me']), pr('acme/api', 2, ['someone'])] });
    const w = new RepoWatcher(fake.gh, cfg, 0);

    w.startCycle();
    const first = await w.openPrs('acme/api');
    assert.equal(first.length, 2);
    assert.deepEqual(w.stats, { requests: 1, notModified: 0 });

    w.startCycle();
    const second = await w.openPrs('acme/api');
    assert.deepEqual(second, first);
    assert.deepEqual(w.stats, { requests: 1, notModified: 1 }, 'the repeat was free');
    assert.equal(fake.calls[1].params.headers && (fake.calls[1].params.headers as Record<string, string>)['if-none-match'], '"v1"');

    fake.bump('acme/api');
    w.startCycle();
    await w.openPrs('acme/api');
    assert.deepEqual(w.stats, { requests: 1, notModified: 0 }, 'a change is fetched in full');

    const status = w.watchStatus()[0];
    assert.equal(status.requestingYou, 1);
    assert.equal(status.openPrs, 2);
  });

  it('expands patterns from the repos you can access, and applies the deny list', async () => {
    cfg.update({ ...cfg.all, repos: { allow: ['acme/*', 'solo/tool'], deny: ['acme/secret'] } });
    const fake = fakeGitHub({
      'GET /user/repos': [
        { full_name: 'acme/api', archived: false },
        { full_name: 'acme/secret', archived: false },
        { full_name: 'acme/old', archived: true },
        { full_name: 'other/thing', archived: false },
      ],
    });
    const w = new RepoWatcher(fake.gh, cfg, 0);
    assert.deepEqual((await w.watchedRepos()).sort(), ['acme/api', 'solo/tool']);
  });

  it('reports a repo it can’t reach instead of failing the whole check', async () => {
    cfg.update({ ...cfg.all, repos: { allow: ['acme/missing'], deny: [] } });
    const w = new RepoWatcher(fakeGitHub({}).gh, cfg, 0);
    await assert.rejects(w.openPrs('acme/missing'));
    assert.match(w.watchStatus()[0].error ?? '', /no access/);
  });
});

describe('rate limits', () => {
  const err = (status: number, headers: Record<string, string>, message = '') =>
    Object.assign(new Error(message), { status, response: { headers, data: { message } } });

  it('tells the hourly limit from a "slow down"', () => {
    const reset = Math.floor(Date.now() / 1000) + 600;
    assert.equal(rateLimited(err(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }))?.kind, 'primary');
    assert.equal(rateLimited(err(403, { 'x-ratelimit-remaining': '12' }, 'You have exceeded a secondary rate limit'))?.kind, 'secondary');
    assert.ok(rateLimited(err(429, { 'retry-after': '30' }))?.resetAt);
    assert.equal(rateLimited(err(403, { 'x-ratelimit-remaining': '4000' }, 'Resource not accessible by integration')), null);
  });

  it('backs the poller off when GitHub asks it to slow down without saying for how long', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prr-backoff-'));
    const db = new Db(dir);
    try {
      const cfg = new SettingsStore(db);
      cfg.update({ ...cfg.all, repos: { allow: ['acme/api'], deny: [] } });
      const gh = { me: 'me', rateLimits: new Map() } as unknown as GitHub;
      const watcher = {
        stats: { requests: 0, notModified: 0 },
        startCycle() {},
        watchStatus: () => [],
        watchedRepos: async () => ['acme/api'],
        openPrs: async () => {
          throw err(403, { 'x-ratelimit-remaining': '100' }, 'You have exceeded a secondary rate limit');
        },
      } as unknown as RepoWatcher;
      const poller = new Poller(gh, cfg, db, { cancel() {} } as never, { syncOnce: async () => {} } as never, watcher);
      await poller.pollOnce();
      const until = new Date(poller.status().pausedUntil!).getTime() - Date.now();
      assert.ok(until > 55_000 && until <= 60_000, `paused for about a minute, got ${until}ms`);
      assert.match(db.getKv('last_poll_error') ?? '', /slow down/);
    } finally {
      db.sql.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stops polling when the hourly budget gets low, keeping requests for posting reviews', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prr-reserve-'));
    const db = new Db(dir);
    try {
      const cfg = new SettingsStore(db);
      cfg.update({ ...cfg.all, repos: { allow: ['acme/api'], deny: [] } });
      const reset = new Date(Date.now() + 20 * 60_000).toISOString();
      const gh = { me: 'me', rateLimits: new Map([['core', { resource: 'core', limit: 5000, remaining: 120, reset }]]) } as unknown as GitHub;
      let asked = false;
      const watcher = {
        stats: { requests: 0, notModified: 0 },
        startCycle() {},
        watchStatus: () => [],
        watchedRepos: async () => {
          asked = true;
          return [];
        },
      } as unknown as RepoWatcher;
      const poller = new Poller(gh, cfg, db, { cancel() {} } as never, { syncOnce: async () => {} } as never, watcher);
      await poller.pollOnce();
      assert.equal(asked, false, 'no requests sent');
      assert.equal(poller.status().pausedUntil, reset);
    } finally {
      db.sql.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
