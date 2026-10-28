import { useState, type ReactNode } from 'react';
import type { Evidence, EvidenceFile, Finding, Job, JobDetail, Run, Step, StepKind, StrictReport } from '../../../src/types.ts';
import { getJson } from '../api.ts';
import { compact, duration, shortSha } from '../ui.tsx';

// The review from start to end: what was gathered, what each model run did (live), how the
// findings were checked, and what was posted.

type StageState = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

const STAGE_CLASS: Record<StageState, string> = { pending: 'queued', running: 'running', done: 'done', failed: 'failed', skipped: 'skipped' };
const STAGE_LABEL: Record<StageState, string> = { pending: 'Not started', running: 'Running', done: 'Done', failed: 'Failed', skipped: 'Skipped' };

function StageBadge({ state, label }: { state: StageState; label?: string }) {
  return <span className={`state state-${STAGE_CLASS[state]}`}>{label ?? STAGE_LABEL[state]}</span>;
}

function Stage({ n, title, state, meta, children }: { n: number; title: string; state: StageState; meta?: ReactNode; children?: ReactNode }) {
  return (
    <li className={`stage stage-${state}`}>
      <div className="stage-head">
        <span className="stage-n">{n}</span>
        <strong>{title}</strong>
        <StageBadge state={state} />
        {meta && <span className="small muted push">{meta}</span>}
      </div>
      {children && <div className="stage-body">{children}</div>}
    </li>
  );
}

// ---- 1. Evidence

const FILE_STATE: Record<EvidenceFile['state'], string> = { reviewed: 'in the prompt', too_long: 'too long: model told to read it', excluded: 'excluded (lock or generated)' };

