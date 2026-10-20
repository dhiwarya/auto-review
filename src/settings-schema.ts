// What can be configured, with defaults. Edited from the dashboard's Settings page and
// stored in the app's database. Only zod is imported so the dashboard can share the types.
import { z } from 'zod';

const provider = z.enum(['claude', 'codex']);
const mode = z.enum(['draft', 'publish']);
// A pasted GitHub link becomes owner/repo.
const repoPattern = z
  .string()
  .trim()
  .transform((v) => {
    const link = /^(?:https?:\/\/)?github\.com\/([^/\s]+)\/([^/\s#?]+)/i.exec(v);
    return link ? `${link[1]}/${link[2].replace(/\.git$/, '')}` : v;
  })
  .pipe(z.string().regex(/^[\w.*?-]+\/[\w.*?-]+$/, 'Use owner/repo, or a pattern such as owner/*'));
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use 24-hour HH:MM');
const int = (min: number, max: number) => z.number().int().min(min).max(max);

// A provider's models, tried in order. null = the CLI's own default model.
const providerModels = z.object({
  model: z.string().trim().min(1).nullable().default(null),
  fallbackModels: z.array(z.string().trim().min(1)).default([]),
});

export const SettingsSchema = z.object({
  // Nothing outside this list is ever reviewed. Empty until you add repos in Settings.
  repos: z
    .object({
      allow: z.array(repoPattern).default([]),
      deny: z.array(repoPattern).default([]),
    })
    .prefault({}),
  // While true, reviews run but nothing is posted to GitHub and no labels change.
  dryRun: z.boolean().default(true),
  defaultMode: mode.default('draft'),
  // Per-repo mode overrides; the first matching pattern wins.
  repoModes: z.array(z.object({ repo: repoPattern, mode })).default([]),
  skipAuthors: z.array(z.string().trim().min(1)).default(['dependabot[bot]', 'renovate[bot]', 'github-actions[bot]']),
  excludeGlobs: z
    .array(z.string().trim().min(1))
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
  models: z
    .object({
      // The one provider that does a whole review.
      provider: provider.default('codex'),
      // When every model of that provider is unavailable (usage limit, signed out), use the other one.
      fallbackToOther: z.boolean().default(true),
      // Re-check blockers and majors in a second, separate run before posting them.
      doubleCheck: z.boolean().default(true),
      codex: providerModels.prefault({ model: 'gpt-6.1-sol', fallbackModels: ['gpt-6-sol'] }),
      claude: providerModels.prefault({ model: 'claude-opus-5-5', fallbackModels: ['claude-opus-4-8'] }),
      claudeEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).nullable().default(null),
    })
    .prefault({}),
  schedule: z
    .object({
      // GitHub allows 30 search requests a minute; each check uses one.
      pollIntervalSec: int(5, 3600).default(5),
      // How often to check which comments you kept in submitted drafts.
      syncIntervalSec: int(30, 3600).default(60),
      maxReviewsPerHour: int(1, 100).default(6),
      concurrency: int(1, 4).default(1),
      // Optional daily window (local time) where no reviews start, to keep your quota for yourself.
      pauseBetween: z.object({ start: clock, end: clock }).nullable().default(null),
      // How long to rest a model after it reports a usage limit.
      quotaBackoffMin: int(1, 1440).default(30),
    })
    .prefault({}),
  limits: z
    .object({
      // Above this many changed lines (after exclusions) the review covers top risks only.
      largePrLines: int(100, 100_000).default(1500),
      maxDiffChars: int(10_000, 1_000_000).default(200_000),
      maxNits: int(0, 20).default(5),
      passTimeoutSec: int(60, 3600).default(900),
      claudeMaxTurns: int(5, 200).default(60),
      maxAttempts: int(1, 10).default(3),
    })
    .prefault({}),
  labels: z
    .object({
      prefix: z
        .string()
        .trim()
        .regex(/^[\w.-]{1,30}$/, 'Letters, numbers, dots, dashes and underscores, up to 30')
        .default('ai-review'),
      // In draft mode the author can't see the draft yet, so by default the blocker
      // label waits until you submit the review with at least one blocker kept.
      blockerLabelInDraft: z.boolean().default(false),
    })
    .prefault({}),
  // Keep each PR checkout after its review, for debugging.
  keepCheckouts: z.boolean().default(false),
});

export type Settings = z.infer<typeof SettingsSchema>;

export interface SettingsIssue {
  path: string; // e.g. "repos.allow.0"
  message: string;
}
