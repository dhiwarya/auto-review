import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import { z } from 'zod';
import type { Provider, ReviewMode } from './types.ts';

const provider = z.enum(['claude', 'codex']);

// A provider's models, tried in order. null = the CLI's own default model.
const providerModels = z.object({
  model: z.string().nullable().default(null),
  fallbackModels: z.array(z.string()).default([]),
});

const ConfigSchema = z.object({
  // Repos the bot may review, as "owner/repo" globs. Nothing outside this list is ever reviewed.
  repos: z.object({
    allow: z.array(z.string()).min(1),
    deny: z.array(z.string()).default([]),
  }),
  // While true, reviews run but nothing is posted to GitHub and no labels change.
  dryRun: z.boolean().default(true),
  defaultMode: z.enum(['draft', 'publish']).default('draft'),
  // Per-repo override of defaultMode, e.g. { "my-org/api": "publish" }.
  repoModes: z.record(z.string(), z.enum(['draft', 'publish'])).default({}),
  skipAuthors: z.array(z.string()).default(['dependabot[bot]', 'renovate[bot]', 'github-actions[bot]']),
  excludeGlobs: z
    .array(z.string())
    .default([
      '**/package-lock.json',
      '**/pnpm-lock.yaml',
      '**/yarn.lock',
      '**/*.lock',
      '**/go.sum',
      '**/vendor/**',
      '**/dist/**',
      '**/*.min.js',
      '**/*.snap',
      '**/*.generated.*',
    ]),
  limits: z
    .object({
      // Above this many changed lines (after exclusions) the review covers top risks only.
      largePrLines: z.number().int().positive().default(1500),
      maxDiffChars: z.number().int().positive().default(200_000),
      maxNits: z.number().int().min(0).default(5),
      passTimeoutSec: z.number().int().positive().default(900),
      claudeMaxTurns: z.number().int().positive().default(60),
      maxAttempts: z.number().int().positive().default(3),
    })
    .default({
      largePrLines: 1500,
      maxDiffChars: 200_000,
      maxNits: 5,
      passTimeoutSec: 900,
      claudeMaxTurns: 60,
      maxAttempts: 3,
    }),
  schedule: z
    .object({
      // GitHub allows 30 search requests a minute; each check uses one.
      pollIntervalSec: z.number().int().min(5).default(5),
      // How often to check which comments you kept in submitted drafts.
      syncIntervalSec: z.number().int().min(30).default(60),
      maxReviewsPerHour: z.number().int().positive().default(6),
      concurrency: z.number().int().min(1).max(4).default(1),
      // Optional daily window (local time) where no reviews start, to keep your quota for yourself.
      pauseBetween: z
        .object({ start: z.string().regex(/^\d\d:\d\d$/), end: z.string().regex(/^\d\d:\d\d$/) })
        .nullable()
        .default(null),
      // How long to back off a provider after it reports a usage limit.
      quotaBackoffMin: z.number().int().positive().default(30),
    })
    .default({
      pollIntervalSec: 5,
      syncIntervalSec: 60,
      maxReviewsPerHour: 6,
      concurrency: 1,
      pauseBetween: null,
      quotaBackoffMin: 30,
    }),
  models: z
    .object({
      // The one provider that does a whole review. Editable from the dashboard's Settings page.
      provider: provider.default('codex'),
      // When every model of that provider is unavailable (usage limit, not signed in), use the other one.
      fallbackToOther: z.boolean().default(true),
      // Re-check blockers and majors in a second, separate run before posting them.
      doubleCheck: z.boolean().default(true),
      claude: providerModels.default({ model: 'claude-opus-5-5', fallbackModels: ['claude-opus-4-8'] }),
      codex: providerModels.default({ model: 'gpt-6.1-sol', fallbackModels: ['gpt-6-sol'] }),
      claudeEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable().default(null),
    })
    .default({
      provider: 'codex',
      fallbackToOther: true,
      doubleCheck: true,
      claude: { model: 'claude-opus-5-5', fallbackModels: ['claude-opus-4-8'] },
      codex: { model: 'gpt-6.1-sol', fallbackModels: ['gpt-6-sol'] },
      claudeEffort: null,
    }),
  labels: z
    .object({
      prefix: z.string().default('ai-review'),
      // In draft mode the author can't see the draft yet, so by default the blocker
      // label waits until you submit the review with at least one blocker kept.
      blockerLabelInDraft: z.boolean().default(false),
    })
    .default({ prefix: 'ai-review', blockerLabelInDraft: false }),
  server: z
    .object({
      host: z.string().default('127.0.0.1'),
      port: z.number().int().default(4477),
    })
    .default({ host: '127.0.0.1', port: 4477 }),
  dataDir: z.string().default('./data'),
  keepCheckouts: z.boolean().default(false),
});

