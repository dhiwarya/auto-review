// Types shared by the server and the dashboard.

export type Provider = 'claude' | 'codex';
export type ReviewMode = 'draft' | 'publish';
export type Pass = 'main' | 'security' | 'adversarial';

export type JobState =
  | 'queued'
  | 'running'
  | 'waiting' // blocked on something outside us: usage limits, an unsubmitted draft
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'skipped';

export const ACTIVE_STATES: JobState[] = ['queued', 'running', 'waiting'];

// review: reads the code (all of it, or the commits since the last review).
// recheck: the review was requested again with no new commits, so it re-checks the
// findings still open from earlier reviews instead of reviewing the code again.
export type JobKind = 'review' | 'recheck' | 'audit';

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
  kind: JobKind;
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
  // How sure the review is that nothing blocks the PR, and what lowered it (one per line).
  confidence: Confidence | null;
  confidence_notes: string | null;
  // Why the review didn't approve the PR; null when it did, or when it could have.
  approve_note: string | null;
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
  review_policy?: string | null;
  review_report?: string | null;
}

export interface StrictCoverage {
  section_id: string;
  status: 'examined' | 'unverified';
  dependencies: string[];
  tests: string[];
  configuration: string[];
  notes: string;
}

export interface StrictStage {
  key: string;
  purpose: string;
  provider: Provider | null;
  model: string | null;
  state: 'done' | 'incomplete';
  error: string | null;
  coverage: StrictCoverage[];
}

export interface StrictReport {
  version: number;
  sections: { id: string; file: string }[];
  excluded: string[];
  stages: StrictStage[];
  gaps: string[];
  approvalBlocks: string[];
  complete: boolean;
  inheritedFrom?: number;
  requirements?: { stage: string; ref: string; status: string; reason: string }[];
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
  // The inline comment exactly as posted, to tell later whether you edited it.
  posted_body: string | null;
  created_at: string;
}

export interface JobEvent {
  id: number;
  job_id: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  created_at: string;
}

// What a review gathered before any model ran: the diff, linked issues and PRs, guidelines
// and history. One per job; a re-check has no diff of its own, but reads the discussion.
export interface Evidence {
  diff: {
    baseSha: string;
    headSha: string;
    sinceSha: string | null; // set for a follow-up of only the new commits
    prFiles: number; // every file in the PR, even when only some are reviewed
    files: EvidenceFile[];
    changedLines: number;
    diffChars: number;
    maxDiffChars: number;
    large: boolean;
  } | null;
  issues: { ref: string; title: string; url: string; comments: number; linkedBy: 'closes' | 'mentioned' }[];
  prs: { ref: string; title: string; url: string }[]; // other PRs the description mentions
  guidelines: string[];
  history: { file: string; commits: number }[];
  previousFindings: number;
  discussion: { threadReplies: number; conversation: number } | null; // re-checks only
  promptChars: number;
}

// reviewed: its diff is in the prompt. too_long: the diff didn't fit, the model was told
// to read the file. excluded: a lock or generated file.
export interface EvidenceFile {
  name: string;
  status: string;
  additions: number;
  deletions: number;
  state: 'reviewed' | 'too_long' | 'excluded';
}

export type StepKind = 'start' | 'command' | 'tool' | 'reasoning' | 'message' | 'output' | 'error';
export type StepStatus = 'running' | 'ok' | 'failed';

// One thing a model did during a run, recorded as it happens. `detail` (command output, a
// tool's result, the full message) is loaded separately, when a step is opened.
export interface Step {
  id: number;
  job_id: number;
  run_key: string; // one model run; matches Run.run_key once the run has finished
  purpose: string;
  provider: Provider;
  model: string | null;
  ref: string | null; // the CLI's own id for the item, to pair a start with its result
  kind: StepKind;
  title: string;
  status: StepStatus;
  detail_chars: number;
  created_at: string;
  updated_at: string;
}

export interface Run {
  id: number;
  job_id: number;
  run_key: string | null; // null for runs made before steps were recorded
  prompt_chars: number | null;
  output: string | null; // the structured answer, as JSON
  purpose: string; // main | security | verify | recheck
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
  profile?: 'standard' | 'strict';
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
  evidence: Evidence | null; // null for reviews made before evidence was recorded
  steps: Step[];
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
  | { type: 'steps'; jobId: number } // a model run of this job did something
  | { type: 'overview'; overview: Overview };

// What posting a dry-run review would do, checked against the PR as it is now.
export interface PostPreview {
  inline: number;
  inSummary: number;
  reviewedSha: string;
  currentSha: string;
  defaultMode: ReviewMode;
  // Publishing approves the PR when approveNote is null, and requests changes when
  // requestChanges is set (a re-check with blockers or majors still open).
  approveNote: string | null;
  requestChanges: boolean;
  labels: Record<ReviewMode, string>;
}
