/**
 * Child-process helper for the Postgres CLI tools.
 *
 * The sidecar drives Postgres exclusively through its own binaries (`initdb`,
 * `pg_ctl`, `pg_isready`, `pg_dump`, `pg_restore`, `psql`) rather than a Node
 * driver, which keeps `packages/server` free of a database dependency at W1 and
 * keeps the lifecycle honest: we ask Postgres's own tooling the questions
 * Postgres's own tooling is authoritative for.
 *
 * `run()` never throws on a non-zero exit — the lifecycle decides what a
 * non-zero exit means and raises the right typed `SidecarError`.
 */

import { spawn } from 'node:child_process';

export interface RunOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
  /** Hard kill (SIGKILL after SIGTERM) once exceeded. Default 60_000. */
  readonly timeoutMs?: number;
  /** Written to stdin then closed. */
  readonly input?: string;
  /** Cap on retained stdout/stderr, so a runaway child cannot eat memory. */
  readonly maxBuffer?: number;
}

export interface RunResult {
  readonly file: string;
  readonly args: readonly string[];
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly ok: boolean;
  readonly durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BUFFER = 1024 * 1024; // 1 MiB of captured output is plenty

/**
 * Locale guard for Postgres tooling.
 *
 * `initdb` fails outright when the inherited locale is one it cannot resolve
 * (observed on this machine: an empty/`C.UTF-8`-less environment aborts with a
 * locale error). Forcing a UTF-8 locale for every PG child makes cluster
 * creation deterministic regardless of how the operator's shell is configured.
 */
export function pgChildEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LANG: process.env['LANG'] ?? 'en_US.UTF-8',
    LC_ALL: process.env['LC_ALL'] ?? 'en_US.UTF-8',
    ...extra,
  };
}

export function run(
  file: string,
  args: readonly string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const startedAt = Date.now();

  return new Promise<RunResult>((resolve) => {
    const child = spawn(file, [...args], {
      env: opts.env ?? pgChildEnv(),
      ...(opts.cwd === undefined ? {} : { cwd: opts.cwd }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const append = (buf: string, chunk: Buffer) =>
      buf.length >= maxBuffer ? buf : (buf + chunk.toString('utf8')).slice(0, maxBuffer);

    child.stdout?.on('data', (c: Buffer) => {
      stdout = append(stdout, c);
    });
    child.stderr?.on('data', (c: Buffer) => {
      stderr = append(stderr, c);
    });

    const killTimer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    }, timeoutMs);
    killTimer.unref();

    const settle = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      resolve({
        file,
        args,
        code,
        signal,
        stdout,
        stderr,
        timedOut,
        ok: code === 0 && !timedOut,
        durationMs: Date.now() - startedAt,
      });
    };

    child.on('error', (err) => {
      stderr = append(stderr, Buffer.from(`spawn ${file}: ${err.message}\n`));
      settle(null, null);
    });
    child.on('close', settle);

    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}

/** Last N lines of captured output — what a typed error carries as `detail`. */
export function tail(text: string, lines = 20): string {
  const parts = text.trimEnd().split('\n');
  return parts.slice(Math.max(0, parts.length - lines)).join('\n');
}

/** One-line summary of a failed run, suitable for `SidecarError.detail`. */
export function describeFailure(r: RunResult): string {
  const how = r.timedOut
    ? 'timed out'
    : r.signal !== null
      ? `killed by ${r.signal}`
      : `exited ${r.code}`;
  const out = tail(r.stderr || r.stdout);
  return `${r.file} ${r.args.join(' ')} ${how}${out ? `\n${out}` : ''}`;
}
