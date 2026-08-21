/**
 * A CHECKED-OUT CLIENT EMITS ON ITSELF, AND NOBODY WAS LISTENING.
 *
 * `PgDb`'s constructor guards `pool.on('error')`, and its comment is accurate
 * about what that covers: an IDLE client, one sitting in the pool between
 * checkouts. It says nothing about the other half, because there was no other
 * half until you look at what `tx()` does — `pool.connect()`, then run a
 * transaction on a client the pool is no longer watching.
 *
 * pg reports the difference verbatim. From the process death on 2026-08-21:
 *
 *     error: terminating connection due to idle-in-transaction timeout
 *     Emitted 'error' event on Client instance at:
 *         at Client._handleErrorEvent (pg/lib/client.js:417:10)
 *
 * On a Client. Not on a Pool. An unhandled 'error' on an EventEmitter is
 * rethrown from the socket callback — not into the `await` in `tx()` where the
 * catch is, but at the top of the stack — so the process exits and every PTY it
 * hosts dies with it. Three times on one node (08-17, 08-18, 08-21); nine
 * `claude` sessions on the worst of them.
 *
 * And it is self-inflicted: `idleInTransactionTimeoutMillis` ARMS Postgres to
 * terminate this exact client whenever a transaction stalls 30s. The one
 * failure the pool deliberately provokes was the one nothing caught.
 *
 * These tests drive the emitter directly rather than staging a real stall. What
 * killed the node was not the stall — a rejected query is ordinary and `tx()`
 * already rolls back and evicts — it was the unhandled EMIT. That is the thing
 * worth pinning, and a fake pool pins it deterministically in milliseconds.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { PgDb } from '../../src/db/client.js';

/** Postgres's own words on the 2026-08-21 crash. */
function idleInTransactionKill(): Error {
  return Object.assign(new Error('terminating connection due to idle-in-transaction timeout'), {
    code: '25P03', severity: 'FATAL', routine: 'ProcessInterrupts',
  });
}

/** A client that answers every statement and can be made to fail like pg does. */
class FakeClient extends EventEmitter {
  released = 0;
  readonly seen: string[] = [];
  query(sql: string): Promise<{ rows: unknown[] }> {
    this.seen.push(String(sql).trim().split(/\s+/)[0]!.toLowerCase());
    return Promise.resolve({ rows: [] });
  }
  release(): void { this.released += 1; }
}

/** A pool that hands out one client and records nothing else. */
function poolOver(client: FakeClient) {
  const pool = new EventEmitter() as EventEmitter & Record<string, unknown>;
  pool.connect = () => Promise.resolve(client);
  pool.end = () => Promise.resolve();
  return pool;
}

/** A `PgDb` over a fake pool — the constructor's own pool guard still applies. */
function dbOver(client: FakeClient): PgDb {
  const db = Object.create(PgDb.prototype) as PgDb & { pool: unknown; role: string };
  db.pool = poolOver(client);
  db.role = 'tm8_app';
  (db.pool as EventEmitter).on('error', () => {});
  return db;
}

const CLAIMS = { identityId: 'i', requestId: 'req_test' } as never;

describe('a checked-out client cannot take the process down', () => {
  it('absorbs the idle-in-transaction kill the pool itself arms Postgres to send', async () => {
    const client = new FakeClient();
    const db = dbOver(client);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    // Captured BEFORE restoring: `mockRestore` clears the call record as well as
    // the stub, so asserting after it always sees zero calls — which reads as
    // "the guard never logged" when the guard in fact did.
    let lines: string[] = [];

    try {
      await db.tx(CLAIMS, async () => {
        // Mid-transaction, exactly where Postgres kills a stalled one. Unguarded
        // this THROWS out of `emit` — which in the server is `throw er`, exit 1.
        expect(() => client.emit('error', idleInTransactionKill())).not.toThrow();
        return 'committed anyway';
      });
      lines = logged.mock.calls.map((call) => String(call[0]));
    } finally {
      logged.mockRestore();
    }

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('idle-in-transaction timeout');
    // It names the request, which is the only thing that identifies the caller
    // once the transaction is gone.
    expect(lines[0]).toContain('req_test');
  });

  it('leaves no listener on the client it hands back to the pool', async () => {
    // A pooled client is REUSED. A listener left attached accumulates one per
    // checkout until Node warns about a leak, and every past transaction adds a
    // duplicate line to the log for one failure.
    const client = new FakeClient();
    const db = dbOver(client);

    for (let i = 0; i < 5; i += 1) await db.tx(CLAIMS, async () => i);

    expect(client.listenerCount('error')).toBe(0);
    expect(client.released).toBe(5);
  });

  it('detaches even when the transaction throws, and still releases', async () => {
    const client = new FakeClient();
    const db = dbOver(client);

    await expect(db.tx(CLAIMS, async () => { throw new Error('caller blew up'); })).rejects.toThrow();

    expect(client.listenerCount('error')).toBe(0);
    expect(client.released).toBe(1);
    // Rolled back rather than committed — the guard must not have changed the
    // failure path it sits beside.
    expect(client.seen).toContain('rollback');
    expect(client.seen).not.toContain('commit');
  });
});
