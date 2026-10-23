import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { bus } from './bus.ts';
import type { Evidence, Finding, Job, JobEvent, JobState, Run, Severity, Step } from './types.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  pr_title TEXT NOT NULL DEFAULT '',
  pr_url TEXT NOT NULL DEFAULT '',
  author TEXT NOT NULL DEFAULT '',
  head_sha TEXT NOT NULL,
  base_sha TEXT NOT NULL DEFAULT '',
  since_sha TEXT,
  kind TEXT NOT NULL DEFAULT 'review',
  mode TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'request',
  dry_run INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  step TEXT,
  progress INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  error TEXT,
  skip_reason TEXT,
  review_id INTEGER,
  review_url TEXT,
  review_state TEXT,
  review_body TEXT,
  spec_status TEXT,
  additions INTEGER NOT NULL DEFAULT 0,
  deletions INTEGER NOT NULL DEFAULT 0,
  changed_files INTEGER NOT NULL DEFAULT 0,
  label_ok INTEGER,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  updated_at TEXT NOT NULL
);
`;

// Created after migrate(), because the unique index needs the kind column. One review per
// commit; a commit can be re-checked any number of times.
const JOB_INDEXES = `
CREATE INDEX IF NOT EXISTS jobs_state ON jobs (state);
CREATE INDEX IF NOT EXISTS jobs_pr ON jobs (repo, pr_number);
CREATE UNIQUE INDEX IF NOT EXISTS jobs_one_review ON jobs (repo, pr_number, head_sha) WHERE kind = 'review';
`;

const OTHER_TABLES = `
CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs (id),
  pass TEXT NOT NULL,
  model TEXT NOT NULL,
  model_id TEXT,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  original_severity TEXT NOT NULL,
  confidence TEXT NOT NULL,
  file TEXT NOT NULL,
  line INTEGER,
  title TEXT NOT NULL,
  evidence TEXT NOT NULL,
  problem TEXT NOT NULL,
  suggestion TEXT NOT NULL,
  verification TEXT NOT NULL DEFAULT 'not_needed',
  verified_by TEXT,
  verify_reason TEXT,
  status TEXT NOT NULL DEFAULT 'inline',
  drop_reason TEXT,
  comment_id INTEGER,
  outcome TEXT,
  resolved_by_job INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS findings_job ON findings (job_id);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs (id),
  purpose TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  ok INTEGER NOT NULL,
  fell_back INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL,
  error TEXT,
  turns INTEGER,
  tool_calls INTEGER,
  input_tokens INTEGER,
  cached_input_tokens INTEGER,
  output_tokens INTEGER,
  cost_usd REAL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs (id),
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_job ON events (job_id);

