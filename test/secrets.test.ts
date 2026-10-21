import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { scrubText } from '../src/review/validate.ts';
import { containsSecret, ownSecrets } from '../src/secrets.ts';

describe('the app’s own credentials', () => {
  it('come from the environment and the CLIs’ credential files, skipping short values', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prr-secrets-'));
    const saved = { CODEX_HOME: process.env.CODEX_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, GITHUB_TOKEN: process.env.GITHUB_TOKEN };
    try {
      fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'codex-access-0123456789', refresh_token: 'codex-refresh-0123456789', account_id: 'acct' } }));
      fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'claude-access-0123456789', expiresAt: 1 } }));
      process.env.CODEX_HOME = dir;
      process.env.CLAUDE_CONFIG_DIR = dir;
      process.env.GITHUB_TOKEN = 'short';
      const secrets = ownSecrets(['gho_from-the-gh-cli-0123']);
      assert.deepEqual(secrets.sort(), ['claude-access-0123456789', 'codex-access-0123456789', 'codex-refresh-0123456789', 'gho_from-the-gh-cli-0123']);
      assert.ok(containsSecret(['a', 'x codex-refresh-0123456789 y'], secrets));
      assert.ok(!containsSecret(['nothing here'], secrets));
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('are redacted from posted text, and flagged when the PR did not add them', () => {
    const key = `ghp_${'a'.repeat(36)}`;
    assert.deepEqual(scrubText(`Uses ${key} here`, ''), { text: 'Uses ghp_…[redacted] here', smuggled: true });
    assert.deepEqual(scrubText(`Commits ${key}`, `const k = "${key}"`), { text: 'Commits ghp_…[redacted]', smuggled: false });
    assert.deepEqual(scrubText('Nothing secret', ''), { text: 'Nothing secret', smuggled: false });
  });
});
