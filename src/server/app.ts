import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { bus } from '../bus.ts';
import type { LoadedConfig } from '../config.ts';
import type { Db } from '../db.ts';
import type { GitHub } from '../github/client.ts';
import { getPr } from '../github/prs.ts';
import type { Poller } from '../jobs/poller.ts';
import type { Worker } from '../jobs/worker.ts';
import type { Router } from '../llm/router.ts';
import type { Job, JobDetail, JobState, LeaderboardKind, Overview, StreamMessage } from '../types.ts';
import { leaderboard } from './leaderboard.ts';

interface Deps {
  cfg: LoadedConfig;
  db: Db;
  gh: GitHub;
  router: Router;
  worker: Worker;
  poller: Poller;
}

const WEB_DIST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');

export function overview({ cfg, db, gh, router, worker }: Deps): Overview {
  const counts = { queued: 0, running: 0, waiting: 0, done: 0, failed: 0, cancelled: 0, skipped: 0 } as Record<JobState, number>;
  for (const r of db.all<{ state: JobState; n: number }>('SELECT state, COUNT(*) AS n FROM jobs GROUP BY state')) counts[r.state] = r.n;
  return {
    me: gh.me,
    github_auth: gh.authSource,
    dry_run: cfg.dryRun,
    default_mode: cfg.defaultMode,
    counts,
    last_poll_at: db.getKv('last_poll_at'),
    next_poll_at: db.getKv('next_poll_at'),
    last_poll_error: db.getKv('last_poll_error'),
    providers: router.status(),
    paused_reason: worker.pausedReason(),
  };
}

// "https://github.com/owner/repo/pull/12" or "owner/repo#12"
function parsePrRef(input: string): { repo: string; number: number } | null {
  const url = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/.exec(input);
  if (url) return { repo: url[1], number: Number(url[2]) };
  const short = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(input.trim());
  return short ? { repo: short[1], number: Number(short[2]) } : null;
}

export async function startServer(deps: Deps) {
  const { cfg, db, gh, worker, poller } = deps;
  const app = Fastify({ logger: false });
  const port = cfg.server.port;
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]);

  // The dashboard is for this machine only. Checking Host blocks DNS-rebinding pages, and
  // requiring a custom header on writes blocks other websites from posting to the API.
  app.addHook('onRequest', async (req, reply) => {
    if (!allowedHosts.has(req.headers.host ?? '')) return reply.code(403).send({ error: 'forbidden host' });
    if (req.method !== 'GET' && req.headers['x-auto-reviewer'] !== '1') return reply.code(403).send({ error: 'missing header' });
  });

  app.get('/api/overview', async () => overview(deps));

  app.get<{ Querystring: { limit?: string } }>('/api/jobs', async (req) => {
    const limit = Math.min(Number(req.query.limit ?? 200) || 200, 1000);
    return db.all<Job>('SELECT * FROM jobs ORDER BY id DESC LIMIT ?', limit).map((j) => db.withCounts(j));
  });

  app.get<{ Params: { id: string } }>('/api/jobs/:id', async (req, reply) => {
    const job = db.job(Number(req.params.id));
    if (!job) return reply.code(404).send({ error: 'not found' });
    return {
      job: db.withCounts(job),
      findings: db.findings(job.id),
      events: db.events(job.id),
      runs: db.runs(job.id),
    } satisfies JobDetail;
  });

  app.post<{ Body: { pr?: string } }>('/api/jobs', async (req, reply) => {
    const ref = parsePrRef(req.body?.pr ?? '');
    if (!ref) return reply.code(400).send({ error: 'Use a PR link or owner/repo#123' });
    if (!cfg.isRepoAllowed(ref.repo)) return reply.code(400).send({ error: `${ref.repo} isn't in repos.allow` });
    try {
      const pr = await getPr(gh, ref.repo, ref.number);
      if (pr.state !== 'open') return reply.code(400).send({ error: 'That PR is not open' });
      return poller.enqueue(pr, 'manual');
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post<{ Params: { id: string } }>('/api/jobs/:id/retry', async (req) => {
    worker.retry(Number(req.params.id));
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/jobs/:id/cancel', async (req) => {
    worker.cancel(Number(req.params.id), 'cancelled from the dashboard');
    return { ok: true };
  });

  app.post('/api/poll', async () => {
    void poller.pollOnce();
    return { ok: true };
  });

  app.post<{ Params: { provider: string } }>('/api/providers/:provider/reset', async (req, reply) => {
    const p = req.params.provider;
    if (p !== 'claude' && p !== 'codex') return reply.code(400).send({ error: 'unknown provider' });
    deps.router.clear(p);
    return { ok: true };
  });

  app.get<{ Params: { kind: string } }>('/api/leaderboard/:kind', async (req, reply) => {
    const kind = req.params.kind as LeaderboardKind;
    if (!['models', 'repos', 'authors'].includes(kind)) return reply.code(404).send({ error: 'unknown leaderboard' });
    return leaderboard(db, kind);
  });

  app.get('/api/config', async () => {
    const { configPath, dataPath, ...rest } = cfg;
    return { configPath, dataPath, ...JSON.parse(JSON.stringify(rest)) };
  });

  // Live updates: job changes as they happen, overview at most a few times a second.
  app.get('/api/stream', (req, reply) => {
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = (msg: StreamMessage) => reply.raw.write(`data: ${JSON.stringify(msg)}\n\n`);
    let pending: NodeJS.Timeout | null = null;
    const onJob = (msg: StreamMessage) => {
      send(msg);
      onOverview();
    };
    const onOverview = () => {
      if (pending) return;
      pending = setTimeout(() => {
        pending = null;
        send({ type: 'overview', overview: overview(deps) });
      }, 300);
    };
    bus.on('message', onJob);
    bus.on('overview', onOverview);
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
    send({ type: 'overview', overview: overview(deps) });
    req.raw.on('close', () => {
      bus.off('message', onJob);
      bus.off('overview', onOverview);
      clearInterval(heartbeat);
      if (pending) clearTimeout(pending);
    });
  });

  if (fs.existsSync(WEB_DIST)) {
    await app.register(fastifyStatic, { root: WEB_DIST });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
      return reply.sendFile('index.html');
    });
  } else {
    app.get('/', async (_req, reply) => reply.type('text/plain').send('Dashboard not built yet. Run `npm run build`, then restart.'));
  }

  await app.listen({ host: cfg.server.host, port });
  return app;
}
