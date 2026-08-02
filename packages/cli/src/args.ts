/**
 * Argument parsing for the frozen noun-first grammar (§3 EBNF):
 *
 *   invocation      = "tm8", { global-option }, command, { global-option | command-option } ;
 *   command         = root-command | domain-command ;
 *   root-command    = "help", [ noun, [ verb ] ] | "completion", ( "bash" | "zsh" | "fish" ) ;
 *   domain-command  = noun, { subnoun }, verb, { argument } ;
 *   source          = inline-value | "@", path | "-" ;
 *
 * Hand-rolled, no dependency. packages/cli is deliberately dependency-light:
 * installing anything in this repo re-links node-pty and strips its
 * spawn-helper exec bit, which breaks the PTY harness for every other lane.
 *
 * THE ALLOWLIST DEFENSE (carried over from the prototype, widened to §4).
 * Booleans are an explicit allowlist, never "a flag whose next token looks
 * like a flag". Without it `tm8 --quiet entity get ent_1` silently eats
 * `entity` as the value of `--quiet` and the noun vanishes — the command then
 * either 404s or, worse, resolves to a DIFFERENT command. The prototype hit
 * exactly this with `--json`. Two rules follow from it:
 *
 *   1. an option NOT on the allowlist always takes the next token as its value;
 *   2. if that next token is missing or is itself `--…`, that is a usage error
 *      (exit 2) rather than a silent `true`. A value that genuinely starts
 *      with `--` must be written `--body=--weird` or passed after a literal `--`.
 *
 * Bare `-` is a VALUE (stdin), not an option, and single-dash short options do
 * not exist in this grammar at all.
 */
import { readFileSync } from 'node:fs';
import { CliError, EXIT_USAGE } from './exit.js';
import { journal } from './journal.js';
import { OUTPUT_FORMATS, type OutputFormat } from './output.js';

/** Global options. They bind target, context, and output, never payload. */
export const GLOBAL_OPTIONS = ['server', 'space', 'as', 'format', 'timeout', 'no-color', 'quiet', 'fresh', 'terse', 'full'] as const;

/**
 * Every boolean in the frozen grammar. A flag NOT listed here consumes a value.
 * Sourced flag-by-flag from §4 + §7.5; adding a command means adding its
 * booleans here, and forgetting to is a parse bug, not a missing feature.
 */
export const BOOLEAN_OPTIONS: ReadonlySet<string> = new Set([
  // global + root discovery
  'no-color', 'quiet', 'fresh', 'terse', 'full', 'help', 'version',
  // §7.5 destructive confirmation
  'yes',
  // §4 per-command booleans
  'off',                 // entity react --off
  'ready',               // entity query --ready
  'unread',              // inbox list --unread
  'until-match',         // event watch --until-match
  'overwrite',           // file download --overwrite
  'force',               // session terminate --force
  'grant-only',          // session attach --grant-only
  'presence',            // event watch --presence
  'confirm-untrusted',   // session spawn --confirm-untrusted
  'allow-tightening',    // kind update --allow-tightening
  'confirm-agent-generated', // teammate interaction-profile set-default
  'no-session-link',     // entity create — suppress the automatic created_in edge
  'node-admin',          // auth signup --node-admin
]);

/**
 * THE COLLISION RULE, in one sentence:
 *
 *   a name that is BOTH a global and a per-command flag is the GLOBAL only
 *   while it appears before the first command token, and belongs to the
 *   command from that token onward.
 *
 * WHY THIS EXISTS. `version` was on the boolean allowlist, so `--version` was
 * stripped into `globals.version` in EVERY position — and `run()` checks
 * `globals.version` first. The published A16 invocation
 * `tm8 interaction-profile preview <id> --version <n>` therefore printed the
 * CLI version and exited 0 without previewing anything. The `=` spelling was
 * eaten too: the `=` branch recorded the value and `takeBool('version')` then
 * deleted the key regardless. It did not refuse and it did not crash — it
 * answered a different question with a success code, which is the one failure
 * nothing downstream can detect.
 *
 * WHY POSITION IS THE DISCRIMINATOR. It is the only signal available here that
 * does not drag the command registry into the parser: `splitCommandPath` takes
 * `isCommandPath` as a PARAMETER precisely so argv splitting stays decidable
 * from argv alone, and §3's own EBNF already reads `{ global-option }, command,
 * { global-option | command-option }` — globals lead, command options follow.
 *
 * AND WHEN POSITION DOES NOT DECIDE, WE REFUSE. `tm8 --version kind list` reads
 * both ways, so it exits 2 naming the collision rather than silently picking
 * one. An honest refusal beats a confident guess; picking silently is the exact
 * defect above, mirrored.
 *
 * NOTE: for a name listed here, membership in `BOOLEAN_OPTIONS` is not
 * consulted — this rule runs first and decides both arity and destination.
 * `version` stays listed there because the discovery slot's projection sweep
 * reads that set to report published-vs-parseable flag arity.
 */
