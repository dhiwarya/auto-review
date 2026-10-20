import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import { bus } from './bus.ts';
import type { Db } from './db.ts';
import { SettingsSchema, type Settings, type SettingsIssue } from './settings-schema.ts';
import type { Provider, ReviewMode } from './types.ts';

export { SettingsSchema, type Settings, type SettingsIssue };

const KEY = 'settings';
type Matcher = (s: string) => boolean;
const never: Matcher = () => false;
const compile = (patterns: string[], opts?: picomatch.PicomatchOptions): Matcher =>
  patterns.length ? picomatch(patterns, opts) : never;

// The app's settings, stored in its database and edited from the dashboard. Every part of
// the app reads them through this object at the moment it needs them, so a saved change
// applies right away without a restart.
export class SettingsStore {
  private readonly db: Db;
  private data: Settings;
  private allow: Matcher = never;
  private deny: Matcher = never;
  private excluded: Matcher = never;

  constructor(db: Db) {
    this.db = db;
    this.data = SettingsStore.defaults();
    const raw = db.getKv(KEY);
    if (raw) {
      const parsed = SettingsSchema.safeParse(JSON.parse(raw));
      if (parsed.success) this.data = parsed.data;
      else console.error('[settings] stored settings are invalid; using defaults until they are saved again', parsed.error.issues);
    }
    this.compile();
  }

  static defaults(): Settings {
    return SettingsSchema.parse({});
  }

  get all(): Settings {
    return structuredClone(this.data);
  }

  get stored(): boolean {
    return this.db.getKv(KEY) !== null;
  }

  update(input: unknown): { ok: true; settings: Settings } | { ok: false; issues: SettingsIssue[] } {
    const parsed = SettingsSchema.safeParse(input);
    if (!parsed.success) {
      return { ok: false, issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
    }
    this.data = parsed.data;
    this.db.setKv(KEY, JSON.stringify(this.data));
    this.compile();
    bus.emit('settings');
    bus.overviewChanged();
    return { ok: true, settings: this.all };
  }

  private compile() {
    this.allow = compile(this.data.repos.allow.map((p) => p.toLowerCase()));
    this.deny = compile(this.data.repos.deny.map((p) => p.toLowerCase()));
    this.excluded = compile(this.data.excludeGlobs, { dot: true });
  }

  // One-time import from the config file used before settings moved into the dashboard.
  // The file is renamed afterwards so it's clear it no longer does anything.
  importLegacyFile(file: string): string | null {
    if (this.stored || !fs.existsSync(file)) return null;
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      return `Couldn't read ${file} to import it: ${err instanceof Error ? err.message : err}`;
    }
    delete raw.server;
    delete raw.dataDir;
    if (raw.repoModes && !Array.isArray(raw.repoModes)) {
      raw.repoModes = Object.entries(raw.repoModes as Record<string, string>).map(([repo, mode]) => ({ repo, mode }));
    }
    const result = this.update(raw);
    if (!result.ok) {
      return `Didn't import ${file}: ${result.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}. Set things up in the dashboard instead.`;
    }
    const backup = path.join(path.dirname(file), 'reviewer.config.imported.json');
    fs.renameSync(file, backup);
    return `Imported settings from ${path.basename(file)} (renamed to ${path.basename(backup)}; you can delete it). Settings now live in the dashboard.`;
  }

  // ---- sections, read live

  get repos() { return this.data.repos; }
  get dryRun() { return this.data.dryRun; }
  get defaultMode() { return this.data.defaultMode; }
  get skipAuthors() { return this.data.skipAuthors; }
  get excludeGlobs() { return this.data.excludeGlobs; }
  get models() { return this.data.models; }
  get schedule() { return this.data.schedule; }
  get limits() { return this.data.limits; }
  get labels() { return this.data.labels; }
  get keepCheckouts() { return this.data.keepCheckouts; }

  // ---- helpers

  get needsSetup(): boolean {
    return this.data.repos.allow.length === 0;
  }

  isRepoAllowed(repo: string): boolean {
    return this.allow(repo.toLowerCase()) && !this.deny(repo.toLowerCase());
  }

  isExcludedFile(file: string): boolean {
    return this.excluded(file);
  }

  modeFor(repo: string): ReviewMode {
    const hit = this.data.repoModes.find((o) => picomatch.isMatch(repo.toLowerCase(), o.repo.toLowerCase()));
    return hit ? hit.mode : this.data.defaultMode;
  }

  labelName(kind: 'running' | 'done' | 'blocker' | 'failed'): string {
    return `${this.data.labels.prefix}:${kind}`;
  }

  modelChain(p: Provider): (string | null)[] {
    const m = this.data.models[p];
    return [...new Set([m.model, ...m.fallbackModels])];
  }

  // The chosen provider first, then the other one if falling back is on.
  providerOrder(): Provider[] {
    const first = this.data.models.provider;
    const other: Provider = first === 'claude' ? 'codex' : 'claude';
    return this.data.models.fallbackToOther ? [first, other] : [first];
  }
}
