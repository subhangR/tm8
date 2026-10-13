/**
 * NODE SETTINGS — the curated env knobs a node admin may set from
 * Node admin → Configuration (migration 324, `internal.node_settings`).
 *
 * PRECEDENCE (decided here, shown in the UI): env > stored > default.
 *   - A variable the operator set in the server's environment wins. The stored
 *     value is kept but ignored while the environment pins it.
 *   - Otherwise the stored value applies.
 *   - Otherwise the code default applies.
 * The environment wins so that recovery never depends on the database: a
 * stored value that locks people out is undone by setting the variable and
 * restarting, whatever the table says.
 *
 * EVERY SETTING HERE APPLIES ON RESTART. `main()` reads the table once, before
 * `loadConfig`, and writes each stored value into the process env where the
 * operator left the variable unset. Nothing downstream knows the table exists:
 * every reader keeps reading env. A write changes the table only, and the
 * Configuration page says "restart needed" until the process has booted with
 * the stored value.
 *
 * Provider keys are NOT here: they stay in the server environment and the
 * node's credential policy (Node credentials), never as plaintext in a table.
 */
import { delimiter, isAbsolute } from 'node:path';

import pg from 'pg';

import { CollabError } from '@tm8/contract';
import type { NodeSettingInput } from '@tm8/contract';

export interface NodeSettingDef {
  name: string;
  input: NodeSettingInput;
  /** Normalised text to store, or a reason the value is refused. */
  parse(raw: string): { ok: true; value: string } | { ok: false; reason: string };
  /**
   * True when storing `value` turns off the loopback auto-owner arm at the next
   * boot. Those writes need a caller who can still sign in afterwards.
   */
  disablesAutoOwner?: (value: string) => boolean;
}

const ok = (value: string) => ({ ok: true as const, value });
const no = (reason: string) => ({ ok: false as const, reason });

function oneOf(options: readonly string[]) {
  return (raw: string) => {
    const value = raw.trim().toLowerCase();
    return options.includes(value) ? ok(value) : no(`must be one of ${options.join(', ')}`);
  };
}

function integer(min: number, opts: { unlimited?: boolean } = {}) {
  return (raw: string) => {
    const value = raw.trim().toLowerCase();
    if (opts.unlimited && value === 'unlimited') return ok(value);
    if (!/^\d+$/.test(value)) {
      return no(`must be a whole number of at least ${min}${opts.unlimited ? ', or unlimited' : ''}`);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > 2_147_483_647) {
      return no(`must be a whole number from ${min} to 2147483647${opts.unlimited ? ', or unlimited' : ''}`);
    }
    return ok(String(parsed));
  };
}

function absolutePaths(raw: string) {
  const roots = raw.split(delimiter).map((value) => value.trim()).filter(Boolean);
  if (roots.length === 0) return no('needs at least one absolute directory');
  const relative = roots.find((root) => !isAbsolute(root));
  if (relative !== undefined) return no(`entries must be absolute: ${relative}`);
  return ok(roots.join(delimiter));
}

const BOOLEAN = ['true', 'false'] as const;

export const NODE_SETTINGS: readonly NodeSettingDef[] = [
  { name: 'TM8_SESSION_CAP', input: { kind: 'integer', min: 1, unlimited: true }, parse: integer(1, { unlimited: true }) },
  { name: 'TM8_TERMINAL_CAP', input: { kind: 'integer', min: 1, unlimited: true }, parse: integer(1, { unlimited: true }) },
  { name: 'TM8_WORKTREE_CAP', input: { kind: 'integer', min: 0 }, parse: integer(0) },
  {
    name: 'TM8_NODE_MODE',
    input: { kind: 'enum', options: ['single', 'multi'] },
    parse: oneOf(['single', 'multi']),
    disablesAutoOwner: (value) => value === 'multi',
  },
  {
    name: 'TM8_DISABLE_AUTO_OWNER',
    input: { kind: 'enum', options: [...BOOLEAN] },
    parse: oneOf(BOOLEAN),
    disablesAutoOwner: (value) => value === 'true',
  },
  { name: 'TM8_SPACE_SESSIONS', input: { kind: 'enum', options: ['off', 'agents', 'enforce'] }, parse: oneOf(['off', 'agents', 'enforce']) },
  // 0 disables a count dimension (config.ts reads them as non-negative); the
  // windows must be positive.
  { name: 'TM8_AUTH_MAX_ATTEMPTS', input: { kind: 'integer', min: 0 }, parse: integer(0) },
  { name: 'TM8_AUTH_ATTEMPT_WINDOW_MS', input: { kind: 'integer', min: 1 }, parse: integer(1) },
  { name: 'TM8_AUTH_MAX_FAILURES', input: { kind: 'integer', min: 0 }, parse: integer(0) },
  { name: 'TM8_AUTH_FAILURE_WINDOW_MS', input: { kind: 'integer', min: 1 }, parse: integer(1) },
  { name: 'TM8_PROJECT_ROOTS', input: { kind: 'paths', delimiter }, parse: absolutePaths },
];

