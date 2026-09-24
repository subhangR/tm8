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
import { projectTerse, type RenderMode } from './terse.js';
import {
  deprecationNotice,
  renderReceiptHuman,
  type Receipt,
  type ReceiptMode,
  type ReceiptOp,
} from './receipt.js';

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
  /**
   * `--terse` (F5, opt-in): project entity summaries to their work fields
   * before `json`/`jsonl` serialization. Human renders are untouched — see
   * `terse.ts` for the shape and the two load-bearing rules.
   */
  render?: RenderMode;
  /**
   * How the ten receipt commands print (`receipt.ts`). Absent means `full`:
   * today's result, no notice — so an Output built without a mode (unit
   * tests, embedded callers) behaves exactly as before receipts existed.
   */
  receipts?: ReceiptMode;
  streams?: OutputStreams;
}

/** Renders one DTO as a human line/block. Receives the DTO, not a copy of it. */
export type HumanRenderer<T> = (dto: T) => string;

export class Output {
  readonly format: OutputFormat;
  readonly color: boolean;
  readonly quiet: boolean;
  readonly render: RenderMode;
  readonly receipts: ReceiptMode;
  private readonly streams: OutputStreams;
  private wroteBytes = false;
  private wroteStructured = false;

  constructor(opts: OutputOptions) {
    this.format = opts.format;
    this.color = opts.color ?? false;
    this.quiet = opts.quiet ?? false;
    this.render = opts.render ?? 'full';
    this.receipts = opts.receipts ?? 'full';
    this.streams = opts.streams ?? processStreams;
  }

  /**
   * The command's result. Exactly one of these per command in `human`/`json`;
   * `jsonl` callers use `line()` instead.
   */
  data<T>(dto: T, human: HumanRenderer<T>, opts: { minify?: boolean; raw?: boolean } = {}): void {
    this.assertNoBytes();
    this.wroteStructured = true;
    if (this.format === 'human') {
      this.streams.stdout(`${human(dto)}\n`);
      return;
    }
    // `raw`: the DTO as the server sent it, never projected — for a shape
    // whose bytes are themselves the contract (entity context v2).
    const payload = this.render === 'terse' && !opts.raw ? projectTerse(dto) : dto;
    if (this.format === 'json') {
      // `minify`: the same JSON without indentation — for an agent-class
      // reader, where whitespace is paid for and read by nobody.
      this.streams.stdout(`${opts.minify ? JSON.stringify(payload) : JSON.stringify(payload, null, 2)}\n`);
      return;
    }
    this.streams.stdout(`${JSON.stringify(payload)}\n`);
  }

  /**
   * The result of one of the ten receipt commands (spec 01a0cf2e §8).
   *
   * In `receipt` mode the receipt is the whole of stdout: ONE MINIFIED LINE
   * under both json and jsonl (D1.5) — `--terse` is a no-op here, because a
   * receipt has no summaries left to project — or one human line (§4.4).
   * The receipt is built lazily, so the other modes never pay for it.
   *
   * Otherwise the full result goes through `data()` exactly as it did before
   * receipts, so `--full` is byte-identical to today's `--format json --full`;
   * `deprecated` adds the one stderr line naming `--full` under json/jsonl.
   */
  mutation<T>(op: ReceiptOp, dto: T, human: HumanRenderer<T>, receipt: () => Receipt): void {
    if (this.receipts !== 'receipt') {
      this.data(dto, human);
      if (this.receipts === 'deprecated' && this.format !== 'human') {
        this.streams.stderr(`${deprecationNotice(op)}\n`);
      }
      return;
    }
    this.assertNoBytes();
    this.wroteStructured = true;
    const built = receipt();
    this.streams.stdout(
      this.format === 'human' ? `${renderReceiptHuman(built)}\n` : `${JSON.stringify(built)}\n`,
    );
  }

  /**
   * Whether a failed receipt command prints an error receipt (spec 01a0cf2e
   * §4.3, D4.1): receipt mode under json/jsonl only. Human format stays
   * stderr-only, and every other mode keeps today's empty stdout.
   */
  get errorReceipts(): boolean {
    return this.receipts === 'receipt' && this.format !== 'human';
  }

  /**
   * An error receipt: ONE MINIFIED LINE on stdout, alongside — never instead
   * of — the stderr diagnostic and the exit code, which the run funnel still
   * writes. Printed only when nothing else reached stdout first: a command
   * that already printed its result has no error receipt to add.
   */
  errorReceipt(receipt: Record<string, unknown>): void {
    if (!this.errorReceipts || this.wroteBytes || this.wroteStructured) return;
    this.wroteStructured = true;
    this.streams.stdout(`${JSON.stringify(receipt)}\n`);
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
      this.format === 'human'
        ? `${human(dto)}\n`
        : `${JSON.stringify(this.render === 'terse' ? projectTerse(dto) : dto)}\n`,
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
