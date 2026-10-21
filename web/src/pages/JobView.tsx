import { useCallback, useEffect, useRef, useState } from 'react';
import type { Finding, Job, JobDetail, PostPreview, ReviewMode, Severity } from '../../../src/types.ts';
import { getJson, postJson, sendJson, useStream, useTick } from '../api.ts';
import { clockTime, compact, duration, Progress, SeverityChip, shortSha, StateBadge, timeAgo } from '../ui.tsx';

const SEV_ORDER: Record<Severity, number> = { blocker: 0, major: 1, minor: 2, nit: 3 };

const OUTCOME_LABEL: Record<string, string> = {
  pending: 'in your draft',
  kept: 'you kept it',
  edited: 'you edited it',
  deleted: 'you deleted it',
  published: 'published',
  unknown: 'unknown',
};

function FindingCard({ f }: { f: Finding }) {
  const dropped = f.status === 'dropped';
  return (
    <article className={`finding ${dropped ? 'finding-dropped' : ''}`}>
      <div className="finding-head">
        <SeverityChip severity={f.severity} />
        <span className="tag">{f.category}</span>
        <code className="loc">
          {f.file || '(general)'}
          {f.line ? `:${f.line}` : ''}
        </code>
        {f.original_severity !== f.severity && <span className="small muted">was {f.original_severity}</span>}
      </div>
      <h4>{f.title}</h4>
      <p>{f.problem}</p>
      <p>
        <strong>Suggestion:</strong> {f.suggestion}
      </p>
      {f.evidence && <pre className="code">{f.evidence}</pre>}
      <div className="finding-meta small muted">
        <span>
          {f.model_id ?? f.model} · {f.pass} pass · confidence {f.confidence}
        </span>
        {f.verification !== 'not_needed' && (
          <span title={f.verify_reason ?? undefined}>
            {f.verification === 'skipped' ? 'not double-checked' : `${f.verification} by ${f.verified_by}`}
          </span>
        )}
        {!dropped && <span>{f.status === 'inline' ? 'inline comment' : 'in review summary'}</span>}
        {f.outcome && <span>{OUTCOME_LABEL[f.outcome] ?? f.outcome}</span>}
        {f.resolved_by_job && <span>fixed in a later commit</span>}
        {dropped && <span className="drop-reason">Discarded: {f.drop_reason}</span>}
      </div>
    </article>
  );
}

const CONFIDENCE_LABEL = { high: 'High', medium: 'Medium', low: 'Low' } as const;

// The review's confidence, what lowered it, and whether it approved the PR.
function Verdict({ job }: { job: Job }) {
  if (!job.confidence) return null;
  const notes = job.confidence_notes?.split('\n').filter(Boolean) ?? [];
  let outcome: string | null = null;
  if (job.review_state === 'APPROVED') outcome = 'Approved';
  else if (job.dry_run) outcome = null;
  else if (job.approve_note) outcome = `Not approved: ${job.approve_note}`;
  else if (job.mode === 'draft' && job.review_state === 'PENDING') outcome = 'No blockers: you can approve it when you submit the draft';
  return (
    <div className="small meta-line">
      <span>
        Confidence <strong>{CONFIDENCE_LABEL[job.confidence]}</strong>
      </span>
      {outcome && <span>{outcome}</span>}
      {notes.length > 0 && <span className="muted">{notes.join(' · ')}</span>}
    </div>
  );
}

