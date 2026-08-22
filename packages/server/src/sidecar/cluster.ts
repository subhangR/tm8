/**
 * Cluster primitives — `initdb`, `pg_ctl start/stop/status`, database creation,
 * and the row-count manifest the major-upgrade path verifies against (§4).
 *
 * Everything here is a thin, typed wrapper over Postgres's own tools. The
 * lifecycle decisions live in `manager.ts` and `upgrade.ts`; this module only
 * knows how to ask Postgres to do a thing and how to report that it failed.
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { toolPath } from './binaries.js';
import type { ResolvedSidecarConfig } from './config.js';
import { SidecarError } from './errors.js';
import { describeFailure, run, tail } from './exec.js';
import type { SidecarLogger } from './log.js';

export interface ClusterTarget {
  readonly binariesDir: string;
  readonly pgDataDir: string;
  readonly socketDir: string;
  readonly pgPort: number;
  readonly superuser: string;
  readonly logDir: string;
  /** `listen_addresses`; `''` is the socket-only desktop profile. */
  readonly listenAddresses?: string;
}

/** `pg_ctl` reports 0 = running, 3 = not running, anything else = broken. */
export type PgCtlStatus = 'running' | 'stopped' | 'unknown';

/** The cluster's major from `PG_VERSION`; `null` when no cluster exists yet. */
export function readClusterMajor(pgDataDir: string): number | null {
  const path = join(pgDataDir, 'PG_VERSION');
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf8').trim();
  const major = Number(raw.split('.')[0]);
  return Number.isInteger(major) ? major : null;
}

export function clusterExists(pgDataDir: string): boolean {
  return readClusterMajor(pgDataDir) !== null;
}

export function postmasterLogPath(logDir: string): string {
  return join(logDir, 'postgres.log');
}

/**
 * Locale policy for a freshly created cluster.
 *
 * Default: PG 18's **builtin** provider with `C.UTF-8`. A bundled sidecar must
 * create an identical cluster on every machine it ships to, and the builtin
 * provider needs no OS locale data at all — unlike `en_US.UTF-8`, which is
 * present on macOS but routinely absent from minimal Linux images (and whose
 * absence is exactly how `initdb` fails). Byte-order collation is also stable
 * across libc upgrades, which index correctness depends on.
 *
 * Overridable with `TM8_PG_LOCALE_PROVIDER` / `TM8_PG_LOCALE`; if the builtin
 * provider is rejected by the binary, `initdb()` retries once with the plain
 * environment locale and says so loudly.
 */
export interface LocalePolicy {
  readonly provider: string;
  readonly locale: string;
  readonly encoding: string;
}

export function resolveLocalePolicy(env: NodeJS.ProcessEnv): LocalePolicy {
  return {
    provider: env['TM8_PG_LOCALE_PROVIDER'] ?? 'builtin',
    locale: env['TM8_PG_LOCALE'] ?? 'C.UTF-8',
    encoding: env['TM8_PG_ENCODING'] ?? 'UTF8',
  };
}

export interface InitdbOptions {
  readonly locale?: LocalePolicy;
  readonly logger?: SidecarLogger;
}

/**
 * Create a new cluster.
 *
 * `--auth=trust` is acceptable **only** because the postmaster binds loopback +
 * a socket inside a `0700` data dir owned by this user (S19). Hosted
 * compositions in Phase 2 provision password/peer auth through the gateway.
 *
 * @throws SidecarError `InitdbFailed`
 */
export async function initdb(t: ClusterTarget, opts: InitdbOptions = {}): Promise<void> {
  const locale = opts.locale ?? resolveLocalePolicy(process.env);
  await mkdir(t.pgDataDir, { recursive: true, mode: 0o700 });

  const base = ['-D', t.pgDataDir, '-U', t.superuser, '--auth=trust', `--encoding=${locale.encoding}`];
  const withProvider = [
    ...base,
    `--locale-provider=${locale.provider}`,
    ...(locale.provider === 'builtin' ? [`--builtin-locale=${locale.locale}`] : [`--locale=${locale.locale}`]),
  ];

  let r = await run(toolPath(t.binariesDir, 'initdb'), withProvider, { timeoutMs: 180_000 });
  if (!r.ok) {
    opts.logger?.warn(
      `initdb: locale-provider=${locale.provider} rejected; retrying with the environment locale`,
      tail(r.stderr, 5),
    );
    r = await run(toolPath(t.binariesDir, 'initdb'), base, { timeoutMs: 180_000 });
  }
  if (!r.ok) {
    throw new SidecarError('InitdbFailed', `tm8: initdb failed for ${t.pgDataDir}`, {
      detail: describeFailure(r),
    });
  }
  opts.logger?.info(`initdb: created cluster at ${t.pgDataDir}`);
}

/**
 * Postmaster options: socket inside the data dir (§7), plus loopback TCP for
 * tooling unless `listenAddresses` says otherwise.
 *
 * Every value is single-quoted because `pg_ctl` splices this string into the
 * command line it hands to the shell **without quoting it** (only `-D` gets
 * quoted, by `pg_ctl` itself). An unquoted socket directory therefore breaks on
 * any path containing a space — which is every macOS
 * `~/Library/Application Support/...` data dir, i.e. the desktop app's.
 */
export function postmasterOptions(t: ClusterTarget): string {
  const listen = t.listenAddresses ?? '127.0.0.1';
  return [
    `-k ${shellQuote(t.socketDir)}`,
    `-p ${t.pgPort}`,
    `-c listen_addresses=${shellQuote(listen)}`,
    `-c unix_socket_permissions=0700`,
  ].join(' ');
}

