import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import pg from 'pg';
import type { AuditEventRecord } from '../../src/core-types.js';
import { PgVaultStore } from '../../src/store/postgres.js';
import { FixedClock, T0 } from '../support/kit.js';
import type { StoreHarness } from '../support/store-conformance.js';

const run = promisify(execFile);
export const PG_REASON = 'TM8_VAULT_PG_URL is unset; requires an isolated PG16 scratch cluster on 127.0.0.1:55400-55499';
export const PG_ENABLED = Boolean(process.env.TM8_VAULT_PG_URL);
// Review F06: on a GitHub runner the database security suites are a release gate. Without a
// scratch cluster they fail to load there, instead of warning and skipping.
if (!PG_ENABLED && process.env.GITHUB_ACTIONS === 'true') {
  throw new Error(`vault Postgres suites cannot be skipped on a CI runner: ${PG_REASON}`);
}
if (!PG_ENABLED) console.warn(`Vault Postgres tests SKIPPED: ${PG_REASON}`);

/**
 * Creates the application role that 001 creates, for standalone vault migration
 * tests. Race-safe like 450's own roles: parallel suites on a fresh cluster all
 * pass the `if not exists` check, and every create but one would then fail.
 */
export const ENSURE_APP_ROLE = "do $$ begin if not exists (select 1 from pg_roles where rolname = 'tm8_app') then begin create role tm8_app nologin; exception when duplicate_object or unique_violation then null; end; end if; end $$";

export function scratchUrl(): URL {
  const url = new URL(process.env.TM8_VAULT_PG_URL!);
  if (url.hostname !== '127.0.0.1' || !/^554\d\d$/.test(url.port) || !['postgres:','postgresql:'].includes(url.protocol)) {
    throw new Error('vault pg tests: unsafe scratch database address');
  }
  return url;
}

/**
 * The vault roles are cluster-global. Every suite's database holds them through
 * the schema 450 creates, and the committed rollback in postgres-migration.test.ts
 * drops each role that no database still holds. A database holds nothing from its
 * create until its 450 apply commits, and from restoreDump's schema drop until its
 * replay commits. A rollback inside such a window dropped the roles under the
 * neighbour, whose replay then failed with 42704 `role "tm8_vault_owner" does not
 * exist` (test 17 in a check.sh run). So every such window, and every dispose,
 * holds this lock SHARED, and the rollback holds it EXCLUSIVE. Advisory locks are
 * per database, so all of them are taken in the cluster's admin database
 * (TM8_VAULT_PG_URL), each on a session of its own. Never nest two holds: a shared
 * request waits behind a queued exclusive one.
 */
const VAULT_ROLES_LOCK = '450, 1';

export async function holdingVaultRoles<T>(mode: 'shared' | 'exclusive', work: () => Promise<T>): Promise<T> {
  const suffix = mode === 'shared' ? '_shared' : '';
  const session = new pg.Client({ connectionString: scratchUrl().toString() });
  session.on('error', () => undefined);
  await session.connect();
  try {
    await session.query(`select pg_advisory_lock${suffix}(${VAULT_ROLES_LOCK})`);
    return await work();
  } finally {
    // Ending the session releases the lock too; the unlock just releases it first.
    await session.query(`select pg_advisory_unlock${suffix}(${VAULT_ROLES_LOCK})`).catch(() => undefined);
    await session.end().catch(() => undefined);
  }
}

export interface PgHarness extends StoreHarness {
  store: PgVaultStore;
  admin: pg.Pool;
  url: string;
  dump(): Promise<string>;
  restoreDump(dump: string): Promise<void>;
}

/** Every route by which the application role could reach vault data. NO_APP_ROLE_REACH is none. */
export interface AppRoleVaultReach {
  schema: { usage: boolean; create: boolean };
  publicSchemaGrants: number;
  relations: string[];
  functions: string[];
  readRefused: boolean;
}

export const NO_APP_ROLE_REACH: AppRoleVaultReach = { schema: { usage: false, create: false }, publicSchemaGrants: 0, relations: [], functions: [], readRefused: true };

