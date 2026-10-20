// Types shared by the server and the dashboard.

export type Provider = 'claude' | 'codex';
export type ReviewMode = 'draft' | 'publish';
export type Pass = 'main' | 'security';

export type JobState =
  | 'queued'
  | 'running'
  | 'waiting' // blocked on something outside us: usage limits, an unsubmitted draft
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'skipped';

export const ACTIVE_STATES: JobState[] = ['queued', 'running', 'waiting'];

export type Severity = 'blocker' | 'major' | 'minor' | 'nit';
export const SEVERITIES: Severity[] = ['blocker', 'major', 'minor', 'nit'];

export type Category = 'bug' | 'security' | 'requirement' | 'design' | 'test' | 'performance';
export type Confidence = 'high' | 'medium' | 'low';
export type SpecStatus = 'aligned' | 'partial' | 'misaligned' | 'no_spec' | 'not_checked';
export type Verification = 'confirmed' | 'refuted' | 'uncertain' | 'skipped' | 'not_needed';

// Where a finding ended up.
export type FindingStatus = 'inline' | 'summary' | 'dropped';

// What you did with it on GitHub. Only tracked for draft reviews.
export type Outcome = 'pending' | 'kept' | 'edited' | 'deleted' | 'published' | 'unknown';

export interface Job {
  id: number;
  repo: string;
  pr_number: number;
  pr_title: string;
  pr_url: string;
  author: string;
  head_sha: string;
  base_sha: string;
  since_sha: string | null;
  mode: ReviewMode;
  source: 'request' | 'manual';
  dry_run: number;
  state: JobState;
  step: string | null;
  progress: number;
  attempts: number;
  next_attempt_at: string | null;
  error: string | null;
  skip_reason: string | null;
  review_id: number | null;
  review_url: string | null;
  review_state: string | null;
  review_body: string | null;
  spec_status: SpecStatus | null;
  additions: number;
  deletions: number;
  changed_files: number;
  label_ok: number | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
  // Filled in by list queries.
  counts?: Record<Severity, number>;
}

export interface Finding {
  id: number;
  job_id: number;
  pass: Pass;
  model: Provider;
  model_id: string | null; // e.g. claude-opus-5-5
  category: Category;
  severity: Severity;
  original_severity: Severity;
  confidence: Confidence;
  file: string;
  line: number | null;
  title: string;
  evidence: string;
  problem: string;
  suggestion: string;
  verification: Verification;
  verified_by: Provider | null;
  verify_reason: string | null;
  status: FindingStatus;
  drop_reason: string | null;
  comment_id: number | null;
  outcome: Outcome | null;
  resolved_by_job: number | null;
  created_at: string;
}

export interface JobEvent {
  id: number;
  job_id: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  created_at: string;
}

export interface Run {
  id: number;
  job_id: number;
  purpose: string; // main | security | verify
  provider: Provider;
  model: string | null;
  ok: number;
  fell_back: number;
  duration_ms: number;
  error: string | null;
  turns: number | null;
  tool_calls: number | null;
  input_tokens: number | null;
  cached_input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  created_at: string;
}

export interface ModelStatus {
  model: string | null; // null = the CLI's default model
  blocked_until: string | null;
  last_error: string | null;
}

export interface ProviderStatus {
  provider: Provider;
  // Set when none of the provider's models can take work: the earliest time one can.
  blocked_until: string | null;
  last_error: string | null;
  // The model the next run will use, if any is available.
  active_model: string | null;
  models: ModelStatus[]; // the fallback chain, in order
}

export interface ReviewerSettings {
  provider: Provider;
  fallbackToOther: boolean;
  doubleCheck: boolean;
}

export interface GitHubStatus {
  limits: { resource: string; limit: number; remaining: number; reset: string }[];
  watching: { repo: string; ok: boolean; error: string | null; openPrs: number; requestingYou: number; checkedAt: string | null }[];
  paused_until: string | null;
  pause_reason: string | null;
  // The last check: requests sent, and how many came back "not modified" (free).
  last_cycle: { requests: number; notModified: number } | null;
}

export interface Overview {
  me: string | null;
  github_auth: string;
  settings: ReviewerSettings;
  // No repos configured yet: nothing is reviewed until you add some in Settings.
  needs_setup: boolean;
  dry_run: boolean;
  default_mode: ReviewMode;
  counts: Record<JobState, number>;
  last_poll_at: string | null;
  next_poll_at: string | null;
  last_poll_error: string | null;
  providers: ProviderStatus[];
  paused_reason: string | null;
  github: GitHubStatus;
}

export interface JobDetail {
  job: Job;
  findings: Finding[];
  events: JobEvent[];
  runs: Run[];
}

export type LeaderboardKind = 'models' | 'repos' | 'authors';

export interface LeaderboardRow {
  key: string;
  [metric: string]: string | number | null;
}

export interface Leaderboard {
  kind: LeaderboardKind;
  columns: { key: string; label: string; hint?: string; format?: 'pct' | 'num' | 'ms' | 'tokens' }[];
  rows: LeaderboardRow[];
}

export type StreamMessage =
  | { type: 'job'; job: Job }
  | { type: 'overview'; overview: Overview };
