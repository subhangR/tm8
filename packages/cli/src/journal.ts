/**
 * The session command journal — what this invocation did, appended to a file
 * the session owns, on the way out.
 *
 * WHY THERE IS NO DAEMON AND NO DATABASE. Every `tm8` command is its own
 * short-lived process, and that process already knows which session it belongs
 * to: `TM8_SESSION_ID` and `TM8_JOURNAL_PATH` are injected into the spawned
 * agent's environment at `packages/execution/src/spawn/manifest.ts`. So the
 * whole mechanism is "append one line, then exit". Concurrency between sibling
 * invocations is the OS's problem, solved by `O_APPEND`.
 *
 * THE ONE RULE THIS FILE MUST NEVER BREAK: journaling is an observer. It may
 * not change the exit code, may not throw, may not write to stdout, and may not
 * alter a single byte the caller sees. Output law (`output.ts:1-13`) is that
 * stdout carries data and nothing else — `worker init` pipes stdout straight
 * into an agent's context, so one stray character here corrupts a system
 * prompt. Every entry point below is therefore wrapped in a swallow, and the
 * tee in `wrapStreams` forwards BEFORE it counts.
 *
 * THE ONE SANCTIONED EXCEPTION (F8, "visible spend"): after the record is
 * durably appended, an AGENT-class invocation prints a single spend line to
 * STDERR — `[journal: ~Nk est chars-over-4 this session; M% on re-fetches]` —
 * so the agent sees its cost while it can still be changed. Stderr only,
 * never stdout; printed only after the append succeeded; swallowed on any
 * failure; and never for `harness` records, whose fixtures must stay
 * byte-deterministic.
 *
 * THE GATE: no `TM8_JOURNAL_PATH` means no journal, and `createJournal` hands
 * back an inert sink. A human running `tm8` at their own terminal creates
 * nothing, writes nothing, and pays nothing.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SessionJournalCall, SessionJournalRecord } from '@tm8/contract';
import { formatSpend, parseJournalText, resolveJournalClass, sessionSpend } from './journal-stats.js';
import type { OutputStreams } from './output.js';

/**
 * How much of stdout/stderr is kept verbatim. The COUNTS are always exact;
 * this only bounds the sample.
 *
 * It is a cap rather than "keep everything" for two reasons. A `tm8 graph`
 * dump is megabytes, and a journal that grew with it would be useless and
 * expensive. More importantly, records are appended concurrently by sibling
 * processes and rely on a single `write()` being atomic — a bounded record is
 * what makes that true.
 */
const SAMPLE_CHARS = 2_000;

/** Chars per token. Named in every record so the estimate cannot be mistaken
 *  for a measurement. See `estimateTokens`. */
const CHARS_PER_TOKEN = 4;

/**
 * Option names whose VALUE is redacted out of the recorded argv.
 *
 * Conservative and matched loosely on purpose: a secret that leaks into a
 * durable file is unrecoverable, whereas a needlessly redacted value costs a
 * debugging session nothing. The redaction happens at WRITE time, so the secret
 * never reaches the disk and no reader has to be trusted to hide it.
 */
const SECRET_OPTION_RE = /(token|secret|password|passwd|credential|api[-_]?key|bearer|authorization)/i;
const REDACTED = '<redacted>';

export interface JournalCallInput {
  operation: string;
  method: string;
  path: string;
  baseUrl: string;
  status: number | null;
  requestChars: number;
  responseChars: number;
  durationMs: number;
}

export interface Journal {
  /** True only when a real file will be written. */
  readonly enabled: boolean;
  /** Wrap the process streams so stdout/stderr are counted as they pass. */
  wrapStreams(base: OutputStreams): OutputStreams;
  /** Count bytes the caller piped in on stdin. */
  noteStdin(chars: number): void;
  /** One HTTP call, recorded by the client's single `send()` chokepoint. */
  noteCall(call: JournalCallInput): void;
  /** Append the record. Safe to call more than once; only the first writes. */
  finish(outcome: { path: readonly string[]; argv: readonly string[]; exitCode: number; error?: unknown }): void;
}

/** The no-op. Every method is a nothing, so callers never branch on `enabled`. */
const INERT: Journal = {
  enabled: false,
  wrapStreams: (base) => base,
  noteStdin: () => {},
  noteCall: () => {},
  finish: () => {},
};

export function createJournal(env: NodeJS.ProcessEnv = process.env): Journal {
  const path = env.TM8_JOURNAL_PATH;
  const sessionId = env.TM8_SESSION_ID;
  // Both are required. A journal path without a session id could not name its
  // own records, and a session id without a path has nowhere to go.
  if (!path || !sessionId) return INERT;
  return new FileJournal(path, sessionId, env);
}

class FileJournal implements Journal {
  readonly enabled = true;
  private readonly startedAt = new Date().toISOString();
  private readonly startedMs = Date.now();
  private stdoutChars = 0;
  private stderrChars = 0;
  private stdoutSample = '';
  private stderrSample = '';
  private stdinChars = 0;
  private readonly calls: SessionJournalCall[] = [];
  private written = false;

  constructor(
    private readonly path: string,
    private readonly sessionId: string,
    private readonly env: NodeJS.ProcessEnv,
  ) {}