export const COMMAND_SCOPED_GLOBALS: ReadonlySet<string> = new Set(['version']);

/**
 * Retired options. `--json` is not merely unknown: an agent that learned the
 * prototype would write it, and an unknown option consumes the next token —
 * so `--json entity get` would swallow the NOUN and fail somewhere unrelated.
 * It fails here instead, naming its replacement.
 */
export const RETIRED_OPTIONS: ReadonlyMap<string, string> = new Map([
  ['json', 'use `--format json`'],
]);

export type OptionValue = string | true;

/** Parsed options. Every option is stored repeatable; scalars assert arity. */
export class OptionBag {
  constructor(private readonly bag: ReadonlyMap<string, readonly OptionValue[]>) {}

  has(name: string): boolean {
    return this.bag.has(name);
  }

  /** All occurrences, in order — for the repeatable flags (`--to`, `--by`, …). */
  values(name: string): string[] {
    return (this.bag.get(name) ?? []).filter((v): v is string => typeof v === 'string');
  }

  /**
   * A single-valued option. Repeating a scalar option is a usage error rather
   * than last-wins: `--space a --space b` is a caller who believes something
   * false about which Space they are writing to.
   */
  value(name: string): string | undefined {
    const raw = this.bag.get(name);
    if (raw === undefined) return undefined;
    if (raw.length > 1) {
      throw new CliError(`--${name} may be given only once (got ${raw.length})`, EXIT_USAGE);
    }
    const only = raw[0];
    if (only === true) throw new CliError(`--${name} requires a value`, EXIT_USAGE);
    return only;
  }

  require(name: string): string {
    const v = this.value(name);
    if (v === undefined) throw new CliError(`--${name} is required`, EXIT_USAGE);
    return v;
  }

  bool(name: string): boolean {
    return this.bag.has(name);
  }

  /** Positive integer options: `--limit`, `--depth`, `--expect-version`, … */
  integer(name: string): number | undefined {
    const raw = this.value(name);
    if (raw === undefined) return undefined;
    if (!/^-?\d+$/.test(raw)) {
      throw new CliError(`--${name} expects an integer, got ${JSON.stringify(raw)}`, EXIT_USAGE);
    }
    return Number(raw);
  }

  names(): string[] {
    return [...this.bag.keys()];
  }
}

/** §3 global context/presentation options, already validated. */
export interface GlobalOptions {
  server: string | undefined;
  space: string | undefined;
  as: string | undefined;
  format: OutputFormat;
  /** `--timeout <seconds>`, normalized to ms. Undefined means the client default. */
  timeoutMs: number | undefined;
  color: boolean;
  quiet: boolean;
  /** `--fresh`: bypass the session read-cache lookup for this invocation. */
  fresh: boolean;
  /**
   * `--terse` / `--full` (F5, opt-in): project entity summaries to their work
   * fields under json/jsonl. `--full` DEFEATS `--terse` — its whole purpose is
   * to restore the complete envelope in one flag, whatever injected the terse
   * request — so when both are present, full wins.
   */
  render: 'full' | 'terse';
  help: boolean;
  version: boolean;
}

export interface ParsedInvocation {
  /** Command path + arguments, in order. Globals are already removed. */
  positionals: string[];
  /** Command options only — globals never appear here. */
  options: OptionBag;
  /** Everything after a literal `--`, unparsed. */
  passthrough: string[];
  globals: GlobalOptions;
}

export function parseFormat(raw: string): OutputFormat {
  const found = OUTPUT_FORMATS.find((f) => f === raw);
  if (!found) {
    throw new CliError(
      `--format expects ${OUTPUT_FORMATS.join('|')}, got ${JSON.stringify(raw)}`,
      EXIT_USAGE,
    );
  }
  return found;
}

/**
 * `--timeout <seconds>`. Seconds because every other CLI a scripting agent
 * already knows (`curl --max-time`, `ssh -o ConnectTimeout`) is in seconds;
 * fractional values are allowed so a conformance run can ask for 0.5.
 */
function parseTimeoutSeconds(raw: string): number {
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new CliError(
      `--timeout expects a positive number of seconds, got ${JSON.stringify(raw)}`,
      EXIT_USAGE,
    );
  }
  return Math.round(seconds * 1000);
}

/**
 * Split argv into positionals, options, and post-`--` passthrough.
 *
 * Globals may appear before or after the command path but NEVER after a
 * literal `--` (§3) — everything past it is opaque and belongs to whatever
 * the command hands it to.
 */