export async function appRoleVaultReach(admin: pg.Pool): Promise<AppRoleVaultReach> {
  const schema = (await admin.query("select has_schema_privilege('tm8_app','vault','USAGE') as usage, has_schema_privilege('tm8_app','vault','CREATE') as create")).rows[0];
  const publicSchemaGrants = Number((await admin.query("select count(*) as n from pg_namespace n, lateral aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a where n.nspname = 'vault' and a.grantee = 0")).rows[0].n);
  // Table, column and sequence grants; has_table_privilege alone misses a column grant.
  const relations = (await admin.query(`select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'vault' and (
      (c.relkind in ('r','p','v','m','f') and (has_table_privilege('tm8_app', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
        or has_any_column_privilege('tm8_app', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')))
      or (c.relkind = 'S' and has_sequence_privilege('tm8_app', c.oid, 'USAGE,SELECT,UPDATE')))
    order by 1`)).rows.map((row) => row.relname as string);
  const functions = (await admin.query("select p.oid::regprocedure::text as name from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'vault' and has_function_privilege('tm8_app', p.oid, 'EXECUTE') order by 1")).rows.map((row) => row.name as string);
  let readRefused = false;
  const client = await admin.connect();
  try {
    await client.query('set role tm8_app');
    try { await client.query('select 1 from vault.items limit 1'); }
    catch (error) { readRefused = (error as { code?: string }).code === '42501'; }
  } finally { await client.query('reset role'); client.release(); }
  return { schema, publicSchemaGrants, relations, functions, readRefused };
}

export async function pgHarness(): Promise<PgHarness> {
  const base = scratchUrl();
  const admin = new pg.Pool({ connectionString: base.toString() });
  admin.on('error', () => undefined);
  const name = 'vault_wsf_' + randomUUID().replaceAll('-', '');
  const target = new URL(base); target.pathname = '/' + name;
  const database = new pg.Pool({ connectionString: target.toString() });
  database.on('error', () => undefined);
  const migration = await readFile(new URL('../../../../db/migrations/450_vault_store.sql', import.meta.url), 'utf8');
  // Holds nothing until the apply commits (holdingVaultRoles).
  await holdingVaultRoles('shared', async () => {
    try {
      await admin.query(`create database ${name}`);
      await database.query(ENSURE_APP_ROLE);
      await database.query(migration);
    } catch (error) {
      await database.end(); await admin.query(`drop database if exists ${name} with (force)`); await admin.end(); throw error;
    }
  });
  const clock = new FixedClock(T0);
  const store = new PgVaultStore({ connectionString: target.toString(), role: 'tm8_vault_broker', clock });
  const dump = async (): Promise<string> => (await run('/usr/lib/postgresql/16/bin/pg_dump', ['--dbname', target.toString(), '--schema=vault', '--no-comments', '--inserts'], { maxBuffer: 32 * 1024 * 1024 })).stdout;
  // Holds nothing from the drop until the replay commits (holdingVaultRoles).
  const restoreDump = (snapshot: string): Promise<void> => holdingVaultRoles('shared', async () => {
    await database.query('drop schema vault cascade');
    await database.query(snapshot.split('\n').filter((line) => !line.startsWith('\\')).join('\n'));
  });
  return {
    store, clock, admin: database, url: target.toString(), dump, restoreDump,
    hooks: {
      setUnavailable: (on) => { store.faults.unavailable = on; },
      setAuditAppendFailure: (on) => { store.faults.auditAppend = on; },
      snapshot: dump,
      restore: (snapshot) => restoreDump(snapshot as string),
      secretVersionCount: async (itemId) => Number((await database.query('select count(*) as n from vault.secret_versions where item_id = $1', [itemId])).rows[0].n),
      tamperAuditEvent: async (seq, patch) => {
        const columns: Record<string, string> = { params: 'params', actor: 'actor', at: 'at', bodyText: 'body_text', entryHash: 'entry_hash', prevHash: 'prev_hash', itemId: 'item_id', seq: 'seq' };
        const entries = Object.entries(patch);
        if (entries.some(([key]) => !columns[key])) throw new TypeError('vault pg tests: invalid tamper field');
        const client = await database.connect();
        try {
          await client.query('begin');
          await client.query('alter table vault.audit_events disable trigger audit_append_only');
          await client.query(`update vault.audit_events set ${entries.map(([key], index) => `${columns[key]} = $${index + 2}`).join(', ')} where seq = $1`, [seq, ...entries.map(([key, value]) => ['params','actor'].includes(key) ? JSON.stringify(value) : value)]);
          await client.query('alter table vault.audit_events enable trigger audit_append_only');
          await client.query('commit');
        } catch (error) { await client.query('rollback'); throw error; }
        finally { client.release(); }
      },
      deleteAuditEvent: async (seq) => {
        const client = await database.connect();
        try {
          await client.query('begin');
          await client.query('alter table vault.audit_events disable trigger audit_append_only');
          await client.query('delete from vault.audit_events where seq = $1', [seq]);
          await client.query('alter table vault.audit_events enable trigger audit_append_only');
          await client.query('commit');
        } catch (error) { await client.query('rollback'); throw error; }
        finally { client.release(); }
      },
    },
    dispose: async () => {
      await store.close(); await database.end();
      // A drop ends this database's hold: shared, so the rollback test sees a fixed set of holders.
      await holdingVaultRoles('shared', () => admin.query(`drop database ${name} with (force)`)); await admin.end();
    },
  };
}
