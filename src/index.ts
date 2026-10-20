import { loadConfig } from './config.ts';
import { Db } from './db.ts';
import { cleanupStaleCheckouts } from './git/checkout.ts';
import { connectGitHub } from './github/client.ts';
import { Poller } from './jobs/poller.ts';
import { OutcomeSync } from './jobs/sync.ts';
import { Worker } from './jobs/worker.ts';
import { Router } from './llm/router.ts';
import { ReviewPipeline } from './review/pipeline.ts';
import { startServer } from './server/app.ts';

try {
  process.loadEnvFile('.env');
} catch {
  // .env is optional
}

const cfg = loadConfig();
const db = new Db(cfg.dataPath);
const gh = await connectGitHub();
await cleanupStaleCheckouts();

const router = new Router(db, cfg);
const pipeline = new ReviewPipeline(gh, cfg, db, router);
const worker = new Worker(db, cfg, pipeline);
const sync = new OutcomeSync(gh, cfg, db);
const poller = new Poller(gh, cfg, db, worker, sync);
const app = await startServer({ cfg, db, gh, router, worker, poller });

worker.start();
poller.start();

const allow = cfg.repos.allow.join(', ');
console.log(`Auto Reviewer running as @${gh.me} (GitHub login from ${gh.authSource})`);
console.log(`  dashboard: http://${cfg.server.host === '0.0.0.0' ? '127.0.0.1' : cfg.server.host}:${cfg.server.port}`);
console.log(`  repos: ${allow}`);
console.log(`  mode: ${cfg.defaultMode}${cfg.dryRun ? ' (DRY RUN: nothing is posted to GitHub)' : ''}`);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  poller.stop();
  worker.stop();
  await app.close();
  db.sql.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