/** POSIX single-quoting: the only escape inside `'…'` is `'\''`. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface StartOptions {
  readonly logger?: SidecarLogger;
  /** `pg_ctl -w -t` seconds. The §6 probes are the real readiness gate. */
  readonly waitSeconds?: number;
}

/** Start the postmaster via `pg_ctl -w start`. Does not imply readiness (§6). */
export async function startPostmaster(t: ClusterTarget, opts: StartOptions = {}): Promise<void> {
  await mkdir(t.socketDir, { recursive: true, mode: 0o700 });
  await mkdir(t.logDir, { recursive: true, mode: 0o700 });

  const r = await run(
    toolPath(t.binariesDir, 'pg_ctl'),
    [
      '-D', t.pgDataDir,
      '-l', postmasterLogPath(t.logDir),
      '-o', postmasterOptions(t),
      '-w',
      '-t', String(opts.waitSeconds ?? 30),
      'start',
    ],
    { timeoutMs: 90_000 },
  );
  if (!r.ok) {
    throw new SidecarError('StartTimeout', `tm8: pg_ctl start failed for ${t.pgDataDir}`, {
      detail: `${describeFailure(r)}\n${readLogTail(t)}`,
    });
  }
  opts.logger?.info(`postgres: started (data=${t.pgDataDir} socket=${t.socketDir} port=${t.pgPort})`);
}

/** Graceful shutdown: `pg_ctl stop -m fast`. Idempotent. */
export async function stopPostmaster(t: ClusterTarget, logger?: SidecarLogger): Promise<void> {
  if (!clusterExists(t.pgDataDir)) return;
  const r = await run(
    toolPath(t.binariesDir, 'pg_ctl'),
    ['-D', t.pgDataDir, '-m', 'fast', '-w', '-t', '30', 'stop'],
    { timeoutMs: 60_000 },
  );
  // "not running" is success for an idempotent stop.
  if (!r.ok && !/not running|no server running/i.test(r.stderr + r.stdout)) {
    throw new SidecarError('StartTimeout', `tm8: pg_ctl stop failed for ${t.pgDataDir}`, {
      detail: describeFailure(r),
    });
  }
  logger?.info(`postgres: stopped (${t.pgDataDir})`);
}

export async function pgCtlStatus(t: ClusterTarget): Promise<PgCtlStatus> {
  const r = await run(toolPath(t.binariesDir, 'pg_ctl'), ['-D', t.pgDataDir, 'status'], {
    timeoutMs: 15_000,
  });
  if (r.code === 0) return 'running';
  if (r.code === 3) return 'stopped';
  return 'unknown';
}

export function readLogTail(t: ClusterTarget, lines = 30): string {
  const path = postmasterLogPath(t.logDir);
  if (!existsSync(path)) return '(no postmaster log)';
  try {
    return tail(readFileSync(path, 'utf8'), lines);
  } catch {
    return '(postmaster log unreadable)';
  }
}

/** Run one SQL statement against a database, returning trimmed tuple-only output. */
export async function psqlQuery(
  t: ClusterTarget,
  database: string,
  sql: string,
  timeoutMs = 30_000,
): Promise<string> {
  const r = await run(
    toolPath(t.binariesDir, 'psql'),
    [
      '-h', t.socketDir,
      '-p', String(t.pgPort),
      '-U', t.superuser,
      '-d', database,
      '-v', 'ON_ERROR_STOP=1',
      '-tAc', sql,
    ],
    { timeoutMs },
  );
  if (!r.ok) {
    throw new SidecarError('SchemaMigrationFailed', `tm8: psql query failed against ${database}`, {
      detail: describeFailure(r),
    });
  }
  return r.stdout.trim();
}

/** Create the application database if it does not exist. Idempotent. */
export async function ensureDatabase(
  t: ClusterTarget,
  database: string,
  logger?: SidecarLogger,
): Promise<boolean> {
  const found = await psqlQuery(
    t,
    'postgres',
    `SELECT 1 FROM pg_database WHERE datname = '${database.replace(/'/g, "''")}'`,
  );
  if (found === '1') return false;

  const r = await run(
    toolPath(t.binariesDir, 'createdb'),
    ['-h', t.socketDir, '-p', String(t.pgPort), '-U', t.superuser, '-O', t.superuser, database],
    { timeoutMs: 60_000 },
  );
  if (!r.ok) {
    throw new SidecarError('InitdbFailed', `tm8: could not create database "${database}"`, {
      detail: describeFailure(r),
    });
  }
  logger?.info(`postgres: created database "${database}"`);
  return true;
}

/**
 * Per-table live row counts for the upgrade verification probe (§4 step 7).
 *
 * Uses `count(*)` through a lateral over `pg_class`, not the planner's estimate:
 * an estimate would happily "verify" a restore that lost rows.
 */
export async function tableRowCounts(
  t: ClusterTarget,
  database: string,
): Promise<Record<string, number>> {
  const names = (
    await psqlQuery(
      t,
      database,
      `SELECT quote_ident(schemaname) || '.' || quote_ident(tablename)
         FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')
         ORDER BY 1`,
    )
  )
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  if (names.length === 0) return {};

  // One round trip: UNION ALL of exact counts.
  const union = names.map((n) => `SELECT '${n.replace(/'/g, "''")}' AS t, count(*) AS n FROM ${n}`).join(' UNION ALL ');
  const rows = (await psqlQuery(t, database, `${union} ORDER BY 1`, 10 * 60_000)
    .then((s) => s.split('\n'))
    .catch(() => [] as string[]))
    .map((s) => s.trim())
    .filter(Boolean);

  const out: Record<string, number> = {};
  for (const row of rows) {
    const [table, count] = row.split('|');
    if (table === undefined || count === undefined) continue;
    out[table] = Number(count);
  }
  return out;
}
