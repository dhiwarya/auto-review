import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The app's own credentials, so nothing it posts can contain one, whatever format it has.
// The review agents can read files and, in Docker, the app's environment, so a PR that
// manipulates one could try to slip a token into its output.

const ENV_KEYS = ['GITHUB_TOKEN', 'GH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_ACCESS_TOKEN'];
const MIN_LENGTH = 16;

// String values under token-like keys in a CLI's credentials file.
function fromCredentialsFile(file: string): string[] {
  let data: unknown;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const out: string[] = [];
  const walk = (value: unknown, key: string) => {
    if (typeof value === 'string') {
      if (/token|key|secret/i.test(key)) out.push(value);
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, k);
    }
  };
  walk(data, '');
  return out;
}

export function ownSecrets(extra: string[] = []): string[] {
  const home = os.homedir();
  const codexHome = process.env.CODEX_HOME || path.join(home, '.codex');
  const claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  const values = [
    ...extra,
    ...ENV_KEYS.map((k) => process.env[k] ?? ''),
    ...fromCredentialsFile(path.join(codexHome, 'auth.json')),
    ...fromCredentialsFile(path.join(claudeHome, '.credentials.json')),
  ];
  return [...new Set(values.map((v) => v.trim()).filter((v) => v.length >= MIN_LENGTH))];
}

// Whether any of the texts contains one of the secrets.
export const containsSecret = (texts: string[], secrets: string[]) => texts.some((t) => secrets.some((s) => t.includes(s)));
