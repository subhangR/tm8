import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { Pool, type PoolClient, type QueryResultRow } from 'pg';

import { testAdminUrl } from './pg-port-guard.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '../../../..');
export const MIGRATIONS_DIR = join(REPO_ROOT, 'db', 'migrations');

function psqlPath(): string {
  if (process.env['TM8_PSQL']) return process.env['TM8_PSQL'];
  for (const candidate of [
    '/opt/homebrew/opt/postgresql@18/bin/psql',
    '/usr/local/opt/postgresql@18/bin/psql',
    '/usr/lib/postgresql/18/bin/psql',
    'psql',
  ]) {
    if (candidate === 'psql' || existsSync(candidate)) return candidate;
  }
  throw new Error('psql is required for W1 migration rehearsals');
}

function configuredAdminUrl(): string {
  // Refuses 5442 (PROD on the tm8 host) and an unset port — see ./pg-port-guard.ts.
  const configured = testAdminUrl();
  const url = new URL(configured);
  url.pathname = `/${process.env['TM8_ADMIN_DB'] ?? 'postgres'}`;
  return url.toString();
}

function databaseUrl(adminUrl: string, database: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => /^\d{3}_[a-z0-9_]+\.sql$/.test(file))
    .sort();
}

export interface W1ScratchDatabase {
  readonly name: string;
  readonly url: string;
  readonly pool: Pool;
  apply(files: readonly string[]): void;
  query<R extends QueryResultRow = QueryResultRow>(sql: string, params?: readonly unknown[]): Promise<R[]>;
  transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
  destroy(): Promise<void>;
}

/**
 * Scratch databases this process created and has not dropped yet, by name.
 *
 * `destroy()` is the normal path. This map is the fallback for the two ways a
 * suite never reaches it, both measured as leaks on the shared local cluster
 * (141 `tm8_w1_*`/`tm8_w4_*` databases on 2026-09-24):
 *
 *   - an `afterAll` that times out: vitest moves on and tinypool ends the fork
 *     with SIGTERM (then SIGKILL), which runs no `exit` listeners by default;
 *   - an ordinary exit with a suite that forgot its teardown.
 *
 * On either, the remaining databases are dropped by a detached psql. SIGKILL is out
 * of reach by definition; `scripts/pg-scratch-gc.mjs` collects those.
 */
const undropped = new Map<string, string>();
let exitHookInstalled = false;

// Detached and unawaited: tinypool SIGKILLs a fork 1s after its SIGTERM, and
// under the load that causes the hook timeouts in the first place a
// synchronous psql did not finish inside that second. Measured: 6 of 12
// databases leaked with spawnSync here. A detached child outlives the fork.
function dropDetached(adminUrl: string, name: string): void {
  spawn(
    psqlPath(),
    ['--no-psqlrc', '-q', adminUrl, '-c', `drop database if exists ${name} with (force)`],
    { stdio: 'ignore', detached: true },
  ).unref();
}

function dropUndropped(): void {
  for (const [name, adminUrl] of undropped) dropDetached(adminUrl, name);
  undropped.clear();
}

function trackUntilDropped(name: string, adminUrl: string): void {
  undropped.set(name, adminUrl);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', dropUndropped);
  // The fork's parent went away (vitest's main process exited or was killed):
  // nobody will SIGTERM us, and nobody will run our teardown.
  process.once('disconnect', dropUndropped);
  // SIGTERM is tinypool ending a fork after a hook timeout; SIGINT and SIGHUP
  // are a Ctrl-C or a closed terminal, which reach the whole process group.
  // Measured: a mid-suite SIGINT left its database behind before this.
  for (const [signal, code] of [['SIGTERM', 15], ['SIGINT', 2], ['SIGHUP', 1]] as const) {
    process.once(signal, () => {
      dropUndropped();
      // Listening replaced the default action; restore its outcome unless
      // someone else also listens and owns the exit.
      if (process.listenerCount(signal) === 0) process.exit(128 + code);
    });
  }
}

