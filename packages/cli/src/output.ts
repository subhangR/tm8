/**
 * Output law (§7.1, §7.3).
 *
 *  - stdout carries the requested DATA and nothing else. `worker init` pipes
 *    its stdout straight into an agent's context, and a stray "connecting…"
 *    there is a line of garbage inside a system prompt.
 *  - stderr carries every diagnostic, warning, retry hint, and request id.
 *  - human views render from the SAME DTO as `--format json`. The renderer is
 *    a function of the DTO, so there is no second shape to drift.
 *  - `--format json` emits the exact contract DTO, never a CLI-private
 *    envelope. There is NO `--json` flag: the prototype's boolean is retired.
 *  - raw bytes and structured output are mutually exclusive.
 */
export const OUTPUT_FORMATS = ['human', 'json', 'jsonl'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

import { CliError, EXIT_USAGE } from './exit.js';

export interface OutputStreams {
  stdout(chunk: string | Uint8Array): void;
  stderr(chunk: string): void;
}

/** The real process streams. Exported so an observer (the session journal) can
 *  wrap them without this module having to know one exists. */
export const processStreams: OutputStreams = {
  stdout: (chunk) => void process.stdout.write(chunk),
  stderr: (chunk) => void process.stderr.write(chunk),
};

export interface OutputOptions {
  format: OutputFormat;
  /** `--no-color` clears it; so does a non-TTY stdout. */
  color?: boolean;
  /** `--quiet` silences NOTES. Warnings and errors are never silenced. */
  quiet?: boolean;
  streams?: OutputStreams;
}

/** Renders one DTO as a human line/block. Receives the DTO, not a copy of it. */
export type HumanRenderer<T> = (dto: T) => string;

export class Output {
  readonly format: OutputFormat;
  readonly color: boolean;
  readonly quiet: boolean;
  private readonly streams: OutputStreams;
  private wroteBytes = false;
  private wroteStructured = false;

  constructor(opts: OutputOptions) {
    this.format = opts.format;
    this.color = opts.color ?? false;
    this.quiet = opts.quiet ?? false;
    this.streams = opts.streams ?? processStreams;
  }

  /**
   * The command's result. Exactly one of these per command in `human`/`json`;
   * `jsonl` callers use `line()` instead.
   */
  data<T>(dto: T, human: HumanRenderer<T>): void {
    this.assertNoBytes();
    this.wroteStructured = true;
    if (this.format === 'human') {
      this.streams.stdout(`${human(dto)}\n`);
      return;
    }
    if (this.format === 'json') {
      this.streams.stdout(`${JSON.stringify(dto, null, 2)}\n`);
      return;
    }
    this.streams.stdout(`${JSON.stringify(dto)}\n`);
  }

  /**
   * One item of a long-lived or explicitly paged stream: one event per line
   * under `jsonl`, one rendered line under `human`. Under `json` this is a
   * usage error rather than a silently concatenated stream of objects —
   * §7.2 says a paged mode must preserve contract pages, not fabricate an
   * aggregate DTO.
   */
  line<T>(dto: T, human: HumanRenderer<T>): void {
    this.assertNoBytes();
    if (this.format === 'json') {
      throw new CliError(
        'this command emits a stream; use --format jsonl (or human)',
        EXIT_USAGE,
      );
    }
    this.wroteStructured = true;
    this.streams.stdout(
      this.format === 'human' ? `${human(dto)}\n` : `${JSON.stringify(dto)}\n`,
    );
  }

  /**
   * Raw bytes (`file download --output -`). Mutually exclusive with structured
   * output: a JSON parser reading stdout must never find a PNG spliced into it.
   */
  bytes(chunk: Uint8Array): void {
    if (this.format !== 'human') {
      throw new CliError(
        `raw bytes cannot be written under --format ${this.format}; ` +
          'raw bytes and structured output are mutually exclusive',
        EXIT_USAGE,
      );
    }
    if (this.wroteStructured) {
      throw new CliError('raw bytes cannot follow structured output on stdout', EXIT_USAGE);
    }
    this.wroteBytes = true;
    this.streams.stdout(chunk);
  }

  /** Progress//context commentary. stderr. Silenced by `--quiet`. */
  note(message: string): void {
    if (this.quiet) return;
    this.streams.stderr(`${message}\n`);
  }

  /** Something the caller must know. stderr. NEVER silenced. */
  warn(message: string): void {
    this.streams.stderr(`${message}\n`);
  }

  /** The failure diagnostic. stderr. NEVER silenced. */
  error(lines: readonly string[]): void {
    for (const line of lines) this.streams.stderr(`${line}\n`);
  }

  private assertNoBytes(): void {
    if (this.wroteBytes) {
      throw new CliError('structured output cannot follow raw bytes on stdout', EXIT_USAGE);
    }
  }
}

export function createOutput(opts: OutputOptions): Output {
  return new Output(opts);
}

/**
 * A diagnostic before an `Output` exists (argv failed to parse at all).
 * stderr, unconditionally.
 */
export function note(message: string): void {
  process.stderr.write(`${message}\n`);
}