export function parseInvocation(argv: readonly string[]): ParsedInvocation {
  const positionals: string[] = [];
  const bag = new Map<string, OptionValue[]>();
  let passthrough: string[] = [];
  /**
   * Colliding names resolved to the GLOBAL. Kept OUT of `bag` entirely, so a
   * command's own `--version` can never be confused with the global one even
   * when both spellings appear in the same argv.
   */
  const globalFlags = new Set<string>();
  /** Has a command-path token been seen? See COMMAND_SCOPED_GLOBALS. */
  let sawCommandToken = false;

  const record = (name: string, value: OptionValue): void => {
    const existing = bag.get(name);
    if (existing) existing.push(value);
    else bag.set(name, [value]);
  };

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === undefined) continue;

    if (tok === '--') {
      passthrough = argv.slice(i + 1);
      break;
    }
    // Bare `-` is the stdin source token, not an option.
    if (tok === '-') {
      positionals.push(tok);
      continue;
    }
    if (!tok.startsWith('-')) {
      positionals.push(tok);
      // Only a bare word can begin a command path, so bare `-` (stdin, handled
      // above) deliberately does not flip this.
      sawCommandToken = true;
      continue;
    }
    if (!tok.startsWith('--')) {
      throw new CliError(
        `unknown option ${tok}: the tm8 grammar has no short options`,
        EXIT_USAGE,
        { hint: 'run `tm8 help` for the current grammar' },
      );
    }

    const body = tok.slice(2);
    const eq = body.indexOf('=');
    if (eq === 0 || body.length === 0) {
      throw new CliError(`malformed option ${tok}`, EXIT_USAGE);
    }
    const name = eq === -1 ? body : body.slice(0, eq);
    const retired = RETIRED_OPTIONS.get(name);
    if (retired !== undefined) {
      throw new CliError(`--${name} no longer exists`, EXIT_USAGE, { hint: retired });
    }
    // THE COLLISION RULE. Before the first command token this name is the
    // global; from that token onward it falls through and is parsed as the
    // command's own option, value and all.
    if (COMMAND_SCOPED_GLOBALS.has(name) && !sawCommandToken) {
      if (eq !== -1) {
        throw new CliError(`the global --${name} takes no value`, EXIT_USAGE, {
          hint:
            `\`tm8 --${name}\` alone reports the CLI ${name}; a command that takes its own ` +
            `--${name} expects it AFTER the command path`,
        });
      }
      globalFlags.add(name);
      continue;
    }
    if (eq !== -1) {
      record(name, body.slice(eq + 1));
      continue;
    }
    if (BOOLEAN_OPTIONS.has(body) && !COMMAND_SCOPED_GLOBALS.has(body)) {
      record(body, true);
      continue;
    }
    const next = argv[i + 1];
    if (next === undefined || (next.startsWith('--') && next !== '--')) {
      throw new CliError(
        `--${body} requires a value` +
          (next === undefined ? '' : ` (got the option ${next}; write --${body}=${next} if that IS the value)`),
        EXIT_USAGE,
      );
    }
    if (next === '--') {
      throw new CliError(`--${body} requires a value`, EXIT_USAGE);
    }
    record(body, next);
    i++;
  }

  const takeScalar = (name: string): string | undefined => {
    const raw = bag.get(name);
    if (raw === undefined) return undefined;
    bag.delete(name);
    if (raw.length > 1) {
      throw new CliError(`--${name} may be given only once (got ${raw.length})`, EXIT_USAGE);
    }
    const only = raw[0];
    if (only === true || only === undefined) {
      throw new CliError(`--${name} requires a value`, EXIT_USAGE);
    }
    return only;
  };
  const takeBool = (name: string): boolean => {
    const present = bag.has(name);
    bag.delete(name);
    return present;
  };

  const server = takeScalar('server');
  const space = takeScalar('space');
  const as = takeScalar('as');
  const rawFormat = takeScalar('format');
  const rawTimeout = takeScalar('timeout');
  const noColor = takeBool('no-color');
  const quiet = takeBool('quiet');
  const fresh = takeBool('fresh');
  const terse = takeBool('terse');
  const full = takeBool('full');
  const help = takeBool('help');
  // NOT takeBool: a colliding name never entered `bag` as a global, and any
  // occurrence still IN `bag` is the command's own and must stay there.
  const version = globalFlags.has('version');

  // Position decided the reading, but here position did not: the global was
  // claimed AND a command follows it. Refuse and name the collision rather than
  // silently discarding one of the two readings.
  if (version && positionals.length > 0) {
    throw new CliError(
      `--version is ambiguous before a command: it is the global CLI-version flag on its own, ` +
        `but \`${positionals.slice(0, 3).join(' ')}\` follows it`,
      EXIT_USAGE,
      {
        hint:
          '`tm8 --version` alone reports the CLI version; a command that takes its own --version ' +
          'expects it after the command path, as in `tm8 interaction-profile preview <id> --version <n>`',
      },
    );
  }

  const globals: GlobalOptions = {
    server,
    space,
    as,
    format: rawFormat === undefined ? 'human' : parseFormat(rawFormat),
    timeoutMs: rawTimeout === undefined ? undefined : parseTimeoutSeconds(rawTimeout),
    color: !noColor,
    quiet,
    fresh,
    render: full ? 'full' : terse ? 'terse' : 'full',
    help,
    version,
  };

  return { positionals, options: new OptionBag(bag), passthrough, globals };
}

