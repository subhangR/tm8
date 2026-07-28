/**
 * Global context resolution (§3), in this exact order:
 *
 *   1. explicit `--space` / `--as`
 *   2. session-injected context (what the PTY host set on spawn)
 *   3. local CLI configuration
 *   4. the Phase-1 implicit local Server, where allowed
 *
 * Two rules make this honest rather than convenient:
 *
 *  - THE SERVER VALIDATES ALL CONTEXT. Nothing here asserts that a Space
 *    exists, that the caller is a member of it, or that `--as` is authorized.
 *    `--as` SELECTS an author; it never claims the right to be one. A CLI that
 *    pre-approved its own act-as would be inventing an authorization decision
 *    the Server owns.
 *  - EVERY resolved value carries the step that produced it. "Which Space did
 *    that write land in?" must be answerable from the diagnostics, because the
 *    difference between step 1 and step 3 is the difference between a
 *    deliberate target and a stale config file.
 *
 * Phase-1 identity is a database-resolved loopback auto-owner: there is no
 * bearer authentication. `TM8_AGENT_TOKEN` is carried when set because it is
 * the reserved seam for the Phase-2 remote transport, NOT because a token
 * means anything today.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CliError, EXIT_USAGE } from './exit.js';
import type { GlobalOptions } from './args.js';
import { type OutputFormat, OUTPUT_FORMATS } from './output.js';

/** Which of the four steps produced a value. Rendered in diagnostics. */
export type ContextSource = 'flag' | 'session' | 'config' | 'implicit-local';

export interface Resolved<T> {
  value: T;
  source: ContextSource;
}

/** Step 4: the Phase-1 implicit local Server (AM-4 — loopback only). */
export const IMPLICIT_LOCAL_BASE_URL = 'http://127.0.0.1:4610';

/**
 * Step 2. Shaped so Slot C can hand over manifest-derived values without this
 * module importing the harness, and so tests can inject one directly.
 */
export interface SessionContext {
  sessionId?: string | undefined;
  spaceId?: string | undefined;
  actorId?: string | undefined;
  baseUrl?: string | undefined;
  token?: string | undefined;
}

/** Step 3. Absent, unreadable, or malformed config is NOT an error — it is absent. */
export interface LocalConfig {
  space?: string;
  as?: string;
  baseUrl?: string;
  format?: OutputFormat;
}

export interface CliContext {
  space: Resolved<string> | undefined;
  actor: Resolved<string> | undefined;
  baseUrl: Resolved<string>;
  sessionId: string | undefined;
  token: string | undefined;
  format: OutputFormat;
  timeoutMs: number | undefined;
}

/**
 * The env the PTY host sets on spawn (04-EXECUTION-TRANSPLANT §1.1). Space and
 * actor are read from env when present; Slot C supplies the manifest-derived
 * pair for sessions whose host sets only the session id.
 */
export function sessionContextFromEnv(env: NodeJS.ProcessEnv = process.env): SessionContext {
  return {
    sessionId: env.TM8_SESSION_ID?.trim() || undefined,
    spaceId: env.TM8_SPACE_ID?.trim() || undefined,
    actorId: env.TM8_ACTOR_ID?.trim() || undefined,
    baseUrl: env.TM8_BASE_URL?.trim() || undefined,
    token: env.TM8_AGENT_TOKEN?.trim() || undefined,
  };
}

export interface ConfigIo {
  readFile(path: string): string;
}

const defaultConfigIo: ConfigIo = { readFile: (path) => readFileSync(path, 'utf8') };

/** `$TM8_CONFIG_PATH`, else `~/.config/tm8/config.json`. */
export function localConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.TM8_CONFIG_PATH?.trim();
  if (explicit) return explicit;
  return join(env.XDG_CONFIG_HOME?.trim() || join(homedir(), '.config'), 'tm8', 'config.json');
}

/**
 * Step 3, read defensively. A config file is operator convenience, so a
 * corrupt one must not take down a session that never needed it — EXCEPT when
 * the operator named it explicitly with `TM8_CONFIG_PATH`, where silence would
 * hide the very file they asked us to use.
 */
export function loadLocalConfig(
  env: NodeJS.ProcessEnv = process.env,
  io: ConfigIo = defaultConfigIo,
): LocalConfig {
  const path = localConfigPath(env);
  const explicit = Boolean(env.TM8_CONFIG_PATH?.trim());
  let text: string;
  try {
    text = io.readFile(path);
  } catch (err) {
    if (explicit) {
      throw new CliError(
        `cannot read TM8_CONFIG_PATH ${path}: ${err instanceof Error ? err.message : String(err)}`,
        EXIT_USAGE,
      );
    }
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (err) {
    if (explicit) {
      throw new CliError(
        `TM8_CONFIG_PATH ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
        EXIT_USAGE,
      );
    }
    return {};
  }
  if (parsed === null || typeof parsed !== 'object') return {};
  const raw = parsed as Record<string, unknown>;
  const str = (key: string): string | undefined => {
    const v = raw[key];
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  };
  const format = str('format');
  const config: LocalConfig = {};
  const space = str('space');
  const as = str('as');
  const baseUrl = str('baseUrl');
  if (space !== undefined) config.space = space;
  if (as !== undefined) config.as = as;
  if (baseUrl !== undefined) config.baseUrl = baseUrl;
  const known = OUTPUT_FORMATS.find((f) => f === format);
  if (known) config.format = known;
  return config;
}

export interface ResolveContextInput {
  globals: GlobalOptions;
  session?: SessionContext;
  config?: LocalConfig;
  /** Present only so the caller can decide whether `--format` was defaulted. */
  formatExplicit?: boolean;
}

/**
 * Apply the four steps. Space and actor may legitimately stay undefined: the
 * Server resolves the caller's default Space, and guessing one here would make
 * `tm8 entity create` write somewhere nobody chose.
 */
export function resolveContext(input: ResolveContextInput): CliContext {
  const { globals } = input;
  const session = input.session ?? {};
  const config = input.config ?? {};

  const pick = (
    flag: string | undefined,
    injected: string | undefined,
    configured: string | undefined,
  ): Resolved<string> | undefined => {
    if (flag !== undefined) return { value: flag, source: 'flag' };
    if (injected !== undefined) return { value: injected, source: 'session' };
    if (configured !== undefined) return { value: configured, source: 'config' };
    return undefined;
  };

  const baseUrl =
    pick(undefined, session.baseUrl, config.baseUrl) ??
    ({ value: IMPLICIT_LOCAL_BASE_URL, source: 'implicit-local' } as const);

  return {
    space: pick(globals.space, session.spaceId, config.space),
    actor: pick(globals.as, session.actorId, config.as),
    baseUrl,
    sessionId: session.sessionId,
    token: session.token,
    // A config-set format is step 3; an explicit `--format` is step 1 and the
    // parser has already applied it, so config only fills the default.
    format: input.formatExplicit === false && config.format ? config.format : globals.format,
    timeoutMs: globals.timeoutMs,
  };
}

/** The Space a command requires, with the four-step failure spelled out. */
export function requireSpace(ctx: CliContext): string {
  if (ctx.space) return ctx.space.value;
  throw new CliError(
    'no Space in context: pass --space <space-id>, run inside a session whose host injected one, or set `space` in the local config',
    EXIT_USAGE,
  );
}
