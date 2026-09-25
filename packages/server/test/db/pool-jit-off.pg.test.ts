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
 * control is a plain connection to the same database, which must NOT carry
 * the setting — otherwise the assertion is only reading the server default.
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
  it('report jit = off on every pooled client', async () => {
    const pool = poolOf(db);
    const clients = await Promise.all([pool.connect(), pool.connect()]);
    try {
      for (const client of clients) {
        const { rows } = await client.query<{ jit: string }>('show jit');
        expect(rows).toEqual([{ jit: 'off' }]);
      }
    } finally {
      for (const client of clients) client.release();
    }
  });

  it('control: a plain connection to the same database reports the server default, on', async () => {
    const plain = new pg.Client({ connectionString: database.url });
    await plain.connect();
    try {
      const { rows } = await plain.query<{ jit: string }>('show jit');
      expect(rows).toEqual([{ jit: 'on' }]);
    } finally {
      await plain.end();
    }
  });
});