export type Config = z.infer<typeof ConfigSchema>;

export interface LoadedConfig extends Config {
  configPath: string;
  dataPath: string;
  isRepoAllowed(repo: string): boolean;
  isExcludedFile(file: string): boolean;
  modeFor(repo: string): ReviewMode;
  labelName(kind: 'running' | 'done' | 'blocker' | 'failed'): string;
  modelChain(p: Provider): (string | null)[];
  providerOrder(): Provider[];
}

export const ModelSettings = z
  .object({
    provider,
    fallbackToOther: z.boolean(),
    doubleCheck: z.boolean(),
  })
  .partial()
  .strict();
export type ModelSettings = z.infer<typeof ModelSettings>;

// Saves settings changed in the dashboard back to the config file, so the file stays the
// single source of truth, and applies them to the running app straight away.
export function saveModelSettings(cfg: LoadedConfig, patch: ModelSettings) {
  const raw = JSON.parse(fs.readFileSync(cfg.configPath, 'utf8'));
  raw.models = { ...(raw.models ?? {}), ...patch };
  // Settings from before one provider did the whole review; they no longer have any effect.
  for (const legacy of ['main', 'security', 'crossVerify']) delete raw.models[legacy];
  fs.writeFileSync(cfg.configPath, `${JSON.stringify(raw, null, 2)}\n`);
  Object.assign(cfg.models, patch);
}

export function loadConfig(): LoadedConfig {
  const configPath = path.resolve(process.env.REVIEWER_CONFIG ?? 'reviewer.config.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `No config at ${configPath}. Copy reviewer.config.example.json to reviewer.config.json and edit repos.allow.`,
    );
  }
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid ${configPath}:\n${z.prettifyError(parsed.error)}`);
  }
  const cfg = parsed.data;
  const allow = picomatch(cfg.repos.allow.map((p) => p.toLowerCase()));
  const deny = cfg.repos.deny.length ? picomatch(cfg.repos.deny.map((p) => p.toLowerCase())) : () => false;
  const excluded = picomatch(cfg.excludeGlobs, { dot: true });
  const dataPath = path.resolve(path.dirname(configPath), cfg.dataDir);
  fs.mkdirSync(dataPath, { recursive: true });

  return {
    ...cfg,
    configPath,
    dataPath,
    isRepoAllowed: (repo) => allow(repo.toLowerCase()) && !deny(repo.toLowerCase()),
    isExcludedFile: (file) => excluded(file),
    modeFor: (repo) => {
      const hit = Object.entries(cfg.repoModes).find(([glob]) => picomatch.isMatch(repo.toLowerCase(), glob.toLowerCase()));
      return hit ? hit[1] : cfg.defaultMode;
    },
    labelName: (kind) => `${cfg.labels.prefix}:${kind}`,
    // The chosen provider first, then the other one if falling back is on.
    // Reads cfg.models on each call: it's the same object the dashboard's Settings page updates.
    providerOrder: () => {
      const first = cfg.models.provider;
      const other: Provider = first === 'claude' ? 'codex' : 'claude';
      return cfg.models.fallbackToOther ? [first, other] : [first];
    },
    modelChain: (p) => {
      const m = cfg.models[p];
      return [...new Set([m.model, ...m.fallbackModels])];
    },
  };
}
