import spawn from 'cross-spawn';

export interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

// Only what the CLIs need to start and find their own logins. Everything else,
// including GITHUB_TOKEN and any API keys, stays out of the agents' environment.
const ENV_ALLOW = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TEMP', 'TMP', 'LANG', 'TZ',
  'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'PATHEXT', 'HOMEDRIVE', 'HOMEPATH',
  'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR',
  'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_HOME', 'DISABLE_AUTOUPDATER',
];

export function agentEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NO_COLOR: '1', TERM: 'dumb' };
  for (const key of ENV_ALLOW) if (process.env[key] !== undefined) env[key] = process.env[key];
  for (const key of Object.keys(process.env)) if (key.startsWith('LC_')) env[key] = process.env[key];
  return env;
}

export function runCli(opts: {
  cmd: string;
  args: string[];
  cwd: string;
  input: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(opts.cmd, opts.args, { cwd: opts.cwd, env: agentEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const kill = () => {
      if (child.exitCode === null) child.kill('SIGTERM');
      setTimeout(() => child.exitCode === null && child.kill('SIGKILL'), 5000).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    const onAbort = () => kill();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      resolve({ code, stdout, stderr, durationMs: Date.now() - started, timedOut });
    });
    child.stdin?.on('error', () => {}); // the child may exit before reading everything
    child.stdin?.end(opts.input);
  });
}

// Errors that mean "this model or provider can't take work right now", as opposed to a bad run.
//   quota      usage limit reached (that model, or the whole plan)
//   model      the model doesn't exist or isn't available on your plan
//   overloaded temporary capacity problem on the provider's side
//   auth       not signed in
//   missing    CLI not installed
export type UnavailableReason = 'quota' | 'model' | 'overloaded' | 'auth' | 'missing';

export class ProviderUnavailable extends Error {
  readonly reason: UnavailableReason;
  constructor(reason: UnavailableReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

const QUOTA = /usage limit|limit reached|hit your limit|rate.?limit|too many requests|\b429\b|quota exceeded|out of credits/i;
const MODEL = /model\b.{0,80}(not found|does not exist|not supported|unsupported|not available|unavailable|invalid|unknown|not allowed|no access|do not have access)|(unknown|invalid|unsupported) model|no such model|model_not_found/i;
const OVERLOADED = /overloaded|\b529\b|\b503\b|service unavailable|capacity/i;
const AUTH = /not logged in|please log in|login required|run .*login|unauthori[sz]ed|\b401\b|invalid api key|authentication/i;

export function classifyFailure(text: string): ProviderUnavailable | null {
  if (QUOTA.test(text)) return new ProviderUnavailable('quota', text.slice(0, 300));
  if (MODEL.test(text)) return new ProviderUnavailable('model', text.slice(0, 300));
  if (OVERLOADED.test(text)) return new ProviderUnavailable('overloaded', text.slice(0, 300));
  if (AUTH.test(text)) return new ProviderUnavailable('auth', text.slice(0, 300));
  return null;
}
