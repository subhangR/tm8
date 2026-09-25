/**
 * A QUEUED CHECKOUT THAT TIMED OUT IS POOL EXHAUSTION — SAY SO.
 *
 * pg-pool rejects a checkout that waited `connectionTimeoutMillis` in its queue
 * with a bare `Error('timeout exceeded when trying to connect')`
 * (pg-pool/index.js, the `pendingItem.timedOut` branch). No SQLSTATE, so it
 * used to reach the wire as the generic `internal server error` 503 — the text
 * a launch showed on prod while the pool sat at 32/32.
 *
 * The decision is made from the pool's state at checkout, never from the error
 * text, so a connect that failed WITHOUT queueing (database down, bad auth) is
 * the control: it must pass through untouched.
 */
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { CollabError } from '@tm8/contract';

import { DbPoolExhaustedError, PgDb } from '../../src/db/client.js';

interface PoolState { totalCount: number; idleCount: number; waitingCount: number }

/** Deadline for these fakes; the queue-timeout fake rejects just after it, as pg-pool does. */
const TIMEOUT_MS = 40;

function dbOverPool(state: PoolState, max: number, connectError: Error, rejectAfterMs = 0): PgDb {
  const pool = Object.assign(new EventEmitter(), state, {
    connect: () =>
      new Promise<never>((_, reject) => setTimeout(() => reject(connectError), rejectAfterMs)),
    end: () => Promise.resolve(),
  });
  const db = Object.create(PgDb.prototype) as PgDb & Record<string, unknown>;
  db.pool = pool;
  db.role = 'tm8_app';
  db.max = max;
  db.connectionTimeoutMillis = TIMEOUT_MS;
  return db;
}

const CLAIMS = { identityId: 'i', requestId: 'req_test' } as never;
/** pg-pool 3.x's own words for a queued checkout that gave up. */
const QUEUE_TIMEOUT = new Error('timeout exceeded when trying to connect');

describe('pool exhaustion is named, not reported as internal server error', () => {
  it('a checkout that found the pool full and then failed is db_pool_exhausted', async () => {
    const db = dbOverPool({ totalCount: 32, idleCount: 0, waitingCount: 7 }, 32, QUEUE_TIMEOUT, TIMEOUT_MS + 5);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = await db.tx(CLAIMS, async () => 'unreachable').catch((e: unknown) => e);
    const lines = logged.mock.calls.map((c) => String(c[0]));
    logged.mockRestore();

    expect(err).toBeInstanceOf(DbPoolExhaustedError);
    expect(err).toBeInstanceOf(CollabError);
    const collab = err as CollabError;
    expect(collab.code).toBe('upstream_unavailable');
    expect(collab.status).toBe(503);
    expect(collab.retryable).toBe(true);
    expect(collab.message).toMatch(/^database busy: no connection became free within \d+ms \(32\/32 in use, 7 waiting\)$/);
    expect(collab.details).toMatchObject({ reason: 'db_pool_exhausted', inUse: 32, max: 32, waiting: 7, retryAfterSeconds: 1 });
    // The node log names it too, with pg-pool's original text alongside.
    expect(lines.some((l) => l.includes('database busy') && l.includes('timeout exceeded when trying to connect'))).toBe(true);
  });

  it('control: a connect that failed WITHOUT queueing is rethrown untouched', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5442'), { code: 'ECONNREFUSED' });
    const db = dbOverPool({ totalCount: 3, idleCount: 0, waitingCount: 0 }, 32, refused);
    const err = await db.tx(CLAIMS, async () => 'unreachable').catch((e: unknown) => e);
    expect(err).toBe(refused);
  });

  it('control: an idle client available means no queue, so no exhaustion claim', async () => {
    const db = dbOverPool({ totalCount: 32, idleCount: 1, waitingCount: 0 }, 32, QUEUE_TIMEOUT);
    const err = await db.tx(CLAIMS, async () => 'unreachable').catch((e: unknown) => e);
    expect(err).toBe(QUEUE_TIMEOUT);
  });

  it('control: a queued checkout that failed FAST (Postgres restarting) is not exhaustion', async () => {
    // pg-pool hands a queued waiter a NEW client when a slot frees; if the
    // server is down that connect fails long before the acquire deadline.
    const restarting = Object.assign(new Error('the database system is starting up'), { code: '57P03' });
    // Fake timers (Date.now included) so a stalled event loop on a loaded host
    // cannot stretch the 1ms failure past the deadline and flake this control.
    vi.useFakeTimers();
    try {
      const db = dbOverPool({ totalCount: 32, idleCount: 0, waitingCount: 4 }, 32, restarting, 1);
      const pending = db.tx(CLAIMS, async () => 'unreachable').catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toBe(restarting);
    } finally {
      vi.useRealTimers();
    }
  });
});
