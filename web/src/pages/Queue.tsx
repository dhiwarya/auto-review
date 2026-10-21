import { useState, type FormEvent } from 'react';
import type { Job, Overview } from '../../../src/types.ts';
import { postJson, useJobs, useTick } from '../api.ts';
import { clockTime, Progress, SeverityCounts, StateBadge, timeAgo } from '../ui.tsx';

const ACTIVE = new Set(['running', 'queued', 'waiting']);

function modeLabel(j: Job) {
  if (j.dry_run) return 'dry run';
  if (j.review_state === 'APPROVED') return 'approved';
  return j.mode === 'draft' ? 'draft' : 'published';
}

function ActiveCard({ job }: { job: Job }) {
  return (
    <a className="card active-card" href={`#/jobs/${job.id}`}>
      <div className="card-top">
        <StateBadge state={job.state} />
        <span className="repo">
          {job.repo}#{job.pr_number}
        </span>
        <span className="muted small push">@{job.author}</span>
      </div>
      <div className="card-title">{job.pr_title}</div>
      {job.state === 'running' && <Progress value={job.progress} />}
      <div className="small muted">
        {job.step ?? 'Waiting to start'}
        {job.next_attempt_at && job.state !== 'running' && ` · next try ${clockTime(job.next_attempt_at)}`}
        {job.kind === 'recheck' ? ' · re-check, no new commits' : job.since_sha && ' · follow-up review'}
      </div>
    </a>
  );
}

function ReviewNow() {
  const [pr, setPr] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!pr.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const job = await postJson<Job>('/api/jobs', { pr: pr.trim() });
      setPr('');
      window.location.hash = `#/jobs/${job.id}`;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="review-now" onSubmit={submit}>
      <label htmlFor="pr-input" className="small muted">
        Review a PR now, without waiting for a request
      </label>
      <div className="row">
        <input id="pr-input" value={pr} onChange={(e) => setPr(e.target.value)} placeholder="https://github.com/owner/repo/pull/123 or owner/repo#123" />
        <button className="btn" disabled={busy || !pr.trim()}>
          {busy ? 'Adding…' : 'Review'}
        </button>
      </div>
      {error && <div className="error small">{error}</div>}
    </form>
  );
}

export function QueuePage({ overview }: { overview: Overview | null }) {
  useTick();
  const { jobs, loaded } = useJobs();
  const active = jobs
    .filter((j) => ACTIVE.has(j.state))
    .sort((a, b) => (a.state === 'running' ? -1 : b.state === 'running' ? 1 : a.id - b.id));
  const history = jobs.filter((j) => !ACTIVE.has(j.state));
  const c = overview?.counts;

  return (
    <div className="stack">
      <section className="stats">
        {(
          [
            ['Reviewing', c?.running],
            ['Queued', c?.queued],
            ['Waiting', c?.waiting],
            ['Done', c?.done],
            ['Failed', c?.failed],
          ] as const
        ).map(([label, n]) => (
          <div key={label} className="stat">
            <div className="stat-n">{n ?? '–'}</div>
            <div className="stat-label">{label}</div>
          </div>
        ))}
      </section>

      <section>
        <h2>In progress</h2>
        {active.length ? (
          <div className="grid">{active.map((j) => <ActiveCard key={j.id} job={j} />)}</div>
        ) : (
          <p className="empty">
            {loaded ? `Nothing to review. Watching GitHub for PRs that request @${overview?.me ?? 'you'}.` : 'Loading…'}
          </p>
        )}
        <ReviewNow />
      </section>

      <section>
        <h2>
          History {history.length > 0 && <span className="count">{history.length}</span>}
        </h2>
        {history.length ? (
          <div className="table-wrap">
            <table className="table clickable">
              <thead>
                <tr>
                  <th>Pull request</th>
                  <th>Author</th>
                  <th>Result</th>
                  <th>Findings</th>
                  <th>Mode</th>
                  <th>Finished</th>
                </tr>
              </thead>
              <tbody>
                {history.map((j) => (
                  <tr key={j.id} onClick={() => (window.location.hash = `#/jobs/${j.id}`)}>
                    <td>
                      <a href={`#/jobs/${j.id}`} className="repo">
                        {j.repo}#{j.pr_number}
                      </a>
                      <div className="truncate" title={j.pr_title}>
                        {j.pr_title}
                      </div>
                    </td>
                    <td>@{j.author}</td>
                    <td>
                      <StateBadge state={j.state} />
                      {(j.state === 'skipped' || j.state === 'failed' || j.state === 'cancelled') && (
                        <div className="small muted truncate" title={j.error ?? j.skip_reason ?? j.step ?? ''}>
                          {j.state === 'failed' ? j.error : j.state === 'skipped' ? j.skip_reason : j.step}
                        </div>
                      )}
                    </td>
                    <td>{j.state === 'done' ? <SeverityCounts counts={j.counts} /> : <span className="muted">—</span>}</td>
                    <td className="muted">{modeLabel(j)}</td>
                    <td className="muted nowrap">{timeAgo(j.finished_at ?? j.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty">{loaded ? 'Finished reviews will show up here.' : 'Loading…'}</p>
        )}
      </section>
    </div>
  );
}
