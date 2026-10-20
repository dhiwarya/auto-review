import { useCallback, useEffect, useRef, useState } from 'react';
import type { Finding, JobDetail, Severity } from '../../../src/types.ts';
import { getJson, postJson, useStream, useTick } from '../api.ts';
import { clockTime, duration, Progress, SeverityChip, shortSha, StateBadge, timeAgo } from '../ui.tsx';

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
          {f.model} · {f.pass} pass · confidence {f.confidence}
        </span>
        {f.verification !== 'not_needed' && (
          <span title={f.verify_reason ?? undefined}>
            {f.verification === 'skipped' ? 'not cross-checked' : `${f.verification} by ${f.verified_by}`}
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

export function JobView({ id }: { id: number }) {
  useTick(5000);
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showDropped, setShowDropped] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
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

  return (
    <div className="stack">
      <a href="#/" className="back small">
        ← Queue
      </a>
      <section className="job-head">
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
        {showPreview && job.review_body && <pre className="preview">{job.review_body}</pre>}
      </section>

      <section>
        <h2>
          Findings <span className="muted">({posted.length})</span>
        </h2>
        {posted.length ? (
          <div className="stack-sm">{posted.map((f) => <FindingCard key={f.id} f={f} />)}</div>
        ) : (
          <p className="empty">{job.state === 'done' ? 'Nothing worth raising.' : 'No findings yet.'}</p>
        )}
        {dropped.length > 0 && (
          <>
            <button className="btn btn-ghost btn-small" onClick={() => setShowDropped((v) => !v)}>
              {showDropped ? 'Hide' : 'Show'} {dropped.length} discarded finding{dropped.length > 1 ? 's' : ''}
            </button>
            {showDropped && <div className="stack-sm">{dropped.map((f) => <FindingCard key={f.id} f={f} />)}</div>}
          </>
        )}
      </section>

      <div className="two-col">
        <section>
          <h2>Timeline</h2>
          <ol className="timeline">
            {events.map((e) => (
              <li key={e.id} className={`ev-${e.level}`}>
                <span className="muted small nowrap">{clockTime(e.created_at)}</span>
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
                    <th>Result</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.id}>
                      <td>{r.purpose}</td>
                      <td>
                        {r.provider}
                        {r.model ? ` (${r.model})` : ''}
                        {r.fell_back ? <span className="small muted"> · stand-in</span> : null}
                      </td>
                      <td className="nowrap">{duration(r.duration_ms)}</td>
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
