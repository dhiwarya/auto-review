import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { HeadMovedError, RepoCache } from '../src/git/mirror.ts';

// A local repository standing in for GitHub: a main branch plus a PR ref, like
// GitHub's refs/pull/<n>/head.
function makeRemote(root: string) {
  const work = path.join(root, 'work');
  const remote = path.join(root, 'remote.git');
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=Tester', '-c', 'init.defaultBranch=main', ...args], { cwd: work, encoding: 'utf8' }).trim();
  fs.mkdirSync(work);
  git('init', '-q');
  fs.writeFileSync(path.join(work, 'app.js'), 'export const add = (a, b) => a + b;\n');
  fs.writeFileSync(path.join(work, 'CLAUDE.md'), 'Use tabs.\n');
  git('add', '.');
  git('commit', '-qm', 'Add app');
  fs.appendFileSync(path.join(work, 'app.js'), 'export const sub = (a, b) => a - b;\n');
  git('commit', '-qam', 'Add sub');
  const base = git('rev-parse', 'HEAD');
  git('checkout', '-qb', 'feature');
  fs.appendFileSync(path.join(work, 'app.js'), 'export const mul = (a, b) => a * b;\n');
  fs.writeFileSync(path.join(work, 'new.js'), 'export const x = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'Add mul');
  const head = git('rev-parse', 'HEAD');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  git('push', '-q', remote, 'main:refs/heads/main', `feature:refs/pull/7/head`);
  return { remote, base, head, git, work };
}

describe('RepoCache', { skip: process.platform === 'win32' && 'uses POSIX paths in the stand-in remote' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prr-mirror-'));
  const { remote, base, head } = makeRemote(root);
  const cache = new RepoCache(path.join(root, 'cache'), null, () => remote);
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it('downloads the repo once and checks out a throwaway worktree of the PR', async () => {
    assert.equal(await cache.exists('acme/app'), false);
    await cache.fetchPr('acme/app', 7, head, 'main', base);
    assert.equal(await cache.exists('acme/app'), true);
    const checkout = await cache.worktree('acme/app', head);
    assert.match(fs.readFileSync(path.join(checkout.dir, 'app.js'), 'utf8'), /mul/);
    assert.ok(fs.existsSync(path.join(checkout.dir, 'new.js')));
    await checkout.cleanup();
    assert.equal(fs.existsSync(checkout.dir), false);
  });

  it('refuses a PR head that moved', async () => {
    await assert.rejects(cache.fetchPr('acme/app', 7, 'f'.repeat(40), 'main', base), HeadMovedError);
  });

  it('gives diffs, history and base-branch files without GitHub', async () => {
    const mergeBase = await cache.mergeBase('acme/app', base, head);
    assert.equal(mergeBase, base);
    const files = await cache.diffFiles('acme/app', mergeBase, head);
    const byName = Object.fromEntries(files.map((f) => [f.filename, f]));
    assert.equal(byName['new.js'].status, 'added');
    assert.equal(byName['app.js'].status, 'modified');
    assert.equal(byName['app.js'].additions, 1);
    assert.match(byName['app.js'].patch ?? '', /^@@ .* @@[\s\S]*\+export const mul/);

    const history = await cache.history('acme/app', mergeBase, ['app.js']);
    assert.deepEqual(history[0].commits.map((c) => c.subject), ['Add sub', 'Add app']);
    assert.equal(history[0].commits[0].author, 'Tester');

    assert.equal(await cache.readFile('acme/app', base, 'CLAUDE.md'), 'Use tabs.\n');
    assert.equal(await cache.readFile('acme/app', base, 'AGENTS.md'), null);
    assert.equal(await cache.isAncestor('acme/app', base, head), true);
    assert.equal(await cache.isAncestor('acme/app', head, base), false);
  });

  it('never writes a token into the cached repo', async () => {
    const tokenCache = new RepoCache(path.join(root, 'cache2'), 'ghp_secret_token_value', () => remote);
    await tokenCache.fetchPr('acme/app', 7, head, 'main', base);
    const config = fs.readFileSync(path.join(tokenCache.gitDir('acme/app'), 'config'), 'utf8');
    assert.ok(!config.includes('ghp_secret'));
    assert.ok(!config.toLowerCase().includes('authorization'));
  });
});