const BY_NAME = new Map(NODE_SETTINGS.map((def) => [def.name, def]));

export function nodeSettingDef(name: string): NodeSettingDef | undefined {
  return BY_NAME.get(name);
}

/** Validate one write. `null` clears the stored value. */
export function parseNodeSetting(name: string, raw: string | null): { def: NodeSettingDef; value: string | null } {
  const def = BY_NAME.get(name);
  if (!def) {
    throw new CollabError('invalid_input', `${name} is not a node setting that can be changed here`);
  }
  if (raw === null) return { def, value: null };
  const parsed = def.parse(raw);
  if (!parsed.ok) throw new CollabError('invalid_input', `${name} ${parsed.reason}`);
  return { def, value: parsed.value };
}

export const AUTO_OWNER_LOCKOUT =
  'This change turns off loopback sign-in at the next restart. Sign in with your account password '
  + '(not the local auto-owner) before changing it, so you can still sign in afterwards.';

/** What the running process booted with. */
export interface NodeSettingsBoot {
  /** Variables the operator's environment set before the overlay. */
  readonly pinnedByEnv: ReadonlySet<string>;
  /** Stored values the overlay wrote into the env at boot. */
  readonly applied: ReadonlyMap<string, string>;
}

export const NO_BOOT_OVERLAY: NodeSettingsBoot = { pinnedByEnv: new Set(), applied: new Map() };

let bootState: NodeSettingsBoot | null = null;

/**
 * The overlay this process booted with. A process that never ran it (tests,
 * a bootstrap without `main`) reports every set variable as env-pinned.
 */
export function nodeSettingsBoot(env: NodeJS.ProcessEnv = process.env): NodeSettingsBoot {
  if (bootState) return bootState;
  return {
    pinnedByEnv: new Set(NODE_SETTINGS.map((d) => d.name).filter((name) => (env[name]?.trim() ?? '') !== '')),
    applied: new Map(),
  };
}

/**
 * Write stored values into `env` where the operator left the variable unset.
 * A stored value the current rules refuse is skipped with a warning rather
 * than refusing boot: a bad row must not take the node down.
 */
export function applyNodeSettings(
  env: NodeJS.ProcessEnv,
  rows: ReadonlyArray<{ name: string; value: string }>,
  warn: (message: string) => void = (message) => console.warn(message),
): NodeSettingsBoot {
  const pinnedByEnv = new Set(
    NODE_SETTINGS.map((d) => d.name).filter((name) => (env[name]?.trim() ?? '') !== ''),
  );
  const applied = new Map<string, string>();
  for (const row of rows) {
    const def = BY_NAME.get(row.name);
    if (!def || pinnedByEnv.has(row.name)) continue;
    const parsed = def.parse(row.value);
    if (!parsed.ok) {
      warn(`  node setting ${row.name} ignored: ${parsed.reason}`);
      continue;
    }
    env[row.name] = parsed.value;
    applied.set(row.name, parsed.value);
  }
  bootState = { pinnedByEnv, applied };
  return bootState;
}

/** Read the stored settings as the graph owner, before anything serves. */
export async function readStoredNodeSettings(databaseUrl: string): Promise<Array<{ name: string; value: string }>> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('begin read only');
    await client.query('set local role tm8_graph_owner');
    const result = await client.query<{ name: string; value: string }>(
      'select name, value from internal.node_settings order by name',
    );
    await client.query('commit');
    return result.rows;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    // A database without migration 324 yet: no overrides, not a failed boot.
    if ((error as { code?: string }).code === '42P01') return [];
    throw error;
  } finally {
    await client.end();
  }
}

/** Test seam: forget the boot overlay. */
export function resetNodeSettingsBootForTests(): void {
  bootState = null;
}
