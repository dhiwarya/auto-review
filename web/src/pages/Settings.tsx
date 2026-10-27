import { useEffect, useState, type ReactNode } from 'react';
import type { Settings, SettingsIssue } from '../../../src/settings-schema.ts';
import type { Overview, Provider, ProviderStatus } from '../../../src/types.ts';
import { ApiError, getJson, postJson, sendJson } from '../api.ts';
import { clockTime, timeAgo } from '../ui.tsx';

const NAME: Record<Provider, string> = { codex: 'Codex', claude: 'Claude' };
const other = (p: Provider): Provider => (p === 'codex' ? 'claude' : 'codex');
const lines = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean);

// ---- small form controls

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className="settings-section">
      <div>
        <h2>{title}</h2>
        {description && <p className="small muted section-desc">{description}</p>}
      </div>
      <div className="section-body">{children}</div>
    </section>
  );
}

function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string; children: ReactNode }) {
  return (
    <div className="field">
      <div className="field-label">{label}</div>
      {children}
      {hint && <div className="small muted">{hint}</div>}
      {error && <div className="small error">{error}</div>}
    </div>
  );
}

function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && <span className="small muted block">{hint}</span>}
      </span>
    </label>
  );
}

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" role="radio" aria-checked={value === v} className={value === v ? 'active' : ''} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

function NumberInput({ value, onChange, min, max, suffix }: { value: number; onChange: (v: number) => void; min?: number; max?: number; suffix?: string }) {
  return (
    <div className="row number-row">
      <input type="number" value={Number.isNaN(value) ? '' : value} min={min} max={max} onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))} />
      {suffix && <span className="muted small">{suffix}</span>}
    </div>
  );
}

// One entry per line. Keeps its own text so blank lines survive while you type.
function ListInput({ value, onChange, placeholder, rows = 4 }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string; rows?: number }) {
  const [text, setText] = useState(value.join('\n'));
  useEffect(() => {
    if (lines(text).join('\n') !== value.join('\n')) setText(value.join('\n'));
  }, [value]);
  return (
    <textarea
      rows={rows}
      value={text}
      placeholder={placeholder}
      spellCheck={false}
      onChange={(e) => {
        setText(e.target.value);
        onChange(lines(e.target.value));
      }}
    />
  );
}

// ---- model status (live, from the overview)

function ModelStatus({ p, role }: { p: ProviderStatus; role: string }) {
  return (
    <div className="model-status">
      <div className="card-top">
        <strong>{NAME[p.provider]}</strong>
        <span className="muted small">{role}</span>
        <span className={`pill push ${p.blocked_until ? 'pill-warn' : 'pill-ok'}`}>
          <span className="dot" />
          {p.blocked_until ? `paused until ${clockTime(p.blocked_until)}` : 'ready'}
        </span>
      </div>
      <ol className="model-chain small">
        {p.models.map((m, i) => (
          <li key={`${m.model}-${i}`}>
            <code>{m.model ?? '(CLI default)'}</code>
            {m.blocked_until ? (
              <span className="warn-text" title={m.last_error ?? undefined}>
                {' '}
                · paused until {clockTime(m.blocked_until)}
              </span>
            ) : (
              p.active_model === m.model && <span className="ok-text"> · in use</span>
            )}
          </li>
        ))}
      </ol>
      {p.last_error && <p className="small error">{p.last_error}</p>}
      {p.blocked_until && (
        <button type="button" className="btn btn-small btn-ghost" onClick={() => postJson(`/api/providers/${p.provider}/reset`)}>
          Try again now
        </button>
      )}
    </div>
  );
}

// ---- page

type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; message: string };