-- What each model run did, written as it happens. detail is the long part (command
-- output, a tool's result), kept out of listings.
CREATE TABLE IF NOT EXISTS steps (
  id INTEGER PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs (id),
  run_key TEXT NOT NULL,
  purpose TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT,
  ref TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS steps_job ON steps (job_id);
CREATE INDEX IF NOT EXISTS steps_ref ON steps (run_key, ref);

CREATE TABLE IF NOT EXISTS evidence (
  job_id INTEGER PRIMARY KEY REFERENCES jobs (id),
  json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

export const nowIso = () => new Date().toISOString();

export class Db {
  readonly sql: DatabaseSync;

  constructor(dataPath: string) {
    this.sql = new DatabaseSync(path.join(dataPath, 'reviewer.sqlite'));
    // node:sqlite turns foreign keys on by default; they stay off until any rebuild is done.
    this.sql.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF;');
    this.sql.exec(SCHEMA);
    this.dropReviewOnceConstraint();
    this.sql.exec('PRAGMA foreign_keys = ON;');
    this.sql.exec(OTHER_TABLES);
    this.migrate();
    this.sql.exec(JOB_INDEXES);
  }

  // Databases from before re-checks allow only one job per commit. SQLite can't drop a
  // table constraint, so the table is rebuilt without it (foreign keys are still off here).
  private dropReviewOnceConstraint() {
    const ddl = this.get<{ sql: string }>(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'`)?.sql ?? '';
    const constraint = /,\s*UNIQUE \(repo, pr_number, head_sha\)/;
    if (!constraint.test(ddl)) return;
    const cols = this.all<{ name: string }>('PRAGMA table_info(jobs)').map((c) => c.name).join(', ');
    this.sql.exec('BEGIN');
    try {
      this.sql.exec(ddl.replace(constraint, '').replace(/^CREATE TABLE (IF NOT EXISTS )?"?jobs"?/, 'CREATE TABLE jobs_rebuilt'));
      this.sql.exec(`INSERT INTO jobs_rebuilt (${cols}) SELECT ${cols} FROM jobs`);
      this.sql.exec('DROP TABLE jobs');
      this.sql.exec('ALTER TABLE jobs_rebuilt RENAME TO jobs');
      this.sql.exec('COMMIT');
    } catch (err) {
      this.sql.exec('ROLLBACK');
      throw err;
    }
  }

  // Columns added after the first release, for databases created before them.
  private migrate() {
    const added: [table: string, column: string, type: string][] = [
      ['findings', 'model_id', 'TEXT'],
      ['runs', 'turns', 'INTEGER'],
      ['runs', 'tool_calls', 'INTEGER'],
      ['runs', 'input_tokens', 'INTEGER'],
      ['runs', 'cached_input_tokens', 'INTEGER'],
      ['runs', 'output_tokens', 'INTEGER'],
      ['runs', 'cost_usd', 'REAL'],
      ['findings', 'posted_body', 'TEXT'],
      ['jobs', 'confidence', 'TEXT'],
      ['jobs', 'confidence_notes', 'TEXT'],
      ['jobs', 'approve_note', 'TEXT'],
      ['jobs', 'kind', "TEXT NOT NULL DEFAULT 'review'"],
      ['runs', 'run_key', 'TEXT'],
      ['runs', 'prompt_chars', 'INTEGER'],
      ['runs', 'output', 'TEXT'],
    ];
    for (const [table, column, type] of added) {
      const cols = this.all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name);
      if (!cols.includes(column)) this.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  all<T>(query: string, ...params: SQLInputValue[]): T[] {
    return this.sql.prepare(query).all(...params) as T[];
  }

  get<T>(query: string, ...params: SQLInputValue[]): T | undefined {
    return this.sql.prepare(query).get(...params) as T | undefined;
  }

  run(query: string, ...params: SQLInputValue[]) {
    return this.sql.prepare(query).run(...params);
  }

  // ---- jobs

  job(id: number): Job | undefined {
    return this.get<Job>('SELECT * FROM jobs WHERE id = ?', id);
  }

  insertJob(j: Pick<Job, 'repo' | 'pr_number' | 'pr_title' | 'pr_url' | 'author' | 'head_sha' | 'base_sha' | 'since_sha' | 'mode' | 'source' | 'dry_run' | 'state' | 'additions' | 'deletions' | 'changed_files'> & { kind?: Job['kind']; skip_reason?: string | null }): Job {
    const t = nowIso();
    const res = this.run(
      `INSERT INTO jobs (repo, pr_number, pr_title, pr_url, author, head_sha, base_sha, since_sha, kind, mode, source, dry_run, state,
         skip_reason, additions, deletions, changed_files, created_at, updated_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      j.repo, j.pr_number, j.pr_title, j.pr_url, j.author, j.head_sha, j.base_sha, j.since_sha, j.kind ?? 'review', j.mode, j.source, j.dry_run, j.state,
      j.skip_reason ?? null, j.additions, j.deletions, j.changed_files, t, t, j.state === 'skipped' ? t : null,
    );
    const job = this.job(Number(res.lastInsertRowid))!;
    bus.emitJob(this.withCounts(job));
    return job;
  }

  updateJob(id: number, patch: Partial<Job>): Job {
    const keys = Object.keys(patch).filter((k) => k !== 'id' && k !== 'counts');
    if (keys.length) {
      const sets = keys.map((k) => `${k} = ?`).join(', ');
      const values = keys.map((k) => (patch as Record<string, SQLInputValue>)[k] ?? null);
      this.run(`UPDATE jobs SET ${sets}, updated_at = ? WHERE id = ?`, ...values, nowIso(), id);
    }
    const job = this.job(id)!;
    bus.emitJob(this.withCounts(job));
    return job;
  }

  setState(id: number, state: JobState, patch: Partial<Job> = {}): Job {
    const terminal = state === 'done' || state === 'failed' || state === 'cancelled' || state === 'skipped';
    return this.updateJob(id, { ...patch, state, ...(terminal ? { finished_at: nowIso() } : {}) });
  }

  jobsForPr(repo: string, prNumber: number): Job[] {
    return this.all<Job>('SELECT * FROM jobs WHERE repo = ? AND pr_number = ? ORDER BY id DESC', repo, prNumber);
  }

  withCounts(job: Job): Job {
    const rows = this.all<{ severity: Severity; n: number }>(
      `SELECT severity, COUNT(*) AS n FROM findings WHERE job_id = ? AND status != 'dropped' GROUP BY severity`,
      job.id,
    );
    const counts = { blocker: 0, major: 0, minor: 0, nit: 0 } as Record<Severity, number>;
    for (const r of rows) counts[r.severity] = r.n;
    return { ...job, counts };
  }

  // ---- findings, runs, events

  insertFinding(f: Omit<Finding, 'id' | 'created_at' | 'resolved_by_job' | 'posted_body'>): Finding {
    const res = this.run(
      `INSERT INTO findings (job_id, pass, model, model_id, category, severity, original_severity, confidence, file, line, title,
         evidence, problem, suggestion, verification, verified_by, verify_reason, status, drop_reason, comment_id, outcome, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      f.job_id, f.pass, f.model, f.model_id, f.category, f.severity, f.original_severity, f.confidence, f.file, f.line, f.title,
      f.evidence, f.problem, f.suggestion, f.verification, f.verified_by, f.verify_reason, f.status, f.drop_reason,
      f.comment_id, f.outcome, nowIso(),
    );
    return this.get<Finding>('SELECT * FROM findings WHERE id = ?', Number(res.lastInsertRowid))!;
  }

  updateFinding(id: number, patch: Partial<Finding>) {
    const keys = Object.keys(patch).filter((k) => k !== 'id');
    if (!keys.length) return;
    const values = keys.map((k) => (patch as Record<string, SQLInputValue>)[k] ?? null);
    this.run(`UPDATE findings SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...values, id);
  }

  findings(jobId: number): Finding[] {
    return this.all<Finding>('SELECT * FROM findings WHERE job_id = ? ORDER BY id', jobId);
  }

  insertRun(r: Omit<Run, 'id' | 'created_at' | 'run_key' | 'prompt_chars' | 'output'> & Partial<Pick<Run, 'run_key' | 'prompt_chars' | 'output'>>) {
    this.run(
      `INSERT INTO runs (job_id, run_key, purpose, provider, model, ok, fell_back, duration_ms, error,
         turns, tool_calls, input_tokens, cached_input_tokens, output_tokens, cost_usd, prompt_chars, output, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      r.job_id, r.run_key ?? null, r.purpose, r.provider, r.model, r.ok, r.fell_back, r.duration_ms, r.error,
      r.turns, r.tool_calls, r.input_tokens, r.cached_input_tokens, r.output_tokens, r.cost_usd, r.prompt_chars ?? null,
      r.output ?? null, nowIso(),
    );
  }

  // Adds a step, or updates the one with the same ref in this run (a command finishing, a
  // tool's result arriving). Fields left out of an update keep their value.
  recordStep(s: Pick<Step, 'job_id' | 'run_key' | 'purpose' | 'provider' | 'model' | 'ref' | 'kind' | 'status'> & { title?: string; detail?: string | null }) {
    const t = nowIso();
    const existing = s.ref ? this.get<{ id: number }>('SELECT id FROM steps WHERE run_key = ? AND ref = ?', s.run_key, s.ref) : undefined;
    if (existing) {
      this.run(
        `UPDATE steps SET status = ?, title = COALESCE(?, title), detail = COALESCE(?, detail), updated_at = ? WHERE id = ?`,
        s.status, s.title ?? null, s.detail ?? null, t, existing.id,
      );
      return;
    }
    this.run(
      `INSERT INTO steps (job_id, run_key, purpose, provider, model, ref, kind, title, detail, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      s.job_id, s.run_key, s.purpose, s.provider, s.model, s.ref, s.kind, s.title ?? s.kind, s.detail ?? null, s.status, t, t,
    );
  }

  // Steps without their detail, which can be long.
  steps(jobId: number): Step[] {
    return this.all<Step>(
      `SELECT id, job_id, run_key, purpose, provider, model, ref, kind, title, status, LENGTH(COALESCE(detail, '')) AS detail_chars,
         created_at, updated_at FROM steps WHERE job_id = ? ORDER BY id`,
      jobId,
    );
  }

  stepDetail(id: number): string | null {
    return this.get<{ detail: string | null }>('SELECT detail FROM steps WHERE id = ?', id)?.detail ?? null;
  }

  setEvidence(jobId: number, evidence: Evidence) {
    this.run('INSERT INTO evidence (job_id, json) VALUES (?, ?) ON CONFLICT (job_id) DO UPDATE SET json = excluded.json', jobId, JSON.stringify(evidence));
  }

  evidence(jobId: number): Evidence | null {
    const row = this.get<{ json: string }>('SELECT json FROM evidence WHERE job_id = ?', jobId);
    return row ? (JSON.parse(row.json) as Evidence) : null;
  }

  runs(jobId: number): Run[] {
    return this.all<Run>('SELECT * FROM runs WHERE job_id = ? ORDER BY id', jobId);
  }

  event(jobId: number, message: string, level: JobEvent['level'] = 'info') {
    this.run('INSERT INTO events (job_id, level, message, created_at) VALUES (?, ?, ?, ?)', jobId, level, message, nowIso());
    const prefix = level === 'info' ? '' : `[${level}] `;
    console.log(`[job ${jobId}] ${prefix}${message}`);
  }

  events(jobId: number): JobEvent[] {
    return this.all<JobEvent>('SELECT * FROM events WHERE job_id = ? ORDER BY id', jobId);
  }

  // ---- key/value state

  getKv(key: string): string | null {
    return this.get<{ value: string | null }>('SELECT value FROM kv WHERE key = ?', key)?.value ?? null;
  }

  setKv(key: string, value: string | null) {
    this.run('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value);
  }
}