/**
 * Opt-in measurement for statement timeouts (57014) on a loaded local cluster:
 * `TM8_TEST_PG_LOG_MIN_DURATION_MS=500` makes Postgres log every statement in
 * THIS scratch database that runs longer than that, plus every lock wait past
 * `deadlock_timeout`. Scoped to the database, so the cluster and `tm8_stable`
 * are untouched. Needs a superuser admin URL, as the harness already does.
 */
export function slowStatementLoggingSql(database: string): string {
  const raw = process.env['TM8_TEST_PG_LOG_MIN_DURATION_MS'];
  const ms = Number(raw);
  if (!raw || !Number.isInteger(ms) || ms < 0) return 'select 1';
  return `alter database ${database} set log_min_duration_statement = ${ms}; ` +
    `alter database ${database} set log_lock_waits = on`;
}

/**
 * Drop a database this process created: plainly first, forced only if that is
 * refused.
 *
 * Plain first because our own just-ended pool's backends may still be exiting.
 * Postgres waits up to 5s for them, and a FORCE would instead send each a FATAL
 * 57P01 mid-close, which pg surfaces as an uncaught exception on a client whose
 * pool has already dropped its error listener (CI run 35962531852 failed the
 * whole server package on exactly that).
 *
 * Forced second because a plain drop fails with "is being accessed by other
 * users" when something the suite booted (a server's own pool, a delivery
 * worker) still holds a session. The server log showed 61 such failures, each
 * one a leaked database. Scoped to the exact name this process created.
 */
async function dropOwnDatabase(admin: Pool, name: string): Promise<void> {
  try {
    await admin.query(`drop database if exists ${name}`);
  } catch (error) {
    if ((error as { code?: string }).code !== '55006') throw error;
    await admin.query(`drop database if exists ${name} with (force)`);
  }
}

export async function createW1ScratchDatabase(label: string): Promise<W1ScratchDatabase> {
  const safeLabel = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 20);
  const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
  const name = `tm8_w1_${safeLabel}_${process.pid}_${suffix}`;
  if (!/^tm8_w1_[a-z0-9_]+$/.test(name)) throw new Error(`unsafe scratch database name: ${name}`);

  const adminUrl = configuredAdminUrl();
  const admin = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await admin.query(`create database ${name}`);
    trackUntilDropped(name, adminUrl);
    await admin.query(slowStatementLoggingSql(name));
  } finally {
    await admin.end();
  }

  const url = databaseUrl(adminUrl, name);
  const pool = new Pool({ connectionString: url, max: 24 });

  return {
    name,
    url,
    pool,
    apply(files): void {
      for (const file of files) {
        if (!/^\d{3}_[a-z0-9_]+\.sql$/.test(file)) throw new Error(`unsafe migration filename: ${file}`);
        const result = spawnSync(
          psqlPath(),
          ['--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-1', '-q', url, '-f', join(MIGRATIONS_DIR, file)],
          { cwd: REPO_ROOT, encoding: 'utf8' },
        );
        if (result.status !== 0) {
          throw new Error(
            `could not apply ${file} to ${name}:\n${result.stdout ?? ''}\n${result.stderr ?? ''}`,
          );
        }
      }
    },
    async query<R extends QueryResultRow = QueryResultRow>(sql: string, params: readonly unknown[] = []): Promise<R[]> {
      const result = await pool.query<R>(sql, [...params]);
      return result.rows;
    },
    async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const result = await fn(client);
        await client.query('commit');
        return result;
      } catch (error) {
        await client.query('rollback');
        throw error;
      } finally {
        client.release();
      }
    },
    async destroy(): Promise<void> {
      await pool.end();
      const cleanup = new Pool({ connectionString: adminUrl, max: 1 });
      try {
        await dropOwnDatabase(cleanup, name);
        undropped.delete(name);
      } finally {
        await cleanup.end();
      }
    },
  };
}

