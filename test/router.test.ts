import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { Db } from '../src/db.ts';
import { NoProviderAvailable, Router } from '../src/llm/router.ts';
import { SettingsStore } from '../src/settings.ts';

// Stand-in CLIs: each reads how to behave for the requested model from a file next to it.
const FAKE_CLAUDE = `#!/bin/sh
model=""; prev=""
for a in "$@"; do [ "$prev" = "--model" ] && model="$a"; prev="$a"; done
b=$(cat "$(dirname "$0")/claude.$model" 2>/dev/null || echo ok)
cat > /dev/null
case "$b" in
  model) echo '{"type":"result","is_error":true,"subtype":"error","result":"The model '"$model"' is not available on your plan"}'; exit 1;;
  quota) echo '{"type":"result","is_error":true,"subtype":"error","result":"Claude usage limit reached"}'; exit 1;;
  *) echo '{"type":"result","is_error":false,"subtype":"success","result":"","structured_output":{"ran":"'"$model"'"}}';;
esac
`;

const FAKE_CODEX = `#!/bin/sh
model=""; out=""; prev=""
for a in "$@"; do [ "$prev" = "-m" ] && model="$a"; [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
b=$(cat "$(dirname "$0")/codex.$model" 2>/dev/null || echo ok)
cat > /dev/null
case "$b" in
  auth) echo "Error: Not logged in" >&2; exit 1;;
  quota) echo "You've hit your usage limit" >&2; exit 1;;
  *) printf '{"ran":"%s"}' "$model" > "$out";;
esac
`;

describe('Router model fallback', { skip: process.platform === 'win32' && 'uses shell stand-ins' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prr-router-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'codex'), FAKE_CODEX, { mode: 0o755 });
  const behave = (cli: string, model: string, b: string) => fs.writeFileSync(path.join(bin, `${cli}.${model}`), b);

  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${oldPath}`;
  const db = new Db(dir);
  const cfg = new SettingsStore(db);
  const base = SettingsStore.defaults();
  const saved = cfg.update({ ...base, repos: { allow: ['a/b'], deny: [] }, models: { ...base.models, provider: 'claude', fallbackToOther: true } });
  assert.ok(saved.ok);
  const router = new Router(db, cfg);
  const job = db.insertJob({
    repo: 'a/b', pr_number: 1, pr_title: 't', pr_url: '', author: 'x', head_sha: 'h', base_sha: 'b', since_sha: null,
    mode: 'draft', source: 'manual', dry_run: 1, state: 'queued', additions: 0, deletions: 0, changed_files: 0,
  });
  const task = { cwd: dir, workDir: dir, instructions: 'rules', prompt: 'pr', schema: { type: 'object' }, timeoutMs: 10_000 };

  after(() => {
    process.env.PATH = oldPath;
    db.sql.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('uses the first-choice model when it works', async () => {
    const res = await router.run(job.id, 'main', task);
    assert.equal(res.model, 'claude-opus-5-5');
    assert.deepEqual(res.output, { ran: 'claude-opus-5-5' });
  });

  it('falls back to the next model of the same provider', async () => {
    behave('claude', 'claude-opus-5-5', 'model');
    const res = await router.run(job.id, 'main', task);
    assert.equal(res.provider, 'claude');
    assert.equal(res.model, 'claude-opus-4-8');
    const status = router.status().find((s) => s.provider === 'claude')!;
    assert.equal(status.active_model, 'claude-opus-4-8');
    assert.ok(status.models[0].blocked_until, 'first-choice model is paused');
    assert.equal(status.blocked_until, null, 'provider is still usable');
  });

  it('skips a paused model without calling it again', async () => {
    behave('claude', 'claude-opus-5-5', 'ok'); // would work now, but it is paused
    const res = await router.run(job.id, 'main', task);
    assert.equal(res.model, 'claude-opus-4-8');
  });

  it('moves to the other provider when every model is out', async () => {
    behave('claude', 'claude-opus-4-8', 'quota');
    const res = await router.run(job.id, 'main', task);
    assert.equal(res.provider, 'codex');
    assert.equal(res.model, 'gpt-6.1-sol');
  });

  it('pauses the whole provider when it is not signed in, then reports when to retry', async () => {
    behave('codex', 'gpt-6.1-sol', 'auth');
    await assert.rejects(router.run(job.id, 'security', task), NoProviderAvailable);
    const codex = router.status().find((s) => s.provider === 'codex')!;
    assert.ok(codex.blocked_until);
    assert.match(codex.last_error ?? '', /^auth/);
    // gpt-6-sol was never tried: being signed out applies to every model.
    const tried = db.runs(job.id).filter((r) => r.provider === 'codex').map((r) => r.model);
    assert.ok(!tried.includes('gpt-6-sol'));
  });

  it('clearing a provider makes its models available again', async () => {
    behave('claude', 'claude-opus-4-8', 'ok');
    router.clear('claude');
    const res = await router.run(job.id, 'main', task);
    assert.equal(res.model, 'claude-opus-5-5');
  });

  it('switching the provider in Settings applies at once and is saved', async () => {
    router.clear('codex');
    behave('codex', 'gpt-6.1-sol', 'ok');
    const all = cfg.all;
    assert.ok(cfg.update({ ...all, models: { ...all.models, provider: 'codex' } }).ok);
    assert.deepEqual(cfg.providerOrder(), ['codex', 'claude']);
    const res = await router.run(job.id, 'main', task);
    assert.equal(res.provider, 'codex');
    const reloaded = new SettingsStore(db);
    assert.equal(reloaded.models.provider, 'codex');
    assert.equal(reloaded.models.codex.model, 'gpt-6.1-sol', 'other settings are kept');
  });

  it('with falling back turned off, never touches the other provider', async () => {
    const all = cfg.all;
    assert.ok(cfg.update({ ...all, models: { ...all.models, fallbackToOther: false } }).ok);
    behave('codex', 'gpt-6.1-sol', 'quota');
    behave('codex', 'gpt-6-sol', 'quota');
    const claudeRunsBefore = db.runs(job.id).filter((r) => r.provider === 'claude').length;
    await assert.rejects(router.run(job.id, 'main', task), NoProviderAvailable);
    assert.equal(db.runs(job.id).filter((r) => r.provider === 'claude').length, claudeRunsBefore);
  });
});

describe('Provider defaults', () => {
  it('uses Codex first and Claude as the fallback until you change it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prr-defaults-'));
    const db = new Db(dir);
    try {
      const cfg = new SettingsStore(db);
      assert.equal(cfg.models.provider, 'codex');
      assert.deepEqual(cfg.providerOrder(), ['codex', 'claude']);
      assert.deepEqual(cfg.modelChain('codex'), ['gpt-6.1-sol', 'gpt-6-sol']);
      assert.deepEqual(cfg.modelChain('claude'), ['claude-opus-5-5', 'claude-opus-4-8']);
    } finally {
      db.sql.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
