import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { classifyFailure, ProviderUnavailable, runCli, type CliResult } from './run.ts';
import type { Provider, StepKind, StepStatus } from '../types.ts';

export interface AgentTask {
  cwd: string; // the PR checkout
  workDir: string; // scratch folder outside the checkout for schema/prompt/output files
  instructions: string; // standing rules (system prompt addition)
  prompt: string; // per-PR content
  schema: object;
  model: string | null;
  timeoutMs: number;
  signal?: AbortSignal;
  // Called for each thing the model does, as it does it.
  onStep?: (step: StepEvent) => void;
}

// A step as the CLI reports it. A later event with the same ref updates it: a command that
// finishes, or a tool's result arriving.
export interface StepEvent {
  ref: string | null;
  kind: StepKind;
  title?: string;
  detail?: string | null;
  status: StepStatus;
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

export interface RunUsage {
  turns: number | null; // model round trips (Claude reports these; Codex doesn't)
  toolCalls: number | null; // file reads and searches (Claude) or shell commands (Codex)
  inputTokens: number | null; // including the cached part
  cachedInputTokens: number | null;
  outputTokens: number | null;
  costUsd: number | null; // Claude's estimate at API prices; not what a subscription bills
}

export interface AgentResult {
  output: unknown;
  durationMs: number;
  usage: RunUsage;
}

const lines = (stdout: string) =>
  stdout.split('\n').flatMap((l) => {
    try {
      return l.trim() ? [JSON.parse(l)] : [];
    } catch {
      return [];
    }
  });

interface ClaudeResultEvent {
  type: 'result';
  is_error?: boolean;
  subtype?: string;
  result?: string;
  structured_output?: unknown;
  api_error_status?: number | null;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number; output_tokens?: number };
}

