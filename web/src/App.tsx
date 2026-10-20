import { useEffect, useState } from 'react';
import type { Overview, ProviderStatus } from '../../src/types.ts';
import { postJson, useOverview, useTick } from './api.ts';
import { JobView } from './pages/JobView.tsx';
import { LeaderboardPage } from './pages/Leaderboard.tsx';
import { QueuePage } from './pages/Queue.tsx';
import { SettingsPage } from './pages/Settings.tsx';
import { clockTime, timeAgo } from './ui.tsx';

function useHashRoute(): string[] {
  const read = () => window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => {
      setRoute(read());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

function ProviderPill({ p }: { p: ProviderStatus }) {
  const name = p.provider === 'claude' ? 'Claude' : 'Codex';
  const blocked = p.blocked_until !== null;
  const auth = p.last_error?.startsWith('auth') || p.last_error?.startsWith('missing');
  const label = blocked ? (auth ? 'not signed in' : `limited until ${clockTime(p.blocked_until!)}`) : 'ready';
  return (
    <span className={`pill ${blocked ? 'pill-warn' : 'pill-ok'}`} title={p.last_error ?? undefined}>
      <span className="dot" />
      {name}: {label}
    </span>
  );
}

function Header({ overview, route }: { overview: Overview | null; route: string[] }) {
  useTick();
  const [polling, setPolling] = useState(false);
  const tab = route[0] ?? 'queue';
  const poll = async () => {
    setPolling(true);
    await postJson('/api/poll').catch(() => {});
    setTimeout(() => setPolling(false), 1500);
  };
  return (
    <header className="header">
      <div className="header-row">
        <a className="brand" href="#/">
          <span className="logo" aria-hidden>
            ✓
          </span>
          Auto Reviewer
        </a>
        <nav className="tabs" aria-label="Sections">
          <a className={tab === 'queue' || tab === 'jobs' ? 'active' : ''} href="#/">
            Queue
          </a>
          <a className={tab === 'leaderboard' ? 'active' : ''} href="#/leaderboard/models">
            Leaderboard
          </a>
          <a className={tab === 'settings' ? 'active' : ''} href="#/settings">
            Settings
          </a>
        </nav>
        <div className="header-status">
          {overview?.me && (
            <a
              className="pill pill-ok"
              href={`https://github.com/${overview.me}`}
              target="_blank"
              rel="noreferrer"
              title={`Reviewing PRs that request @${overview.me}. Login from ${overview.github_auth}.`}
            >
              <span className="dot" />
              GitHub: @{overview.me}
            </a>
          )}
          {overview?.providers.map((p) => <ProviderPill key={p.provider} p={p} />)}
          <span className="muted small" title={overview?.last_poll_error ?? undefined}>
            {overview?.last_poll_error ? '⚠ last poll failed' : `Checked ${timeAgo(overview?.last_poll_at)}`}
          </span>
          <button className="btn btn-small" onClick={poll} disabled={polling}>
            {polling ? 'Checking…' : 'Check now'}
          </button>
        </div>
      </div>
      {overview?.dry_run && (
        <div className="banner">
          <strong>Dry run.</strong> Reviews run, but nothing is posted to GitHub and no labels change. Set{' '}
          <code>"dryRun": false</code> in <code>reviewer.config.json</code> and restart when you're ready.
        </div>
      )}
      {overview?.paused_reason && <div className="banner banner-muted">{overview.paused_reason}. Queued reviews start after that.</div>}
    </header>
  );
}

export function App() {
  const route = useHashRoute();
  const overview = useOverview();
  let page;
  if (route[0] === 'jobs' && route[1]) page = <JobView id={Number(route[1])} />;
  else if (route[0] === 'leaderboard') page = <LeaderboardPage kind={(route[1] as 'models' | 'repos' | 'authors') ?? 'models'} />;
  else if (route[0] === 'settings') page = <SettingsPage overview={overview} />;
  else page = <QueuePage overview={overview} />;
  return (
    <>
      <Header overview={overview} route={route} />
      <main className="main">{page}</main>
    </>
  );
}