// Confirms and posts a dry-run review to the PR.
function PostPanel({ job, onClose }: { job: Job; onClose: () => void }) {
  const [preview, setPreview] = useState<PostPreview | null>(null);
  const [mode, setMode] = useState<ReviewMode>(job.mode);
  const [error, setError] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);

  useEffect(() => {
    getJson<PostPreview>(`/api/jobs/${job.id}/post`)
      .then((p) => {
        setPreview(p);
        setMode(p.defaultMode);
      })
      .catch((e) => setError(String(e.message ?? e)));
  }, [job.id]);

  const post = async () => {
    setPosting(true);
    setError(null);
    try {
      await sendJson('POST', `/api/jobs/${job.id}/post`, { mode });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPosting(false);
    }
  };

  const moved = preview && preview.currentSha !== preview.reviewedSha;
  const approves = mode === 'publish' && preview?.approveNote === null;

  return (
    <div className="post-panel">
      <strong>
        Post this review to {job.repo}#{job.pr_number}
      </strong>
      {!preview && !error && <div className="small muted">Checking the PR…</div>}
      {preview && (
        <>
          <div className="post-modes" role="radiogroup" aria-label="How to post">
            <label className={`post-mode ${mode === 'draft' ? 'active' : ''}`}>
              <input type="radio" name="mode" checked={mode === 'draft'} onChange={() => setMode('draft')} />
              <span>
                <strong>Draft</strong>
                <span className="small muted block">A pending review only you can see. You edit it and submit it on GitHub.</span>
              </span>
            </label>
            <label className={`post-mode ${mode === 'publish' ? 'active' : ''}`}>
              <input type="radio" name="mode" checked={mode === 'publish'} onChange={() => setMode('publish')} />
              <span>
                <strong>{preview.approveNote === null ? 'Publish and approve' : 'Publish'}</strong>
                <span className="small muted block">
                  {preview.approveNote === null
                    ? 'Posted now under your name and approves the PR. Visible to the author and everyone on the repo.'
                    : 'Posted now as a comment review under your name, visible to the author and everyone on the repo.'}
                </span>
              </span>
            </label>
          </div>
          <div className="small">
            Posts {preview.inline} inline comment{preview.inline === 1 ? '' : 's'}
            {preview.inSummary ? ` and ${preview.inSummary} finding${preview.inSummary === 1 ? '' : 's'} in the summary` : ''}, and sets the label{' '}
            <code>{preview.labels[mode]}</code>
          </div>
          {mode === 'publish' && preview.approveNote && <div className="small muted">Won't approve: {preview.approveNote}.</div>}
          {moved && (
            <div className="small warn-text">
              The PR has new commits since this review ({shortSha(preview.reviewedSha)} → {shortSha(preview.currentSha)}). Comments go on the
              reviewed commit and may show as outdated.
            </div>
          )}
        </>
      )}
      {error && <div className="small error">{error}</div>}
      <div className="row">
        <button className="btn btn-ghost" onClick={onClose} disabled={posting}>
          Cancel
        </button>
        {preview && (
          <button className="btn" onClick={post} disabled={posting}>
            {posting ? 'Posting…' : mode === 'draft' ? 'Post draft' : approves ? 'Publish and approve' : 'Publish review'}
          </button>
        )}
      </div>
    </div>
  );
}