// Claude's stream-json output: one event per line, ending with a "result" event.
export function parseClaudeStream(stdout: string): { result: ClaudeResultEvent | null; usage: RunUsage } {
  let result: ClaudeResultEvent | null = null;
  let toolCalls = 0;
  for (const e of lines(stdout)) {
    if (e.type === 'assistant') {
      for (const block of e.message?.content ?? []) {
        // The structured answer itself arrives as a tool call; it isn't exploration.
        if (block.type === 'tool_use' && !/structuredoutput/i.test(block.name ?? '')) toolCalls++;
      }
    } else if (e.type === 'result') {
      result = e;
    }
  }
  const u = result?.usage;
  const cached = u?.cache_read_input_tokens ?? 0;
  return {
    result,
    usage: {
      turns: result?.num_turns ?? null,
      toolCalls,
      inputTokens: u ? (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + cached : null,
      cachedInputTokens: u ? cached : null,
      outputTokens: u?.output_tokens ?? null,
      costUsd: result?.total_cost_usd ?? null,
    },
  };
}

// Codex's --json output: one event per line.
export function parseCodexEvents(stdout: string): { lastMessage: string | null; usage: RunUsage } {
  let toolCalls = 0;
  let input = 0;
  let cached = 0;
  let output = 0;
  let sawUsage = false;
  let lastMessage: string | null = null;
  for (const e of lines(stdout)) {
    if (e.type === 'item.completed' && e.item?.type === 'command_execution') toolCalls++;
    if (e.type === 'item.completed' && e.item?.type === 'agent_message' && typeof e.item.text === 'string') lastMessage = e.item.text;
    if (e.type === 'turn.completed' && e.usage) {
      sawUsage = true;
      input += e.usage.input_tokens ?? 0;
      cached += e.usage.cached_input_tokens ?? 0;
      output += (e.usage.output_tokens ?? 0) + (e.usage.reasoning_output_tokens ?? 0);
    }
  }
  return {
    lastMessage,
    usage: {
      turns: null,
      toolCalls,
      inputTokens: sawUsage ? input : null,
      cachedInputTokens: sawUsage ? cached : null,
      outputTokens: sawUsage ? output : null,
      costUsd: null,
    },
  };
}

// ---- following a run step by step

const MAX_DETAIL = 8000;
const firstLine = (text: string, max = 160) => {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
};
const looksLikeJson = (text: string) => /^\s*[{[]/.test(text);

// "/bin/bash -lc 'cat a.txt'" reads better as "cat a.txt".
export function shellCommand(cmd: string): string {
  const m = /^(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh -l?c '([\s\S]*)'$/.exec(cmd.trim());
  return m ? m[1].replace(/'\\''/g, "'") : cmd;
}

// One event of `codex exec --json` as a step, or null when it isn't one.
export function codexStep(e: any): StepEvent | null {
  if (e?.type === 'turn.failed' || e?.type === 'error') {
    const message = String(e.error?.message ?? e.message ?? 'failed');
    return { ref: null, kind: 'error', title: firstLine(message), detail: message, status: 'failed' };
  }
  if (e?.type !== 'item.started' && e?.type !== 'item.updated' && e?.type !== 'item.completed') return null;
  const item = e.item ?? {};
  const done = e.type === 'item.completed';
  const ref = typeof item.id === 'string' ? item.id : null;
  if (item.type === 'command_execution') {
    return {
      ref,
      kind: 'command',
      title: shellCommand(String(item.command ?? '')),
      detail: done ? String(item.aggregated_output ?? '') : null,
      status: !done ? 'running' : item.exit_code === 0 ? 'ok' : 'failed',
    };
  }
  if (!done) return null;
  const text = String(item.text ?? '');
  if (item.type === 'agent_message') {
    return looksLikeJson(text)
      ? { ref, kind: 'output', title: 'Final answer', detail: text, status: 'ok' }
      : { ref, kind: 'message', title: firstLine(text), detail: text, status: 'ok' };
  }
  if (item.type === 'reasoning') return { ref, kind: 'reasoning', title: firstLine(text), detail: text, status: 'ok' };
  if (item.type === 'error') return { ref, kind: 'error', title: firstLine(String(item.message ?? '')), detail: String(item.message ?? ''), status: 'failed' };
  // Anything else (a web search, a blocked file change, a plan update): show what it was.
  const what = String(item.type ?? 'item').replace(/_/g, ' ');
  return { ref, kind: 'tool', title: item.query ? `${what}: ${item.query}` : what, detail: JSON.stringify(item, null, 2), status: 'ok' };
}

function claudeToolTitle(name: string, input: any): string {
  if (name === 'Read') return `Read ${input?.file_path ?? ''}${input?.offset ? ` from line ${input.offset}` : ''}`;
  if (name === 'Grep') return `Grep ${input?.pattern ?? ''}${input?.path ? ` in ${input.path}` : ''}${input?.glob ? ` (${input.glob})` : ''}`;
  if (name === 'Glob') return `Glob ${input?.pattern ?? ''}${input?.path ? ` in ${input.path}` : ''}`;
  return `${name} ${JSON.stringify(input ?? {}).slice(0, 120)}`;
}

// The steps in one line of Claude's stream-json output: tool calls and text from the
// assistant, tool results from the "user" turn that answers them.
export function claudeSteps(e: any): StepEvent[] {
  const steps: StepEvent[] = [];
  if (e?.type === 'assistant') {
    for (const block of e.message?.content ?? []) {
      if (block.type === 'tool_use' && /structuredoutput/i.test(block.name ?? '')) {
        steps.push({ ref: block.id ?? null, kind: 'output', title: 'Final answer', detail: JSON.stringify(block.input ?? {}, null, 2), status: 'ok' });
      } else if (block.type === 'tool_use') {
        steps.push({ ref: block.id ?? null, kind: 'tool', title: claudeToolTitle(block.name ?? 'tool', block.input), status: 'running' });
      } else if (block.type === 'text' && block.text?.trim()) {
        steps.push({ ref: null, kind: 'message', title: firstLine(block.text), detail: block.text, status: 'ok' });
      } else if (block.type === 'thinking' && block.thinking?.trim()) {
        steps.push({ ref: null, kind: 'reasoning', title: firstLine(block.thinking), detail: block.thinking, status: 'ok' });
      }
    }
  } else if (e?.type === 'user') {
    for (const block of e.message?.content ?? []) {
      if (block.type !== 'tool_result') continue;
      const content = Array.isArray(block.content)
        ? block.content.map((c: { text?: string }) => c.text ?? '').join('\n')
        : String(block.content ?? '');
      steps.push({ ref: block.tool_use_id ?? null, kind: 'tool', detail: content, status: block.is_error ? 'failed' : 'ok' });
    }
  } else if (e?.type === 'result' && e.is_error) {
    const message = String(e.result ?? e.subtype ?? 'failed');
    steps.push({ ref: null, kind: 'error', title: firstLine(message), detail: message, status: 'failed' });
  }
  return steps;
}

// Paths relative to the checkout, and long output cut short, before a step is stored.
function stepSink(task: AgentTask, toSteps: (event: unknown) => StepEvent[]): ((line: string) => void) | undefined {
  if (!task.onStep) return undefined;
  const roots = [...new Set([task.cwd, task.cwd.replace(/\\/g, '/')])].map((r) => r.replace(/[\\/]+$/, ''));
  const tidy = (text: string) => roots.reduce((t, root) => t.split(`${root}/`).join('').split(`${root}\\`).join(''), text);
  return (line) => {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    for (const s of toSteps(event)) {
      const detail = s.detail == null ? s.detail : tidy(s.detail);
      task.onStep!({
        ...s,
        title: s.title === undefined ? undefined : tidy(s.title),
        detail: detail && detail.length > MAX_DETAIL ? `${detail.slice(0, MAX_DETAIL)}\n…[${detail.length - MAX_DETAIL} more characters]` : detail,
      });
    }
  };
}

// Claude Code in print mode: read-only tools, no project settings or hooks from the PR,
// no MCP servers, nothing saved to disk, output validated against the schema.
export async function runClaude(task: AgentTask, limits: AgentLimits): Promise<AgentResult> {
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
    '--output-format', 'stream-json',
    '--verbose',
    '--json-schema', JSON.stringify(task.schema),
    '--max-turns', String(limits.claudeMaxTurns),
    '--append-system-prompt-file', rulesFile,
    ...(task.model ? ['--model', task.model] : []),
    ...(limits.claudeEffort ? ['--effort', limits.claudeEffort] : []),
  ];
  const res = await spawnOrUnavailable('claude', () =>
    runCli({ cmd: 'claude', args, cwd: task.cwd, input: task.prompt, timeoutMs: task.timeoutMs, signal: task.signal, onLine: stepSink(task, claudeSteps) }),
  );

  const { result, usage } = parseClaudeStream(res.stdout);
  if (!result || res.code !== 0 || result.is_error) {
    const detail = [result?.api_error_status ? `HTTP ${result.api_error_status}` : '', result?.subtype ?? '', result?.result ?? '', res.stderr, result ? '' : res.stdout.slice(-2000)]
      .filter(Boolean)
      .join(' | ');
    throw failure('claude', res, detail || 'no output');
  }
  if (result.structured_output !== undefined) return { output: result.structured_output, durationMs: res.durationMs, usage };
  try {
    return { output: JSON.parse(result.result ?? ''), durationMs: res.durationMs, usage };
  } catch {
    throw new Error('claude returned no structured output');
  }
}

// Codex in exec mode: read-only sandbox (no writes, no network), no user config or MCP
// servers, no AGENTS.md from the PR, nothing saved to disk.
export async function runCodex(task: AgentTask): Promise<AgentResult> {
  const runId = randomUUID();
  const schemaFile = path.join(task.workDir, `codex-schema-${runId}.json`);
  const outFile = path.join(task.workDir, `codex-out-${runId}.json`);
  await fs.writeFile(schemaFile, JSON.stringify(task.schema));
  const args = [
    'exec',
    '--json',
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
    runCli({
      cmd: 'codex',
      args,
      cwd: task.cwd,
      input,
      timeoutMs: task.timeoutMs,
      signal: task.signal,
      onLine: stepSink(task, (e) => {
        const step = codexStep(e);
        return step ? [step] : [];
      }),
    }),
  );
  if (res.code !== 0) throw failure('codex', res, `${res.stderr}\n${res.stdout}`.trim() || 'no output');
  const { lastMessage, usage } = parseCodexEvents(res.stdout);
  const text = (await fs.readFile(outFile, 'utf8').catch(() => null)) ?? lastMessage;
  if (!text) throw new Error('codex finished without writing a result');
  try {
    return { output: JSON.parse(text), durationMs: res.durationMs, usage };
  } catch {
    throw new Error(`codex returned invalid JSON: ${text.slice(0, 200)}`);
  }
}