  wrapStreams(base: OutputStreams): OutputStreams {
    return {
      stdout: (chunk) => {
        // FORWARD FIRST. If counting ever throws, the caller has already had
        // their bytes and the observer's failure cannot swallow output.
        base.stdout(chunk);
        try {
          const text = typeof chunk === 'string' ? chunk : decode(chunk);
          this.stdoutChars += text.length;
          if (this.stdoutSample.length < SAMPLE_CHARS) {
            this.stdoutSample = (this.stdoutSample + text).slice(0, SAMPLE_CHARS);
          }
        } catch {
          /* observation must never break the command */
        }
      },
      stderr: (chunk) => {
        base.stderr(chunk);
        try {
          this.stderrChars += chunk.length;
          if (this.stderrSample.length < SAMPLE_CHARS) {
            this.stderrSample = (this.stderrSample + chunk).slice(0, SAMPLE_CHARS);
          }
        } catch {
          /* as above */
        }
      },
    };
  }

  noteStdin(chars: number): void {
    this.stdinChars += chars;
  }

  noteCall(call: JournalCallInput): void {
    this.calls.push({ ...call });
  }

  finish(outcome: {
    path: readonly string[];
    argv: readonly string[];
    exitCode: number;
    error?: unknown;
  }): void {
    if (this.written) return;
    this.written = true;
    try {
      const argv = redactArgv(outcome.argv);
      // Direction, stated once so it cannot drift: what the agent TYPED is what
      // it emitted (its output tokens); what the CLI PRINTED is what lands in
      // its context next turn (its input tokens).
      const agentChars = argv.join(' ').length + this.stdinChars;
      const cliChars = this.stdoutChars + this.stderrChars;

      // Decided at WRITE time, when the calls (and their target ports) are
      // known — the split that keeps the corpus readable. See journal-stats.ts.
      const journalClass = resolveJournalClass(this.env, this.calls, safeCwd());

      const record: SessionJournalRecord = {
        v: 1,
        seq: 0,
        class: journalClass,
        sessionId: this.sessionId,
        spaceId: this.env.TM8_SPACE_ID ?? null,
        teamMemberId: this.env.TM8_TEAM_MEMBER_ID ?? null,
        pid: process.pid,
        startedAt: this.startedAt,
        durationMs: Date.now() - this.startedMs,
        command: { path: [...outcome.path], argv, cwd: safeCwd() },
        input: { stdinChars: this.stdinChars },
        output: {
          stdoutChars: this.stdoutChars,
          stderrChars: this.stderrChars,
          stdoutSample: this.stdoutSample,
          stderrSample: this.stderrSample,
          truncated: this.stdoutChars > this.stdoutSample.length || this.stderrChars > this.stderrSample.length,
        },
        calls: this.calls,
        result: { exitCode: outcome.exitCode, error: describeError(outcome.error) },
        tokens: {
          estimator: 'chars/4',
          agentToCli: estimateTokens(agentChars),
          cliToAgent: estimateTokens(cliChars),
        },
      };

      // ONE `write()`, append mode. Node opens with O_APPEND, so sibling
      // invocations interleave whole lines rather than corrupting each other,
      // and no lock file is needed. This is why records are bounded.
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(record)}\n`, 'utf8');
      if (journalClass === 'agent') this.emitSpendLine();
    } catch {
      // A full disk, a read-only path, a serialisation failure: none of them
      // are the caller's problem and none of them may alter the exit code.
    }
  }

  /**
   * The F8 spend line — the only bytes journaling ever adds to what a caller
   * sees, and stderr-only. Totals are read back from the file just appended
   * to, so the number is THIS SESSION's running spend across sibling
   * invocations, not this process's. Direct to `process.stderr`, deliberately
   * bypassing the wrapped streams: the line must not count itself into the
   * record it reports on.
   */
  private emitSpendLine(): void {
    try {
      const { records } = parseJournalText(readFileSync(this.path, 'utf8'));
      const mine = records.filter((r) => r.sessionId === this.sessionId);
      const { estTokens, refetchPct } = sessionSpend(mine);
      process.stderr.write(
        `[journal: ${formatSpend(estTokens)} est chars-over-4 this session; ${refetchPct}% on re-fetches]\n`,
      );
    } catch {
      // The spend line is advice. Failing to print it must cost nothing.
    }
  }
}

/** Exact counts in, estimate out. Rounded up so a non-empty payload is never 0. */
function estimateTokens(chars: number): number {
  return chars === 0 ? 0 : Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Redact secret-looking option VALUES, in both spellings the parser accepts:
 * `--token abc` (value in the next slot) and `--token=abc` (value inline).
 */
function redactArgv(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq > 2 && SECRET_OPTION_RE.test(arg.slice(2, eq))) {
      out.push(`${arg.slice(0, eq)}=${REDACTED}`);
      continue;
    }
    out.push(arg);
    if (arg.startsWith('--') && eq === -1 && SECRET_OPTION_RE.test(arg.slice(2))) {
      const value = argv[i + 1];
      // Only a genuine value is swallowed; the next flag must survive intact.
      if (value !== undefined && !value.startsWith('--')) {
        out.push(REDACTED);
        i += 1;
      }
    }
  }
  return out;
}

function describeError(err: unknown): string | null {
  if (err === undefined || err === null) return null;
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

function safeCwd(): string {
  try {
    return process.cwd();
  } catch {
    // cwd can genuinely fail if the directory was removed under a long-lived
    // session. Not worth failing a record over.
    return '';
  }
}

function decode(chunk: Uint8Array): string {
  return Buffer.from(chunk).toString('utf8');
}

/**
 * The process-wide journal for THIS invocation.
 *
 * A module singleton rather than a threaded parameter because the alternative
 * is passing a recorder through every command signature and into the client
 * purely so one observer can see it. The lifetime is exactly right: one CLI
 * process is one invocation is one record.
 */
export const journal: Journal = createJournal();
