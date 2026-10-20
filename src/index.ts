import fs from 'node:fs';
import path from 'node:path';
import { Db } from './db.ts';
import { cleanupStaleCheckouts, RepoCache } from './git/mirror.ts';
import { connectGitHub } from './github/client.ts';
import { Poller } from './jobs/poller.ts';
import { OutcomeSync } from './jobs/sync.ts';
import { Worker } from './jobs/worker.ts';
import { Router } from './llm/router.ts';
import { ReviewPipeline } from './review/pipeline.ts';
import { startServer } from './server/app.ts';
import { SettingsStore } from './settings.ts';

try {
  process.loadEnvFile('.env');
} catch {
  // .env is optional
}

// Everything else is configured in the dashboard; these two are needed before it can start.
const dataPath = path.resolve(process.env.DATA_DIR || 'data');
const port = Number(process.env.PORT || 4477);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`PORT must be a port number, got "${process.env.PORT}"`);
fs.mkdirSync(dataPath, { recursive: true });

const db = new Db(dataPath);
const cfg = new SettingsStore(db);
const imported = cfg.importLegacyFile(path.resolve('reviewer.config.json'));
if (imported) console.log(imported);
const gh = await connectGitHub();
await cleanupStaleCheckouts();
const cache = new RepoCache(path.join(dataPath, 'repos'), gh.token);
await cache.pruneAll();

const router = new Router(db, cfg);
const pipeline = new ReviewPipeline(gh, cfg, db, router, cache);
const worker = new Worker(db, cfg, pipeline);
const sync = new OutcomeSync(gh, cfg, db);
const poller = new Poller(gh, cfg, db, worker, sync);
const app = await startServer({ cfg, port, db, gh, router, worker, poller, pipeline });

worker.start();
poller.start();

console.log(`Auto Reviewer running as @${gh.me} (GitHub login from ${gh.authSource})`);
console.log(`  dashboard: http://127.0.0.1:${port}`);
console.log(`  repos: ${cfg.needsSetup ? 'none yet (add them in Settings)' : cfg.repos.allow.join(', ')}`);
console.log(`  mode: ${cfg.defaultMode}${cfg.dryRun ? ' (DRY RUN: nothing is posted to GitHub)' : ''}`);

// Ctrl+C stops the app: reviews in progress go back to the queue and resume on the next
// start. A second Ctrl+C, or a stop that takes longer than 5 seconds, exits immediately.
let stopping = false;
async function shutdown() {
  if (stopping) {
    console.log('Stopping now.');
    process.exit(1);
  }
  stopping = true;
  console.log('Stopping… (press Ctrl+C again to force)');
  setTimeout(() => {
    console.log('Took too long to stop cleanly; exiting.');
    process.exit(1);
  }, 5000).unref();
  poller.stop();
  worker.stop();
  await app.close();
  db.sql.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