/**
 * The deepest command path in the frozen grammar is three tokens
 * (`space task-axis create`, `message attachment add`, `file upload resume`,
 * `teammate interaction-profile set-default`). The EBNF admits `{ subnoun }`
 * but §4 closes it at one, and an open depth would let a typo'd argument be
 * swallowed into the path.
 */
export const MAX_COMMAND_PATH_DEPTH = 3;

export interface CommandPathMatch {
  /** noun [subnoun] verb */
  path: string[];
  /** Ordered arguments after the path. */
  args: string[];
}

/**
 * Longest-match the command path against the closed registry.
 *
 * Longest first, because `space invite list` and a hypothetical `space invite`
 * must not race: the registry is closed, so the longest registered prefix is
 * the intended command and everything after it is an argument.
 */
export function splitCommandPath(
  positionals: readonly string[],
  isCommandPath: (path: readonly string[]) => boolean,
): CommandPathMatch | undefined {
  const depth = Math.min(MAX_COMMAND_PATH_DEPTH, positionals.length);
  for (let n = depth; n >= 1; n--) {
    const path = positionals.slice(0, n);
    if (isCommandPath(path)) return { path, args: positionals.slice(n) };
  }
  return undefined;
}

/** §3 `source = inline-value | "@", path | "-"`. */
export type SourceSpec =
  | { kind: 'inline'; value: string }
  | { kind: 'file'; path: string }
  | { kind: 'stdin' };

export function parseSource(raw: string): SourceSpec {
  if (raw === '-') return { kind: 'stdin' };
  if (raw.startsWith('@')) {
    const path = raw.slice(1);
    if (!path) throw new CliError('@ requires a path', EXIT_USAGE);
    return { kind: 'file', path };
  }
  return { kind: 'inline', value: raw };
}

export interface SourceIo {
  readFile(path: string): string;
  readStdin(): Promise<string>;
}

let stdinConsumed = false;

const defaultIo: SourceIo = {
  readFile(path) {
    try {
      return readFileSync(path, 'utf8');
    } catch (err) {
      throw new CliError(
        `cannot read @${path}: ${err instanceof Error ? err.message : String(err)}`,
        EXIT_USAGE,
      );
    }
  },
  async readStdin() {
    // §7.3: stdin is consumed only when the syntax asks for it, and it can be
    // asked for only once — two `-` sources in one command would each read a
    // different half of the same pipe.
    if (stdinConsumed) {
      throw new CliError('stdin (`-`) can be used only once per command', EXIT_USAGE);
    }
    stdinConsumed = true;
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString('utf8');
    // Piped input is text the agent produced, so it counts toward what the
    // agent EMITTED. Size only — the content is the caller's payload.
    journal.noteStdin(text.length);
    return text;
  },
};

/** Test seam: forget that stdin was read. Never called by the CLI itself. */
export function resetStdinGuard(): void {
  stdinConsumed = false;
}

export async function readTextSource(raw: string, io: SourceIo = defaultIo): Promise<string> {
  const spec = parseSource(raw);
  if (spec.kind === 'inline') return spec.value;
  if (spec.kind === 'stdin') return io.readStdin();
  // Any read failure is LOCAL validation (exit 2). Wrapped here rather than
  // only in the default io so an injected io cannot leak an unclassified
  // error out of the kernel funnel.
  try {
    return io.readFile(spec.path);
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw new CliError(
      `cannot read @${spec.path}: ${err instanceof Error ? err.message : String(err)}`,
      EXIT_USAGE,
    );
  }
}

/**
 * A `<json-source>`. Invalid JSON is a LOCAL validation failure (exit 2): the
 * CLI must not put a body it cannot parse on the wire and let the Server
 * discover it.
 */
export async function readJsonSource(raw: string, io: SourceIo = defaultIo): Promise<unknown> {
  const text = await readTextSource(raw, io);
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new CliError(
      `invalid JSON source: ${err instanceof Error ? err.message : String(err)}`,
      EXIT_USAGE,
    );
  }
}
