import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Db } from '../src/db.ts';
import { SettingsStore } from '../src/settings.ts';

describe('SettingsStore', () => {
  let dir: string;
  let db: Db;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prr-settings-'));
    db = new Db(dir);
  });

  afterEach(() => {
    db.sql.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('starts safe: no repos, dry run on, nothing reviewed', () => {
    const cfg = new SettingsStore(db);
    assert.equal(cfg.needsSetup, true);
    assert.equal(cfg.dryRun, true);
    assert.equal(cfg.isRepoAllowed('any/repo'), false);
  });

  it('saves to the database and applies changes straight away', () => {
    const cfg = new SettingsStore(db);
    const res = cfg.update({ ...cfg.all, repos: { allow: ['acme/*'], deny: ['acme/secret'] }, labels: { prefix: 'bot', blockerLabelInDraft: false } });
    assert.ok(res.ok);
    assert.equal(cfg.isRepoAllowed('acme/api'), true);
    assert.equal(cfg.isRepoAllowed('ACME/API'), true, 'case-insensitive');
    assert.equal(cfg.isRepoAllowed('acme/secret'), false, 'deny wins');
    assert.equal(cfg.labelName('done'), 'bot:done');
    assert.deepEqual(new SettingsStore(db).repos.allow, ['acme/*'], 'persists across restarts');
  });

  it('rejects invalid settings with the field that is wrong, and keeps the old ones', () => {
    const cfg = new SettingsStore(db);
    cfg.update({ ...cfg.all, repos: { allow: ['acme/api'], deny: [] } });
    const res = cfg.update({ ...cfg.all, repos: { allow: ['not a repo'], deny: [] }, schedule: { ...cfg.schedule, pollIntervalSec: 1 } });
    assert.equal(res.ok, false);
    if (res.ok) return;
    const paths = res.issues.map((i) => i.path);
    assert.ok(paths.includes('repos.allow.0'));
    assert.ok(paths.includes('schedule.pollIntervalSec'));
    assert.deepEqual(cfg.repos.allow, ['acme/api']);
  });

  it('turns a pasted GitHub link into owner/repo', () => {
    const cfg = new SettingsStore(db);
    const res = cfg.update({ ...cfg.all, repos: { allow: ['https://github.com/acme/api/pull/12', 'github.com/acme/web.git'], deny: [] } });
    assert.ok(res.ok);
    assert.deepEqual(cfg.repos.allow, ['acme/api', 'acme/web']);
  });

  it('applies the first matching per-repo mode', () => {
    const cfg = new SettingsStore(db);
    cfg.update({ ...cfg.all, defaultMode: 'draft', repoModes: [{ repo: 'acme/web', mode: 'publish' }, { repo: 'acme/*', mode: 'draft' }] });
    assert.equal(cfg.modeFor('acme/web'), 'publish');
    assert.equal(cfg.modeFor('acme/api'), 'draft');
  });

  it('imports an old reviewer.config.json once, then renames it', () => {
    const file = path.join(dir, 'reviewer.config.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        repos: { allow: ['acme/api'] },
        dryRun: true,
        repoModes: { 'acme/web': 'publish' },
        models: { provider: 'claude', main: { provider: 'claude' }, crossVerify: false },
        server: { host: '127.0.0.1', port: 4477 },
        dataDir: './data',
      }),
    );
    const cfg = new SettingsStore(db);
    const message = cfg.importLegacyFile(file);
    assert.match(message ?? '', /Imported/);
    assert.deepEqual(cfg.repos.allow, ['acme/api']);
    assert.equal(cfg.models.provider, 'claude');
    assert.equal(cfg.modeFor('acme/web'), 'publish');
    assert.ok(!fs.existsSync(file));
    assert.ok(fs.existsSync(path.join(dir, 'reviewer.config.imported.json')));
    // Once settings are stored, an old file is never read again.
    fs.writeFileSync(file, JSON.stringify({ repos: { allow: ['other/repo'] } }));
    assert.equal(new SettingsStore(db).importLegacyFile(file), null);
  });
});