export function SettingsPage({ overview }: { overview: Overview | null }) {
  const [saved, setSaved] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [issues, setIssues] = useState<SettingsIssue[]>([]);
  const [save, setSave] = useState<SaveState>({ kind: 'idle' });
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (save.kind !== 'saved') return;
    const t = setTimeout(() => setSave((s) => (s.kind === 'saved' ? { kind: 'idle' } : s)), 3000);
    return () => clearTimeout(t);
  }, [save.kind]);

  useEffect(() => {
    getJson<{ settings: Settings }>('/api/settings')
      .then(({ settings }) => {
        setSaved(settings);
        setDraft(settings);
      })
      .catch((e) => setLoadError(String(e.message ?? e)));
  }, []);

  if (loadError) return <p className="error">{loadError}</p>;
  if (!draft || !saved) return <p className="empty">Loading…</p>;

  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const edit = (fn: (d: Settings) => void) => {
    setDraft((d) => {
      const next = structuredClone(d!);
      fn(next);
      return next;
    });
    if (save.kind !== 'saving') setSave({ kind: 'idle' });
  };

  // Messages for a field and anything under it, e.g. "repos.allow" covers "repos.allow.2".
  const errorFor = (path: string) => {
    const found = issues.filter((i) => i.path === path || i.path.startsWith(`${path}.`));
    if (!found.length) return undefined;
    return found
      .map((i) => {
        const index = i.path.slice(path.length + 1).split('.')[0];
        return /^\d+$/.test(index) ? `Line ${Number(index) + 1}: ${i.message}` : i.message;
      })
      .join(' · ');
  };

  const onSave = async () => {
    setSave({ kind: 'saving' });
    try {
      const res = await sendJson<{ settings: Settings }>('PUT', '/api/settings', draft);
      setSaved(res.settings);
      setDraft(res.settings);
      setIssues([]);
      setSave({ kind: 'saved' });
    } catch (err) {
      const data = err instanceof ApiError ? (err.data as { issues?: SettingsIssue[] } | null) : null;
      setIssues(data?.issues ?? []);
      setSave({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  };

  const onDiscard = () => {
    setDraft(saved);
    setIssues([]);
    setSave({ kind: 'idle' });
  };

  const m = draft.models;
  const backup = other(m.provider);
  const byProvider = new Map(overview?.providers.map((p) => [p.provider, p]));

  return (
    <div className="stack settings-page">
      <Section title="Repositories" description="Only these repos are ever reviewed. Nothing happens until at least one is listed.">
        <Field
          label="Review pull requests in"
          hint="One per line: owner/repo, or a pattern such as your-org/*"
          error={errorFor('repos.allow')}
        >
          <ListInput value={draft.repos.allow} onChange={(v) => edit((d) => void (d.repos.allow = v))} placeholder={'your-org/*\nyour-name/some-repo'} />
        </Field>
        <Field label="Never review" hint="Wins over the list above. One per line." error={errorFor('repos.deny')}>
          <ListInput value={draft.repos.deny} onChange={(v) => edit((d) => void (d.repos.deny = v))} rows={2} placeholder="your-org/secret-repo" />
        </Field>
        {overview && overview.github.watching.length > 0 && (
          <Field label="Watching now">
            <ul className="watch-list small">
              {overview.github.watching.map((w) => (
                <li key={w.repo}>
                  <span className={w.ok ? 'ok-text' : 'error'}>{w.ok ? '✓' : '✗'}</span> <code>{w.repo}</code>{' '}
                  <span className="muted">
                    {w.ok
                      ? `${w.openPrs} open PR${w.openPrs === 1 ? '' : 's'}, ${w.requestingYou} requesting you · checked ${timeAgo(w.checkedAt)}`
                      : w.error}
                  </span>
                </li>
              ))}
            </ul>
          </Field>
        )}
      </Section>

      {overview && (
        <Section
          title="GitHub usage"
          description="The app checks each repo's open pull requests with conditional requests. When nothing changed GitHub answers “not modified”, which doesn't count against your limits."
        >
          {overview.github.paused_until && (
            <div className="small error">
              Paused: {overview.github.pause_reason}. Checking again at {clockTime(overview.github.paused_until)}.
            </div>
          )}
          {overview.github.last_cycle && (
            <div className="small">
              Last check: {overview.github.last_cycle.requests} request{overview.github.last_cycle.requests === 1 ? '' : 's'},{' '}
              {overview.github.last_cycle.notModified} of them free.
            </div>
          )}
          <div className="limits">
            {overview.github.limits.map((l) => (
              <div key={l.resource} className="limit">
                <div className="small">
                  <strong>{l.resource}</strong>{' '}
                  <span className={l.remaining / l.limit < 0.1 ? 'warn-text' : 'muted'}>
                    {l.remaining.toLocaleString()} of {l.limit.toLocaleString()} left · resets {clockTime(l.reset)}
                  </span>
                </div>
                <div className="progress">
                  <div style={{ width: `${Math.max(2, (l.remaining / l.limit) * 100)}%` }} />
                </div>
              </div>
            ))}
            {overview.github.limits.length === 0 && <div className="small muted">Shows up after the first request.</div>}
          </div>
        </Section>
      )}

      <Section title="Posting to GitHub">
        <Toggle
          checked={draft.dryRun}
          onChange={(v) => edit((d) => void (d.dryRun = v))}
          label={<strong>Dry run</strong>}
          hint="Reviews run and show up here, but nothing is posted to GitHub and no labels change. Turn off when the reviews look right."
        />
        <Field
          label="How reviews are posted"
          hint={
            draft.defaultMode === 'draft'
              ? 'A pending review only you can see. You edit it and submit it yourself.'
              : 'Posted straight away under your name. Approves when the rules allow it; rechecks request changes while blockers or majors remain.'
          }
        >
          <Segmented
            label="Default mode"
            value={draft.defaultMode}
            onChange={(v) => edit((d) => void (d.defaultMode = v))}
            options={[
              ['draft', 'Draft'],
              ['publish', 'Publish'],
            ]}
          />
        </Field>
        <Toggle
          checked={draft.approval.enabled}
          onChange={(v) => edit((d) => void (d.approval.enabled = v))}
          label={<strong>Approve PRs that have no blockers</strong>}
          hint="Only published reviews approve. Never a draft (you decide when you submit it), a draft PR, your own PR, a PR with commits newer than the review, or one where you requested changes. An approval counts toward branch protection, so the PR may become mergeable."
        />
        {draft.approval.enabled && draft.reviewProfile === 'strict' && <p className="small muted">Strict approval requires high confidence, all required coverage and stages completed, and no open blockers or majors. The Standard minimum-confidence setting does not relax these rules.</p>}
        {draft.approval.enabled && draft.reviewProfile === 'standard' && (
          <Field
            label="Approve when confidence is at least"
            hint={
              draft.approval.minConfidence === 'high'
                ? 'High: no blockers or majors open, no open questions, requirements match, and both review passes are sure.'
                : 'Medium also approves with majors open, open questions, partly matching requirements, or a large change.'
            }
          >
            <Segmented
              label="Minimum confidence"
              value={draft.approval.minConfidence}
              onChange={(v) => edit((d) => void (d.approval.minConfidence = v))}
              options={[
                ['high', 'High'],
                ['medium', 'Medium'],
              ]}
            />
          </Field>
        )}
        <Field label="Exceptions per repo" hint="The first matching pattern wins." error={errorFor('repoModes')}>
          <div className="rows">
            {draft.repoModes.map((o, i) => (
              <div key={i} className="row">
                <input value={o.repo} placeholder="your-org/repo" onChange={(e) => edit((d) => void (d.repoModes[i].repo = e.target.value))} />
                <select value={o.mode} onChange={(e) => edit((d) => void (d.repoModes[i].mode = e.target.value as 'draft' | 'publish'))}>
                  <option value="draft">Draft</option>
                  <option value="publish">Publish</option>
                </select>
                <button type="button" className="btn btn-ghost btn-small" onClick={() => edit((d) => void d.repoModes.splice(i, 1))} aria-label="Remove">
                  Remove
                </button>
              </div>
            ))}
            <button type="button" className="btn btn-ghost btn-small add-row" onClick={() => edit((d) => void d.repoModes.push({ repo: '', mode: d.defaultMode === 'draft' ? 'publish' : 'draft' }))}>
              Add exception
            </button>
          </div>
        </Field>
      </Section>

      <Section title="Reviewer" description={draft.reviewProfile === 'strict' ? 'Strict uses the primary provider for code and security, the other provider for an independent adversarial pass, and independent verification of serious findings. Both CLI logins are required.' : 'The primary provider reviews code and security, with optional fallback and double-checking.'}>
        <Field label="Review profile" hint="Strict requires complete coverage, independent review, and high confidence before automatic approval. Existing reviews retain their recorded policy.">
          <Segmented label="Review profile" value={draft.reviewProfile} onChange={(v) => edit((d) => void (d.reviewProfile = v))} options={[["standard", "Standard"], ["strict", "Strict"]]} />
        </Field>
        <Field label="Who reviews">
          <Segmented
            label="Review provider"
            value={m.provider}
            onChange={(v) => edit((d) => void (d.models.provider = v))}
            options={[
              ['codex', 'Codex'],
              ['claude', 'Claude'],
            ]}
          />
        </Field>
        <Toggle
          checked={m.fallbackToOther}
          onChange={(v) => edit((d) => void (d.models.fallbackToOther = v))}
          label={`If ${NAME[m.provider]} runs out, use ${NAME[backup]} instead`}
          hint={`When every ${NAME[m.provider]} model hits its usage limit or you're signed out. Off: reviews wait until ${NAME[m.provider]} is available again.`}
        />
        {draft.reviewProfile === 'standard' && <Toggle
          checked={m.doubleCheck}
          onChange={(v) => edit((d) => void (d.models.doubleCheck = v))}
          label="Double-check blockers and majors before posting"
          hint="A fresh run re-reads serious findings. Refuted findings are dropped; uncertain ones are downgraded. If verification fails, Standard can post unverified findings."
        />}
        {draft.reviewProfile === 'strict' && <p className="small muted">Strict always verifies blockers and majors. Missing verification blocks approval; uncertain concerns retain their severity and are clearly marked in the summary. Provider fallback settings below apply to Standard reviews.</p>}
        <div className="grid two">
          {([m.provider, backup] as Provider[]).map((p, i) => (
            <div key={p} className="model-card">
              <Field label={`${NAME[p]} models${i === 0 ? '' : draft.reviewProfile === 'strict' ? ' (independent review)' : m.fallbackToOther ? ' (backup)' : ' (not used)'}`} error={errorFor(`models.${p}`)}>
                <input
                  value={draft.models[p].model ?? ''}
                  placeholder="CLI default"
                  onChange={(e) => edit((d) => void (d.models[p].model = e.target.value.trim() || null))}
                />
                <div className="small muted">First choice. Then, in order:</div>
                <ListInput value={draft.models[p].fallbackModels} onChange={(v) => edit((d) => void (d.models[p].fallbackModels = v))} rows={2} />
              </Field>
              {byProvider.get(p) && <ModelStatus p={byProvider.get(p)!} role={i === 0 ? 'reviews' : draft.reviewProfile === 'strict' ? 'independent review' : m.fallbackToOther ? 'backup' : 'not used'} />}
            </div>
          ))}
        </div>
        <Field label="Claude effort" hint="How hard Claude thinks. Default leaves it to Claude Code.">
          <select value={m.claudeEffort ?? ''} onChange={(e) => edit((d) => void (d.models.claudeEffort = (e.target.value || null) as Settings['models']['claudeEffort']))}>
            <option value="">Default</option>
            {['low', 'medium', 'high', 'xhigh', 'max'].map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </Field>
      </Section>

      {draft.reviewProfile === 'strict' && <Section title="Strict review budgets" description="Large PRs are split into batches, then checked for interactions. Exhausted budgets leave explicit coverage gaps and prevent approval. Successful stages are reused on retry.">
        <div className="grid two">
          <Field label="Time limit per Strict run" error={errorFor('strict.passTimeoutSec')}><NumberInput value={draft.strict.passTimeoutSec} min={60} max={3600} suffix="seconds" onChange={(v) => edit((d) => void (d.strict.passTimeoutSec = v))} /></Field>
          <Field label="Characters per Strict run" error={errorFor('strict.maxDiffChars')}><NumberInput value={draft.strict.maxDiffChars} min={10000} max={1000000} onChange={(v) => edit((d) => void (d.strict.maxDiffChars = v))} /></Field>
          <Field label="Maximum review batches" error={errorFor('strict.maxBatches')}><NumberInput value={draft.strict.maxBatches} min={1} max={40} onChange={(v) => edit((d) => void (d.strict.maxBatches = v))} /></Field>
          <Field label="Maximum model attempts per job" hint="Includes fallback model attempts and verification." error={errorFor('strict.maxRuns')}><NumberInput value={draft.strict.maxRuns} min={3} max={200} onChange={(v) => edit((d) => void (d.strict.maxRuns = v))} /></Field>
          <Field label="Claude turns per Strict run" error={errorFor('strict.claudeMaxTurns')}><NumberInput value={draft.strict.claudeMaxTurns} min={5} max={200} onChange={(v) => edit((d) => void (d.strict.claudeMaxTurns = v))} /></Field>
          <Field label="Claude effort in Strict"><select value={draft.strict.claudeEffort} onChange={(e) => edit((d) => void (d.strict.claudeEffort = e.target.value as Settings['strict']['claudeEffort']))}>{['low', 'medium', 'high', 'xhigh', 'max'].map((e) => <option key={e} value={e}>{e}</option>)}</select></Field>
        </div>
      </Section>}

      <Section title="Schedule">
        <div className="grid two">
          <Field label="Check GitHub every" hint="One request per watched repo, free when nothing changed. Many repos stretch the cycle to at most one request a second." error={errorFor('schedule.pollIntervalSec')}>
            <NumberInput value={draft.schedule.pollIntervalSec} min={5} max={3600} suffix="seconds" onChange={(v) => edit((d) => void (d.schedule.pollIntervalSec = v))} />
          </Field>
          <Field label="Most reviews per hour" hint="Protects your subscription limits." error={errorFor('schedule.maxReviewsPerHour')}>
            <NumberInput value={draft.schedule.maxReviewsPerHour} min={1} max={100} onChange={(v) => edit((d) => void (d.schedule.maxReviewsPerHour = v))} />
          </Field>
          <Field label="Reviews at the same time" error={errorFor('schedule.concurrency')}>
            <NumberInput value={draft.schedule.concurrency} min={1} max={4} onChange={(v) => edit((d) => void (d.schedule.concurrency = v))} />
          </Field>
          <Field label="Rest a model after a usage limit for" error={errorFor('schedule.quotaBackoffMin')}>
            <NumberInput value={draft.schedule.quotaBackoffMin} min={1} max={1440} suffix="minutes" onChange={(v) => edit((d) => void (d.schedule.quotaBackoffMin = v))} />
          </Field>
          <Field label="Check which draft comments you kept every" error={errorFor('schedule.syncIntervalSec')}>
            <NumberInput value={draft.schedule.syncIntervalSec} min={30} max={3600} suffix="seconds" onChange={(v) => edit((d) => void (d.schedule.syncIntervalSec = v))} />
          </Field>
        </div>
        <Toggle
          checked={draft.schedule.pauseBetween !== null}
          onChange={(v) => edit((d) => void (d.schedule.pauseBetween = v ? { start: '09:00', end: '18:00' } : null))}
          label="Pause reviews during part of the day"
          hint="To keep your subscription for your own work. Queued reviews start when the window ends."
        />
        {draft.schedule.pauseBetween && (
          <Field label="Paused between" error={errorFor('schedule.pauseBetween')}>
            <div className="row number-row">
              <input type="time" value={draft.schedule.pauseBetween.start} onChange={(e) => edit((d) => void (d.schedule.pauseBetween!.start = e.target.value))} />
              <span className="muted small">and</span>
              <input type="time" value={draft.schedule.pauseBetween.end} onChange={(e) => edit((d) => void (d.schedule.pauseBetween!.end = e.target.value))} />
            </div>
          </Field>
        )}
      </Section>

      <Section title="Review limits" description={draft.reviewProfile === 'strict' ? 'Strict uses its own run budgets above and reviews real minor findings on large PRs. The nit cap and retry limit below still apply.' : undefined}>
        <div className="grid two">
          <Field label="Large PR above" hint="Then only blockers and majors are reported." error={errorFor('limits.largePrLines')}>
            <NumberInput value={draft.limits.largePrLines} min={100} suffix="changed lines" onChange={(v) => edit((d) => void (d.limits.largePrLines = v))} />
          </Field>
          <Field label="Most nits per review" error={errorFor('limits.maxNits')}>
            <NumberInput value={draft.limits.maxNits} min={0} max={20} onChange={(v) => edit((d) => void (d.limits.maxNits = v))} />
          </Field>
          <Field label="Time limit per model run" error={errorFor('limits.passTimeoutSec')}>
            <NumberInput value={draft.limits.passTimeoutSec} min={60} max={3600} suffix="seconds" onChange={(v) => edit((d) => void (d.limits.passTimeoutSec = v))} />
          </Field>
          <Field label="Attempts before giving up" error={errorFor('limits.maxAttempts')}>
            <NumberInput value={draft.limits.maxAttempts} min={1} max={10} onChange={(v) => edit((d) => void (d.limits.maxAttempts = v))} />
          </Field>
          <Field label="Diff size sent to the model" error={errorFor('limits.maxDiffChars')}>
            <NumberInput value={draft.limits.maxDiffChars} min={10000} max={1000000} suffix="characters" onChange={(v) => edit((d) => void (d.limits.maxDiffChars = v))} />
          </Field>
          <Field label="Claude turns per run" error={errorFor('limits.claudeMaxTurns')}>
            <NumberInput value={draft.limits.claudeMaxTurns} min={5} max={200} onChange={(v) => edit((d) => void (d.limits.claudeMaxTurns = v))} />
          </Field>
        </div>
      </Section>

      <Section title="Files and authors">
        <div className="grid two">
          <Field label="Leave out of reviews" hint="File patterns, one per line: lockfiles, generated and vendored code." error={errorFor('excludeGlobs')}>
            <ListInput value={draft.excludeGlobs} onChange={(v) => edit((d) => void (d.excludeGlobs = v))} rows={6} />
          </Field>
          <Field label="Skip PRs by" hint="GitHub usernames, one per line. Applies to review requests, not PRs you add yourself." error={errorFor('skipAuthors')}>
            <ListInput value={draft.skipAuthors} onChange={(v) => edit((d) => void (d.skipAuthors = v))} rows={6} />
          </Field>
        </div>
      </Section>

      <Section title="Labels" description="A PR carries one of these at a time. Each is created in the repo the first time it's needed.">
        <Field label="While reviewing" hint="Stays on while your draft is unsubmitted." error={errorFor('labels.reviewing')}>
          <input value={draft.labels.reviewing} onChange={(e) => edit((d) => void (d.labels.reviewing = e.target.value))} />
        </Field>
        <Field label="Left feedback" hint="Reviewed without approving." error={errorFor('labels.feedback')}>
          <input value={draft.labels.feedback} onChange={(e) => edit((d) => void (d.labels.feedback = e.target.value))} />
        </Field>
        <Field label="Approved" hint="Approved for you, or you submitted your draft as an approval." error={errorFor('labels.approved')}>
          <input value={draft.labels.approved} onChange={(e) => edit((d) => void (d.labels.approved = e.target.value))} />
        </Field>
      </Section>

      <Section title="Advanced">
        <Toggle
          checked={draft.keepCheckouts}
          onChange={(v) => edit((d) => void (d.keepCheckouts = v))}
          label="Keep PR checkouts after each review"
          hint="For debugging. They're kept in your system's temp folder and removed when the app restarts."
        />
      </Section>

      {(dirty || save.kind !== 'idle') && (
        <div className={`save-bar ${save.kind === 'error' ? 'save-bar-error' : ''}`} role="status">
          <span className="small">
            {save.kind === 'saving' && 'Saving…'}
            {save.kind === 'saved' && !dirty && '✓ Saved. Applies straight away.'}
            {save.kind === 'error' && save.message}
            {save.kind === 'idle' && dirty && 'You have unsaved changes.'}
          </span>
          {dirty && (
            <div className="row">
              <button type="button" className="btn btn-ghost" onClick={onDiscard} disabled={save.kind === 'saving'}>
                Discard
              </button>
              <button type="button" className="btn" onClick={onSave} disabled={save.kind === 'saving'}>
                Save changes
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