function EvidenceBody({ evidence }: { evidence: Evidence }) {
  const [showFiles, setShowFiles] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const d = evidence.diff;
  const byState = (s: EvidenceFile['state']) => d?.files.filter((f) => f.state === s).length ?? 0;
  return (
    <dl className="evidence">
      {d && (
        <>
          <dt>Code diff</dt>
          <dd>
            <div>
              {d.sinceSha ? (
                <>
                  Follow-up: commits since <code>{shortSha(d.sinceSha)}</code> → <code>{shortSha(d.headSha)}</code>
                </>
              ) : (
                <>
                  Full PR: <code>{shortSha(d.baseSha)}</code> → <code>{shortSha(d.headSha)}</code>
                </>
              )}
              {' · '}
              {d.files.length} file{d.files.length === 1 ? '' : 's'}
              {d.files.length !== d.prFiles && ` of ${d.prFiles} in the PR`} · {d.changedLines.toLocaleString()} changed lines
              {d.large && ' · large-PR mode (blockers and majors only)'}
            </div>
            <div className="small muted">
              Diff sent: {compact(d.diffChars)} of {compact(d.maxDiffChars)} characters · {byState('reviewed')} in the prompt
              {byState('too_long') > 0 && <strong className="warn-text"> · {byState('too_long')} too long to send</strong>}
              {byState('excluded') > 0 && ` · ${byState('excluded')} excluded`}
            </div>
            {d.files.length > 0 && (
              <button className="btn btn-ghost btn-small" onClick={() => setShowFiles((v) => !v)}>
                {showFiles ? 'Hide' : 'Show'} files
              </button>
            )}
            {showFiles && (
              <div className="table-wrap">
                <table className="table compact-table">
                  <tbody>
                    {d.files.map((f) => (
                      <tr key={f.name} className={f.state === 'reviewed' ? '' : 'muted'}>
                        <td className="mono-cell">{f.name}</td>
                        <td className="nowrap">{f.status}</td>
                        <td className="nowrap">
                          +{f.additions} −{f.deletions}
                        </td>
                        <td className={f.state === 'too_long' ? 'warn-text' : ''}>{FILE_STATE[f.state]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </dd>
        </>
      )}

      <dt>Linked issues</dt>
      <dd>
        {evidence.issues.length ? (
          <ul className="plain-list">
            {evidence.issues.map((i) => (
              <li key={i.ref}>
                <a href={i.url} target="_blank" rel="noreferrer">
                  {i.ref}
                </a>{' '}
                {i.title} <span className="small muted">· {i.linkedBy === 'closes' ? 'closed by this PR' : 'mentioned'} · {i.comments} comment{i.comments === 1 ? '' : 's'} read</span>
              </li>
            ))}
          </ul>
        ) : (
          <span className="muted">None found, so requirements weren't checked</span>
        )}
      </dd>

      <dt>Mentioned PRs</dt>
      <dd>
        {evidence.prs.length ? (
          <ul className="plain-list">
            {evidence.prs.map((p) => (
              <li key={p.ref}>
                <a href={p.url} target="_blank" rel="noreferrer">
                  {p.ref}
                </a>{' '}
                {p.title} <span className="small muted">· referenced only, not sent to the model</span>
              </li>
            ))}
          </ul>
        ) : (
          <span className="muted">None</span>
        )}
      </dd>

      {d && (
        <>
          <dt>Guidelines</dt>
          <dd>{evidence.guidelines.length ? evidence.guidelines.map((g) => <code key={g} className="chip">{g}</code>) : <span className="muted">None in the base branch</span>}</dd>

          <dt>File history</dt>
          <dd>
            {evidence.history.length ? (
              <>
                Recent commits for {evidence.history.length} changed file{evidence.history.length === 1 ? '' : 's'}{' '}
                <button className="btn btn-ghost btn-small" onClick={() => setShowHistory((v) => !v)}>
                  {showHistory ? 'Hide' : 'Show'}
                </button>
                {showHistory && (
                  <ul className="plain-list small">
                    {evidence.history.map((h) => (
                      <li key={h.file}>
                        <code>{h.file}</code> <span className="muted">· {h.commits} commits</span>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <span className="muted">None (only new files, or no history)</span>
            )}
          </dd>
        </>
      )}

      {evidence.discussion && (
        <>
          <dt>Discussion</dt>
          <dd>
            {evidence.discussion.threadReplies} repl{evidence.discussion.threadReplies === 1 ? 'y' : 'ies'} in the open findings' threads ·{' '}
            {evidence.discussion.conversation} PR comment{evidence.discussion.conversation === 1 ? '' : 's'} since the last review
          </dd>
        </>
      )}

      <dt>Earlier findings</dt>
      <dd>{evidence.previousFindings ? `${evidence.previousFindings} still open, passed to the model` : <span className="muted">None open</span>}</dd>

      <dt>Prompt</dt>
      <dd>
        {compact(evidence.promptChars)} characters <span className="small muted">(about {compact(Math.round(evidence.promptChars / 4))} tokens, before instructions)</span>
      </dd>
    </dl>
  );
}

// ---- 2. Model runs

interface Attempt {
  key: string;
  provider: string;
  model: string | null;
  steps: Step[];
  run: Run | null; // null while the run is going (or if the app stopped mid-run)
}

function attemptsFor(purpose: string, runs: Run[], steps: Step[]): Attempt[] {
  const byKey = new Map<string, Attempt>();
  for (const s of steps.filter((x) => x.purpose === purpose)) {
    if (!byKey.has(s.run_key)) byKey.set(s.run_key, { key: s.run_key, provider: s.provider, model: s.model, steps: [], run: null });
    byKey.get(s.run_key)!.steps.push(s);
  }
  const out = [...byKey.values()];
  for (const r of runs.filter((x) => x.purpose === purpose)) {
    const a = r.run_key ? byKey.get(r.run_key) : undefined;
    if (a) a.run = r;
    else out.push({ key: `run-${r.id}`, provider: r.provider, model: r.model, steps: [], run: r }); // made before steps were recorded
  }
  const at = (a: Attempt) => a.steps[0]?.created_at ?? a.run?.created_at ?? '';
  return out.sort((a, b) => at(a).localeCompare(at(b)));
}

function attemptState(a: Attempt, jobActive: boolean): StageState {
  if (a.run) return a.run.ok ? 'done' : 'failed';
  return jobActive ? 'running' : 'failed';
}

function passState(attempts: Attempt[], jobActive: boolean): StageState {
  if (!attempts.length) return jobActive ? 'pending' : 'skipped';
  if (attempts.some((a) => a.run?.ok)) return 'done';
  return attemptState(attempts[attempts.length - 1], jobActive);
}

// What the run returned, in a line or two: the summary, its confidence, what it found.
function OutputSummary({ output }: { output: string }) {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(output);
  } catch {
    return null;
  }
  const findings = Array.isArray(o.findings) ? (o.findings as { severity: string }[]) : null;
  const verdicts = Array.isArray(o.verdicts) ? (o.verdicts as { verdict?: string; status?: string }[]) : null;
  const confidence = o.review_confidence as { level: string; reason: string } | undefined;
  const tally = (items: string[]) =>
    Object.entries(items.reduce<Record<string, number>>((m, k) => ({ ...m, [k]: (m[k] ?? 0) + 1 }), {}))
      .map(([k, n]) => `${n} ${k}`)
      .join(', ');
  return (
    <div className="run-output">
      {typeof o.summary === 'string' && o.summary && <p>{o.summary}</p>}
      <div className="small meta-line">
        {findings && <span>{findings.length ? `Proposed ${findings.length} finding${findings.length === 1 ? '' : 's'}: ${tally(findings.map((f) => f.severity))}` : 'No findings proposed'}</span>}
        {verdicts && <span>Verdicts: {tally(verdicts.map((v) => v.verdict ?? v.status ?? '?')) || 'none'}</span>}
        {confidence && (
          <span>
            Confidence <strong>{confidence.level}</strong>
            {confidence.reason && <span className="muted">: {confidence.reason}</span>}
          </span>
        )}
      </div>
    </div>
  );
}

const KIND_LABEL: Record<StepKind, string> = { start: 'start', command: '$', tool: 'tool', reasoning: 'thinks', message: 'says', output: 'answer', error: 'error' };

function StepRow({ step, offsetMs }: { step: Step; offsetMs: number }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  const canOpen = step.detail_chars > 0;
  const toggle = () => {
    if (!canOpen) return;
    setOpen((v) => !v);
    if (detail === null) {
      getJson<{ detail: string | null }>(`/api/steps/${step.id}`)
        .then((r) => setDetail(r.detail ?? ''))
        .catch((e) => setDetail(`Couldn't load: ${e instanceof Error ? e.message : e}`));
    }
  };
  const mono = step.kind === 'command' || step.kind === 'tool';
  return (
    <li className={`step step-${step.kind} step-${step.status}`}>
      <button className="step-line" onClick={toggle} disabled={!canOpen} aria-expanded={canOpen ? open : undefined}>
        <span className="step-time">+{Math.max(0, Math.round(offsetMs / 1000))}s</span>
        <span className="step-kind">{KIND_LABEL[step.kind]}</span>
        <span className={`step-title ${mono ? 'mono' : ''}`}>{step.title}</span>
        <span className="step-status small">
          {step.status === 'running' ? <span className="state state-running">running</span> : step.status === 'failed' ? <span className="error">failed</span> : null}
          {canOpen && <span className="muted"> {open ? '▾' : '▸'}</span>}
        </span>
      </button>
      {open && <pre className="step-detail">{detail ?? 'Loading…'}</pre>}
    </li>
  );
}

function AttemptView({ attempt, jobActive, n, total }: { attempt: Attempt; jobActive: boolean; n: number; total: number }) {
  const [showRaw, setShowRaw] = useState(false);
  const state = attemptState(attempt, jobActive);
  const r = attempt.run;
  const start = attempt.steps[0] ? Date.parse(attempt.steps[0].created_at) : r ? Date.parse(r.created_at) - r.duration_ms : Date.now();
  const elapsed = r ? r.duration_ms : Date.now() - start;
  const log = attempt.steps.filter((s) => s.kind !== 'start');
  const counts = log.reduce<Record<string, number>>((m, s) => ({ ...m, [s.kind]: (m[s.kind] ?? 0) + 1 }), {});
  return (
    <div className="attempt">
      <div className="attempt-head">
        <StageBadge state={state} label={state === 'failed' && !r ? 'Interrupted' : undefined} />
        <span>
          {attempt.provider} {attempt.model ?? '(default model)'}
          {r?.fell_back ? <span className="small muted"> · stand-in</span> : null}
        </span>
        {total > 1 && <span className="small muted">attempt {n} of {total}</span>}
      </div>
      <div className="usage-grid">
        <div>
          <span className="usage-n">{duration(elapsed)}</span>
          <span className="usage-label">time</span>
        </div>
        <div>
          <span className="usage-n">{r?.input_tokens != null ? compact(r.input_tokens) : '—'}</span>
          <span className="usage-label">tokens in{r?.cached_input_tokens ? ` (${compact(r.cached_input_tokens)} cached)` : ''}</span>
        </div>
        <div>
          <span className="usage-n">{r?.output_tokens != null ? compact(r.output_tokens) : '—'}</span>
          <span className="usage-label">tokens out</span>
        </div>
        <div>
          <span className="usage-n">{r?.tool_calls ?? (counts.command ?? 0) + (counts.tool ?? 0)}</span>
          <span className="usage-label">tool calls{r?.turns != null ? ` · ${r.turns} turns` : ''}</span>
        </div>
        {r?.prompt_chars != null && (
          <div>
            <span className="usage-n">{compact(r.prompt_chars)}</span>
            <span className="usage-label">prompt characters</span>
          </div>
        )}
      </div>
      {r?.error && <div className="error small">{r.error}</div>}
      {r?.output && <OutputSummary output={r.output} />}
      {log.length > 0 ? (
        <details className="log" open={state === 'running'}>
          <summary className="small">
            Log: {log.length} step{log.length === 1 ? '' : 's'}
            {counts.command ? ` · ${counts.command} commands` : ''}
            {counts.tool ? ` · ${counts.tool} tool calls` : ''}
            {counts.reasoning ? ` · ${counts.reasoning} reasoning notes` : ''}
          </summary>
          <ol className="steps">
            {log.map((s) => (
              <StepRow key={s.id} step={s} offsetMs={Date.parse(s.created_at) - start} />
            ))}
          </ol>
        </details>
      ) : (
        <p className="small muted">{r && !attempt.steps.length ? 'No log: this run was made before logs were recorded.' : 'Waiting for the model…'}</p>
      )}
      {r?.output && (
        <>
          <button className="btn btn-ghost btn-small" onClick={() => setShowRaw((v) => !v)}>
            {showRaw ? 'Hide' : 'Show'} raw output
          </button>
          {showRaw && <pre className="step-detail">{JSON.stringify(JSON.parse(r.output), null, 2)}</pre>}
        </>
      )}
    </div>
  );
}

function PassCard({ title, attempts, jobActive, emptyNote }: { title: string; attempts: Attempt[]; jobActive: boolean; emptyNote: string }) {
  const state = passState(attempts, jobActive);
  return (
    <div className="pass-card">
      <div className="card-top">
        <strong>{title}</strong>
        <StageBadge state={state} />
      </div>
      {attempts.length ? (
        attempts.map((a, i) => <AttemptView key={a.key} attempt={a} jobActive={jobActive} n={i + 1} total={attempts.length} />)
      ) : (
        <p className="small muted">{emptyNote}</p>
      )}
    </div>
  );
}

// ---- 3. Checking the findings

function ValidationBody({ findings }: { findings: Finding[] }) {
  const kept = findings.filter((f) => f.status !== 'dropped');
  const dropped = findings.filter((f) => f.status === 'dropped');
  const reasons = dropped.reduce<Record<string, number>>((m, f) => {
    const why = (f.drop_reason ?? 'discarded').split(':')[0];
    return { ...m, [why]: (m[why] ?? 0) + 1 };
  }, {});
  const v = (k: Finding['verification']) => findings.filter((f) => f.verification === k).length;
  return (
    <div className="small stack-tight">
      <div>
        {findings.length} proposed → <strong>{kept.length} kept</strong> ({kept.filter((f) => f.status === 'inline').length} inline,{' '}
        {kept.filter((f) => f.status === 'summary').length} in the summary), {dropped.length} discarded
      </div>
      {(v('confirmed') || v('refuted') || v('uncertain')) > 0 && (
        <div className="muted">
          Double-check: {v('confirmed')} confirmed, {v('refuted')} refuted, {v('uncertain')} uncertain{v('skipped') ? `, ${v('skipped')} not checked` : ''}
        </div>
      )}
      {dropped.length > 0 && (
        <ul className="plain-list muted">
          {Object.entries(reasons).map(([why, n]) => (
            <li key={why}>
              {n} × {why}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---- 4. Posting

function postingState(job: Job): { state: StageState; text: string } {
  if (job.state === 'failed') return { state: 'failed', text: job.error ?? 'Failed' };
  if (job.state === 'cancelled' || job.state === 'skipped') return { state: 'skipped', text: job.skip_reason ?? job.step ?? 'Not posted' };
  if (job.state !== 'done') return { state: job.progress >= 95 ? 'running' : 'pending', text: job.dry_run ? 'Dry run: nothing will be posted' : `Will post as a ${job.mode === 'draft' ? 'draft only you see' : 'published review'}` };
  const words: Record<string, string> = {
    DRY_RUN: 'Dry run: nothing was posted',
    PENDING: 'Draft posted: only you can see it until you submit it',
    APPROVED: 'Posted: approved',
    COMMENTED: 'Posted: comment review',
    CHANGES_REQUESTED: 'Posted: changes requested',
    DELETED: 'Draft posted, then discarded on GitHub',
  };
  return { state: 'done', text: words[job.review_state ?? ''] ?? job.step ?? 'Done' };
}

export function ProcessView({ detail }: { detail: JobDetail }) {
  const { job, runs, steps, findings, evidence } = detail;
  const active = ['queued', 'running', 'waiting'].includes(job.state);
  const attempts = (p: string) => attemptsFor(p, runs, steps);
  const evidenceState: StageState = evidence ? 'done' : active ? (job.state === 'running' ? 'running' : 'pending') : 'skipped';
  const posting = postingState(job);
  let n = 1;
  let strict: StrictReport | null = null;
  try { strict = JSON.parse(job.review_report ?? 'null'); } catch { /* old job */ }
  const strictPurposes = [...new Set([...runs.map((r) => r.purpose), ...steps.map((s) => s.purpose)].filter((p) => p.startsWith('strict:')))];

  return (
    <ol className="process">
      <Stage n={n++} title="Evidence gathering" state={evidenceState}>
        {evidence ? (
          <EvidenceBody evidence={evidence} />
        ) : (
          <p className="small muted">{active ? 'Fetching the PR, the diff, linked issues and guidelines…' : 'Not recorded: this review was made before evidence was kept.'}</p>
        )}
      </Stage>

      {strict && <Stage n={n++} title="Strict coverage and approval gates" state={strict.complete ? 'done' : active ? 'running' : 'failed'}>
        <p className="small">{strict.complete ? 'Required coverage and stages completed.' : 'Review incomplete; automatic posting is withheld.'} {strict.sections.length} assigned code/context sections; {strict.excluded.length} excluded files. {strict.inheritedFrom ? `Baseline: job ${strict.inheritedFrom}.` : ''}</p>
        {strict.recovery && <p className="small">{strict.recovery}</p>}
        {strict.workload && <p className="small muted">Planned: {strict.workload.plannedDiscoveryRuns} discovery runs + {strict.workload.synthesisRuns} synthesis · {strict.workload.verificationReserve} verification attempts reserved · {strict.workload.maxRuns} total attempt limit</p>}
        {!!strict.sources?.length && <details className="small"><summary>Complete context sources ({strict.sources.length})</summary>{strict.sources.map((s) => <p key={s.id}><strong>{s.title}</strong> · {s.chars.toLocaleString()} characters · {s.sections} tracked sections · <code>{s.digest.slice(0, 16)}</code></p>)}</details>}
        <p className="small muted">Diff inclusion, model-reported examination, and recorded tool activity are separate evidence. They do not prove understanding.</p>
        {[...new Set([...strict.gaps, ...strict.approvalBlocks])].length > 0 && <ul className="plain-list small">{[...new Set([...strict.gaps, ...strict.approvalBlocks])].map((g) => <li key={g}>{g}</li>)}</ul>}
        {(strict.requirements?.length ?? 0) > 0 && <details className="small"><summary>Requirement assessments</summary>{strict.requirements!.map((r, i) => <div key={i}><p><strong>{r.ref}: {r.status}</strong> ({r.stage}) — {r.criterion ? `${r.criterion}: ` : ''}{r.reason}</p>{r.scopeEvidence && <blockquote>{r.scopeEvidence}</blockquote>}</div>)}</details>}
        {strict.stages.map((s) => <details key={s.key} className="small"><summary>{s.purpose}: {s.state} · {s.provider ?? 'no provider completed'}{s.model ? ` ${s.model}` : ''}{s.continuations ? ` · ${s.continuations} continuation(s)` : ''}</summary>
          {s.error && <p className="error">{s.error}</p>}
          {s.coverage.map((c) => <div key={c.section_id}><strong>{c.section_id}: {c.status}</strong><p>{c.notes}</p><p className="muted">Dependencies: {c.dependencies.join(', ') || 'none reported'} · Tests: {c.tests.join(', ') || 'none reported'} · Configuration: {c.configuration.join(', ') || 'none reported'}</p></div>)}
        </details>)}
      </Stage>}

      {job.kind === 'recheck' && !strict ? (
        <Stage n={n++} title="Re-check of open findings" state={passState(attempts('recheck'), active)}>
          <PassCard title="Re-check" attempts={attempts('recheck')} jobActive={active} emptyNote="No findings were open, so no model ran." />
        </Stage>
      ) : strict ? (
        <>
          {strictPurposes.map((p) => <Stage key={p} n={n++} title={p.split(':').slice(1, -1).join(' / ')} state={passState(attempts(p), active)}><PassCard title="Model activity and usage" attempts={attempts(p)} jobActive={active} emptyNote="Waiting for this stage." /></Stage>)}
          <Stage n={n++} title="Checking findings against the code" state={findings.length || job.state === 'done' ? 'done' : 'pending'}><ValidationBody findings={findings} /></Stage>
        </>
      ) : (
        <>
          <Stage n={n++} title="Review" state={mergeStates(passState(attempts('main'), active), passState(attempts('security'), active))} meta="both run at the same time">
            <div className="pass-grid">
              <PassCard title="Code review" attempts={attempts('main')} jobActive={active} emptyNote="Starts once the evidence is ready." />
              <PassCard title="Security review" attempts={attempts('security')} jobActive={active} emptyNote="Starts once the evidence is ready." />
            </div>
          </Stage>
          <Stage n={n++} title="Double-check" state={passState(attempts('verify'), active)}>
            <PassCard
              title="Double-check of blockers and majors"
              attempts={attempts('verify')}
              jobActive={active}
              emptyNote={active ? 'Runs after the review if it raised a blocker or major.' : 'Not needed: no blocker or major survived the first checks (or it is turned off in Settings).'}
            />
          </Stage>
          <Stage n={n++} title="Checking findings against the code" state={findings.length || job.state === 'done' ? 'done' : active ? 'pending' : 'skipped'}>
            {findings.length ? <ValidationBody findings={findings} /> : <p className="small muted">{job.state === 'done' ? 'Nothing was proposed.' : 'Evidence must exist in the file, on a line GitHub accepts; duplicates and credentials are removed.'}</p>}
          </Stage>
        </>
      )}

      <Stage n={n++} title="Posting" state={posting.state}>
        <p className="small">
          {posting.text}
          {job.review_url && (
            <>
              {' · '}
              <a href={job.review_url} target="_blank" rel="noreferrer">
                open on GitHub ↗
              </a>
            </>
          )}
        </p>
      </Stage>
    </ol>
  );
}

function mergeStates(a: StageState, b: StageState): StageState {
  for (const s of ['running', 'failed', 'pending'] as StageState[]) if (a === s || b === s) return s;
  return a === 'done' || b === 'done' ? 'done' : 'skipped';
}
