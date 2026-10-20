import { useEffect, useRef, useState } from 'react';
import type { Job, Overview, StreamMessage } from '../../src/types.ts';

export async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? res.statusText);
  return res.json() as Promise<T>;
}

// Errors carry the server's response body, e.g. per-field issues from a settings save.
export class ApiError extends Error {
  readonly data: unknown;
  constructor(message: string, data: unknown) {
    super(message);
    this.data = data;
  }
}

export async function sendJson<T = unknown>(method: 'POST' | 'PUT', path: string, body: unknown = {}): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { 'content-type': 'application/json', 'x-auto-reviewer': '1' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.error ?? res.statusText, data);
  return data as T;
}

export const postJson = <T = unknown>(path: string, body: unknown = {}) => sendJson<T>('POST', path, body);

type Listener = (msg: StreamMessage) => void;
const listeners = new Set<Listener>();
let source: EventSource | null = null;

function ensureStream() {
  if (source) return;
  source = new EventSource('/api/stream');
  source.onmessage = (e) => {
    const msg = JSON.parse(e.data) as StreamMessage;
    for (const l of listeners) l(msg);
  };
}

export function useStream(listener: Listener) {
  const ref = useRef(listener);
  ref.current = listener;
  useEffect(() => {
    ensureStream();
    const l: Listener = (m) => ref.current(m);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
}

export function useOverview(): Overview | null {
  const [overview, setOverview] = useState<Overview | null>(null);
  useEffect(() => {
    getJson<Overview>('/api/overview').then(setOverview).catch(() => {});
  }, []);
  useStream((m) => m.type === 'overview' && setOverview(m.overview));
  return overview;
}

export function useJobs(): { jobs: Job[]; loaded: boolean } {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    getJson<Job[]>('/api/jobs')
      .then((j) => setJobs(j))
      .finally(() => setLoaded(true));
  }, []);
  useStream((m) => {
    if (m.type !== 'job') return;
    setJobs((prev) => {
      const i = prev.findIndex((j) => j.id === m.job.id);
      if (i === -1) return [m.job, ...prev];
      const next = prev.slice();
      next[i] = m.job;
      return next;
    });
  });
  return { jobs, loaded };
}

// Re-renders every few seconds so relative times stay fresh.
export function useTick(ms = 15_000) {
  const [, set] = useState(0);
  useEffect(() => {
    const t = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}