export function JobView({ id }: { id: number }) {
  useTick(5000);
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showDropped, setShowDropped] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [showPost, setShowPost] = useState(false);
  const refetchTimer = useRef<number | null>(null);

  const load = useCallback(() => {
    getJson<JobDetail>(`/api/jobs/${id}`)
      .then((d) => {
        setDetail(d);
        setError(null);
      })
      .catch((e) => setError(String(e.message ?? e)));
  }, [id]);

  useEffect(load, [load]);
  useStream((m) => {
    if (m.type !== 'job' || m.job.id !== id) return;
    setDetail((d) => (d ? { ...d, job: m.job } : d));
    // Findings and events change alongside the job; refetch them, debounced.
    if (refetchTimer.current) clearTimeout(refetchTimer.current);
    refetchTimer.current = window.setTimeout(load, 400);
  });

  if (error) return <p className="error">{error}</p>;
  if (!detail) return <p className="empty">Loading…</p>;

  const { job, findings, events, runs } = detail;
  const posted = findings.filter((f) => f.status !== 'dropped').sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  const dropped = findings.filter((f) => f.status === 'dropped');
  const active = ['queued', 'running', 'waiting'].includes(job.state);
  const canRetry = ['failed', 'cancelled', 'skipped', 'waiting'].includes(job.state);
  const ok = runs.filter((r) => r.ok);
  const sum = (k: 'tool_calls' | 'input_tokens' | 'cached_input_tokens' | 'output_tokens') =>
    ok.some((r) => r[k] !== null) ? ok.reduce((n, r) => n + (r[k] ?? 0), 0) : null;
  const usage = { tools: sum('tool_calls'), input: sum('input_tokens'), cached: sum('cached_input_tokens'), output: sum('output_tokens') };

  return (
    <div className="stack">
      <section className="job-head">
        <a href="#/" className="back small">
          ← Queue
        </a>
        <div className="card-top">
          <StateBadge state={job.state} />
          <a className="repo" href={job.pr_url} target="_blank" rel="noreferrer">
            {job.repo}#{job.pr_number} ↗
          </a>
        </div>
        <h1>{job.pr_title}</h1>
        <div className="small muted meta-line">
          <span>@{job.author}</span>
          <span>
            commit <code>{shortSha(job.head_sha)}</code>
            {job.since_sha && (
              <>
                {' '}
                (follow-up since <code>{shortSha(job.since_sha)}</code>)
              </>
            )}
          </span>
          <span>+{job.additions} −{job.deletions} in {job.changed_files} files</span>
          <span>{job.dry_run ? 'dry run' : job.mode === 'draft' ? 'draft review' : 'published review'}</span>
          <span>{job.source === 'manual' ? 'added by you' : 'review requested'}</span>
          {job.attempts > 0 && <span>attempt {job.attempts + (job.state === 'running' ? 1 : 0)}</span>}
        </div>
        {ok.length > 0 && (
          <div className="small muted meta-line">
            <span>
              Model usage: {ok.length} run{ok.length > 1 ? 's' : ''}
            </span>
            {usage.tools !== null && <span>{usage.tools} tool calls</span>}
            {usage.input !== null && (
              <span>
                {compact(usage.input)} tokens in{usage.cached ? ` (${compact(usage.cached)} cached)` : ''}
              </span>
            )}
            {usage.output !== null && <span>{compact(usage.output)} tokens out</span>}
          </div>
        )}

        <Verdict job={job} />

        {active && (
          <div className="job-progress">
            {job.state === 'running' && <Progress value={job.progress} />}
            <div className="small">
              {job.step}
              {job.next_attempt_at && job.state !== 'running' && ` · next try at ${clockTime(job.next_attempt_at)}`}
            </div>
          </div>
        )}
        {job.state === 'failed' && <div className="error small">{job.error}</div>}
        {job.state === 'skipped' && <div className="small muted">{job.skip_reason}</div>}

        <div className="actions">
          {job.dry_run === 1 && job.state === 'done' && job.review_state === 'DRY_RUN' && !showPost && (
            <button className="btn" onClick={() => setShowPost(true)}>
              Post to GitHub…
            </button>
          )}
          {job.review_url && (
            <a className="btn" href={`${job.pr_url}/files`} target="_blank" rel="noreferrer">
              {job.mode === 'draft' ? 'Open your draft on GitHub ↗' : 'Open the review on GitHub ↗'}
            </a>
          )}
          {job.review_body && (
            <button className="btn btn-ghost" onClick={() => setShowPreview((v) => !v)}>
              {showPreview ? 'Hide' : 'Show'} review text
            </button>
          )}
          {canRetry && (
            <button className="btn btn-ghost" onClick={() => postJson(`/api/jobs/${id}/retry`)}>
              Retry
            </button>
          )}
          {active && (
            <button className="btn btn-ghost btn-danger" onClick={() => postJson(`/api/jobs/${id}/cancel`)}>
              Cancel
            </button>
          )}
        </div>
        {job.mode === 'draft' && job.review_state === 'PENDING' && (
          <p className="small muted">
            The draft is only visible to you. Edit or delete comments in the Files changed tab, then submit it. This page
            learns what you kept for the leaderboard.
          </p>
        )}
        {showPost && <PostPanel job={job} onClose={() => setShowPost(false)} />}
        {job.dry_run === 1 && job.state === 'done' && job.review_state === 'DRY_RUN' && !showPost && (
          <p className="small muted">This was a dry run, so nothing was posted. You can post it now as a draft or a published review.</p>
        )}
        {showPreview && job.review_body && <pre className="preview">{job.review_body}</pre>}
      </section>

      <section>
        <h2>
          Findings <span className="count">{posted.length}</span>
        </h2>
        {posted.length ? (
          <div className="findings">{posted.map((f) => <FindingCard key={f.id} f={f} />)}</div>
        ) : (
          <p className="empty">{job.state === 'done' ? 'Nothing worth raising.' : 'No findings yet.'}</p>
        )}
        {dropped.length > 0 && (
          <>
            <button className="btn btn-ghost btn-small toggle-dropped" onClick={() => setShowDropped((v) => !v)}>
              {showDropped ? 'Hide' : 'Show'} {dropped.length} discarded finding{dropped.length > 1 ? 's' : ''}
            </button>
            {showDropped && <div className="findings toggle-dropped">{dropped.map((f) => <FindingCard key={f.id} f={f} />)}</div>}
          </>
        )}
      </section>

      <div className="two-col">
        <section>
          <h2>Timeline</h2>
          <ol className="timeline">
            {events.map((e) => (
              <li key={e.id} className={`ev-${e.level}`}>
                <time dateTime={e.created_at}>{clockTime(e.created_at)}</time>
                <span>{e.message}</span>
              </li>
            ))}
          </ol>
        </section>
        <section>
          <h2>Model runs</h2>
          {runs.length ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Pass</th>
                    <th>Model</th>
                    <th>Time</th>
                    <th title="File reads and searches (Claude) or shell commands (Codex). Turns are Claude's model round trips.">Tools</th>
                    <th title="Tokens in (cached in brackets) / tokens out">Tokens</th>
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id}>
                      <td>{r.purpose}</td>
                      <td className="nowrap">
                        {r.provider}
                        {r.model ? ` (${r.model})` : ''}
                        {r.fell_back ? <span className="small muted"> · stand-in</span> : null}
                      </td>
                      <td className="nowrap">{duration(r.duration_ms)}</td>
                      <td className="nowrap" title={r.turns !== null ? `${r.turns} turns` : undefined}>
                        {r.tool_calls ?? '—'}
                      </td>
                      <td className="nowrap" title={r.cost_usd !== null ? `About $${r.cost_usd.toFixed(2)} at API prices (not billed on a subscription)` : undefined}>
                        {r.input_tokens !== null ? `${compact(r.input_tokens)}${r.cached_input_tokens ? ` (${compact(r.cached_input_tokens)})` : ''} / ${compact(r.output_tokens)}` : '—'}
                      </td>
                      <td className={r.ok ? '' : 'error'} title={r.error ?? undefined}>
                        {r.ok ? 'ok' : (r.error ?? 'failed').slice(0, 60)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="empty">No model runs yet.</p>
          )}
          <p className="small muted">Created {timeAgo(job.created_at)}</p>
        </section>
      </div>
    </div>
  );
}
