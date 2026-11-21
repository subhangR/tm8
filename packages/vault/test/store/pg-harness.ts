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
if (!PG_ENABLED) console.warn(`Vault Postgres tests SKIPPED: ${PG_REASON}`);

function scratchUrl(): URL {
  const url = new URL(process.env.TM8_VAULT_PG_URL!);
  if (url.hostname !== '127.0.0.1' || !/^554\d\d$/.test(url.port) || !['postgres:','postgresql:'].includes(url.protocol)) {
    throw new Error('vault pg tests: unsafe scratch database address');
  }
  return url;
}

export interface PgHarness extends StoreHarness {
  store: PgVaultStore;
  admin: pg.Pool;
  url: string;
  dump(): Promise<string>;
  restoreDump(dump: string): Promise<void>;
}

export async function pgHarness(): Promise<PgHarness> {
  const base = scratchUrl();
  const admin = new pg.Pool({ connectionString: base.toString() });
  admin.on('error', () => undefined);
  const name = 'vault_wsf_' + randomUUID().replaceAll('-', '');
  await admin.query(`create database ${name}`);
  const target = new URL(base); target.pathname = '/' + name;
  const database = new pg.Pool({ connectionString: target.toString() });
  database.on('error', () => undefined);
  try {
    // Standalone vault migration tests need the application role that 001 creates.
    await database.query("do $$ begin if not exists (select 1 from pg_roles where rolname = 'tm8_app') then create role tm8_app nologin; end if; end $$");
    const migration = await readFile(new URL('../../../../db/migrations/450_vault_store.sql', import.meta.url), 'utf8');
    await database.query(migration);
  } catch (error) {
    await database.end(); await admin.query(`drop database ${name} with (force)`); await admin.end(); throw error;
  }
  const clock = new FixedClock(T0);
  const store = new PgVaultStore({ connectionString: target.toString(), role: 'tm8_vault_broker', clock });
  const dump = async (): Promise<string> => (await run('/usr/lib/postgresql/16/bin/pg_dump', ['--dbname', target.toString(), '--schema=vault', '--no-comments', '--inserts'], { maxBuffer: 32 * 1024 * 1024 })).stdout;
  const restoreDump = async (snapshot: string): Promise<void> => {
    await database.query('drop schema vault cascade');
    await database.query(snapshot.split('\n').filter((line) => !line.startsWith('\\')).join('\n'));
  };
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
      await admin.query(`drop database ${name} with (force)`); await admin.end();
    },
  };
}
