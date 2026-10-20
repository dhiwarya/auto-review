import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { classifyFailure, ProviderUnavailable, runCli, type CliResult } from './run.ts';
import type { Provider } from '../types.ts';

export interface AgentTask {
  cwd: string; // the PR checkout
  workDir: string; // scratch folder outside the checkout for schema/prompt/output files
  instructions: string; // standing rules (system prompt addition)
  prompt: string; // per-PR content
  schema: object;
  model: string | null;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface AgentLimits {
  claudeMaxTurns: number;
  claudeEffort: string | null;
}

async function spawnOrUnavailable(provider: Provider, fn: () => Promise<CliResult>): Promise<CliResult> {
  try {
    return await fn();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ProviderUnavailable('missing', `${provider} CLI not found on PATH`);
    }
    throw err;
  }
}

function failure(provider: Provider, res: CliResult, detail: string): Error {
  if (res.timedOut) return new Error(`${provider} timed out after ${Math.round(res.durationMs / 1000)}s`);
  // Only the tail: earlier output can echo the prompt, and PR code may mention "rate limit".
  const tail = detail.slice(-1500);
  return classifyFailure(tail) ?? new Error(`${provider} failed (exit ${res.code}): ${tail.slice(-400)}`);
}

// Claude Code in print mode: read-only tools, no project settings or hooks from the PR,
// no MCP servers, nothing saved to disk, output validated against the schema.
export async function runClaude(task: AgentTask, limits: AgentLimits): Promise<{ output: unknown; durationMs: number }> {
  // Unique per run: passes run in parallel and can share a work folder and provider.
  const rulesFile = path.join(task.workDir, `claude-rules-${randomUUID()}.md`);
  await fs.writeFile(rulesFile, task.instructions);
  const args = [
    '-p',
    '--restricted',
    '--tools', 'Read,Grep,Glob',
    '--permission-prompts', 'none',
    '--strict-mcp-config',
    '--no-session-persistence',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(task.schema),
    '--max-turns', String(limits.claudeMaxTurns),
    '--append-system-prompt-file', rulesFile,
    ...(task.model ? ['--model', task.model] : []),
    ...(limits.claudeEffort ? ['--effort', limits.claudeEffort] : []),
  ];
  const res = await spawnOrUnavailable('claude', () =>
    runCli({ cmd: 'claude', args, cwd: task.cwd, input: task.prompt, timeoutMs: task.timeoutMs, signal: task.signal }),
  );

  let parsed: { is_error?: boolean; subtype?: string; result?: string; structured_output?: unknown; api_error_status?: number | null } | null = null;
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    // not JSON: a startup error
  }
  if (!parsed || res.code !== 0 || parsed.is_error) {
    const detail = [parsed?.api_error_status ? `HTTP ${parsed.api_error_status}` : '', parsed?.subtype ?? '', parsed?.result ?? '', res.stderr, parsed ? '' : res.stdout]
      .filter(Boolean)
      .join(' | ');
    throw failure('claude', res, detail || 'no output');
  }
  if (parsed.structured_output !== undefined) return { output: parsed.structured_output, durationMs: res.durationMs };
  try {
    return { output: JSON.parse(parsed.result ?? ''), durationMs: res.durationMs };
  } catch {
    throw new Error('claude returned no structured output');
  }
}

// Codex in exec mode: read-only sandbox (no writes, no network), no user config or MCP
// servers, no AGENTS.md from the PR, nothing saved to disk.
export async function runCodex(task: AgentTask): Promise<{ output: unknown; durationMs: number }> {
  const runId = randomUUID();
  const schemaFile = path.join(task.workDir, `codex-schema-${runId}.json`);
  const outFile = path.join(task.workDir, `codex-out-${runId}.json`);
  await fs.writeFile(schemaFile, JSON.stringify(task.schema));
  const args = [
    'exec',
    '--sandbox', 'read-only',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '-c', 'project_doc_max_bytes=0',
    '--color', 'never',
    '--output-schema', schemaFile,
    '-o', outFile,
    '-C', task.cwd,
    ...(task.model ? ['-m', task.model] : []),
    '-',
  ];
  const input = `${task.instructions}\n\n---\n\n${task.prompt}`;
  const res = await spawnOrUnavailable('codex', () =>
    runCli({ cmd: 'codex', args, cwd: task.cwd, input, timeoutMs: task.timeoutMs, signal: task.signal }),
  );
  if (res.code !== 0) throw failure('codex', res, `${res.stderr}\n${res.stdout}`.trim() || 'no output');
  let text: string;
  try {
    text = await fs.readFile(outFile, 'utf8');
  } catch {
    throw new Error('codex finished without writing a result');
  }
  try {
    return { output: JSON.parse(text), durationMs: res.durationMs };
  } catch {
    throw new Error(`codex returned invalid JSON: ${text.slice(0, 200)}`);
  }
}
