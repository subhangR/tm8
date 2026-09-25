/**
 * EVERY POOLED CONNECTION RUNS WITH JIT OFF.
 *
 * `jit` is a per-connection startup parameter set in `PgDb`'s pool options
 * (see the note in src/db/client.ts). With JIT on, a Postgres built with LLVM
 * compiles every statement whose estimate crosses `jit_above_cost`, hundreds
 * of ms each; a ~60-statement command result then outlives the clients' 15s
 * deadline. That is what timed out `task link-pr` in test-cli's receipt suite.
 *
 * Asserted against a real server, not the options object: a startup
 * parameter Postgres rejects or ignores would pass a config-shape check. The
 * assertion reads `pg_settings.source` as well as the value: `client` is what
 * Postgres records for a startup-packet `-c`, so the pooled `off` is proven to
 * come from PgDb and not from a cluster that already runs `jit = off` (which
 * is a sane thing for an operator to set, and must not red this file). The
 * control is a plain connection to the same database, which must NOT carry a
 * client-sourced setting — otherwise the probe cannot tell the two apart.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

import { PgDb } from '../../src/db/client.js';
import { createW1ScratchDatabase, type W1ScratchDatabase } from './w1-pg.js';

let database: W1ScratchDatabase;
let db: PgDb;

beforeAll(async () => {
  database = await createW1ScratchDatabase('jit_off');
  db = new PgDb({ databaseUrl: database.url, max: 2 });
}, 120_000);

afterAll(async () => {
  await db?.end();
  await database?.destroy();
});

/** The pool is private on purpose; the test reads through it, never around it. */
const poolOf = (d: PgDb): pg.Pool => (d as unknown as { pool: pg.Pool }).pool;

describe('PgDb connections', () => {
  const JIT = `select setting as jit, source from pg_settings where name = 'jit'`;

  it('report jit = off, set by the client, on every pooled client', async () => {
    const pool = poolOf(db);
    const clients = await Promise.all([pool.connect(), pool.connect()]);
    try {
      for (const client of clients) {
        const { rows } = await client.query<{ jit: string; source: string }>(JIT);
        expect(rows).toEqual([{ jit: 'off', source: 'client' }]);
      }
    } finally {
      for (const client of clients) client.release();
    }
  });

  it('control: a plain connection to the same database carries no client-set jit', async () => {
    const plain = new pg.Client({ connectionString: database.url });
    await plain.connect();
    try {
      const { rows } = await plain.query<{ jit: string; source: string }>(JIT);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.source).not.toBe('client');
    } finally {
      await plain.end();
    }
  });
});
