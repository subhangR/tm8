// The delivery pool arms `idle_in_transaction_session_timeout: 30_000` on
// itself, so Postgres terminating a wedged delivery transaction is not an
// anomaly — it is the design working. That termination arrives as SQLSTATE
// 25P03 on an `error` event on the pool, and an unhandled `error` on an
// EventEmitter is rethrown: `throw er`, exit 1.
//
// On a live installation this took the whole node down three times — 2026-08-17
// 07:07, 08-18 18:39 and 08-20 12:01 — and each restart SIGKILLed every running
// agent session with it (nine claude processes on the last one). A node that
// arms a timeout on itself and then dies of it cannot stay up under its own
// design, so this is a regression worth pinning rather than a defensive extra.
//
// The test emits the real thing on a caller-supplied pool. Without the guard in
// the constructor the `emit` below throws synchronously, which is exactly the
// production failure; with it, the pool discards the broken client and the
// process lives.

import { EventEmitter } from 'node:events';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';

import { PgW2DeliveryRpcPort } from '../src/facade/services/w2/execution.js';

/** What Postgres actually sent, verbatim, on the 2026-08-20 crash. */
function idleInTransactionKill(): Error {
  return Object.assign(new Error('terminating connection due to idle-in-transaction timeout'), {
    code: '25P03',
    severity: 'FATAL',
    routine: 'ProcessInterrupts',
  });
}

describe('PgW2DeliveryRpcPort — the pool error guard', () => {
  it('survives the idle-in-transaction kill it arms Postgres to perform', () => {
    const pool = new EventEmitter();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      new PgW2DeliveryRpcPort(pool as unknown as Pool);

      expect(() => pool.emit('error', idleInTransactionKill())).not.toThrow();
      expect(logged).toHaveBeenCalledTimes(1);
      expect(String(logged.mock.calls[0]?.[0])).toContain('idle-in-transaction timeout');
    } finally {
      logged.mockRestore();
    }
  });

  it('guards a pool it did not build, so no future call site can reopen the hole', () => {
    // `fromConnectionString` is not the only way in — the constructor is public
    // and takes a pool. Guarding beside the `new Pool` would leave this path
    // unlistened, so the assertion is on construction, not on the factory.
    const pool = new EventEmitter();
    new PgW2DeliveryRpcPort(pool as unknown as Pool, false);

    expect(pool.listenerCount('error')).toBe(1);
  });

  it('stays alive across repeated kills, because the pool discards each client', () => {
    const pool = new EventEmitter();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      new PgW2DeliveryRpcPort(pool as unknown as Pool);

      for (let i = 0; i < 3; i += 1) {
        expect(() => pool.emit('error', idleInTransactionKill())).not.toThrow();
      }
      expect(logged).toHaveBeenCalledTimes(3);
    } finally {
      logged.mockRestore();
    }
  });
});
