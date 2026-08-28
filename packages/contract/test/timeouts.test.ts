/**
 * The timeout budget (`src/timeouts.ts`).
 *
 * What is under test is not any single number — it is that the numbers stay in
 * ONE place with their reasons attached. They used to be set independently in
 * two packages with neither naming the other, which is how the client came to
 * give up at 15s while the server ran to 30s and nothing anywhere said so.
 *
 * Note what is deliberately NOT asserted: `connect + statement <= request`.
 * That invariant was written first and then disproved by measurement — it
 * forces a 10s statement ceiling, which kills legitimate work (20/20 passing
 * became 15/20 on `server/test/w3/g02-public.test.ts`, the five casualties
 * dying as SQLSTATE 57014). Abandoned work is bounded by CANCELLATION, not by
 * this arithmetic. A future editor who reintroduces the sum should expect that
 * suite to go red, and should read the header of `timeouts.ts` first.
 */
import { describe, expect, it } from 'vitest';
import {
  DB_CONNECT_TIMEOUT_MS,
  DB_IDLE_IN_TRANSACTION_TIMEOUT_MS,
  DB_STATEMENT_TIMEOUT_MS,
  REQUEST_TIMEOUT_MS,
} from '../src/index.js';

describe('the timeout budget', () => {
  it('keeps every ceiling positive and finite', () => {
    for (const ms of [
      REQUEST_TIMEOUT_MS,
      DB_CONNECT_TIMEOUT_MS,
      DB_STATEMENT_TIMEOUT_MS,
      DB_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    ]) {
      expect(Number.isFinite(ms)).toBe(true);
      expect(ms).toBeGreaterThan(0);
    }
  });

  /*
   * Waiting for a connection accomplishes nothing, so it must never be the
   * larger half of a request's wait. This is the one place the connect ceiling
   * IS bounded by the client's patience: a caller who cannot get a pooled
   * client should be told while they are still listening.
   */
  it('never spends most of a request waiting for a connection', () => {
    expect(DB_CONNECT_TIMEOUT_MS).toBeLessThan(REQUEST_TIMEOUT_MS / 2);
  });

  /*
   * The statement ceiling's job is the work with NO client waiting — see
   * `timeouts.ts`. It therefore has to outlast the request budget rather than
   * fit inside it; a ceiling shorter than a browser's patience would be sized
   * for a caller these cases do not have.
   */
  it('lets a statement outlast the request that may have been abandoned', () => {
    expect(DB_STATEMENT_TIMEOUT_MS).toBeGreaterThanOrEqual(REQUEST_TIMEOUT_MS);
  });

  /*
   * The floor that the disproved arithmetic breached. `REQUEST_TIMEOUT_MS -
   * DB_CONNECT_TIMEOUT_MS` is 10s, and 10s is measurably too tight; pinning the
   * ceiling above it is what stops that specific regression from being
   * reintroduced as a tidy-up.
   */
  it('keeps the statement ceiling clear of the 10s that killed real work', () => {
    expect(DB_STATEMENT_TIMEOUT_MS).toBeGreaterThan(REQUEST_TIMEOUT_MS - DB_CONNECT_TIMEOUT_MS);
  });

  /*
   * Different clock — measured from the last statement, not from the start of
   * the request. Asserted only to the extent that a transaction may not be
   * declared idle while a single statement of it is still legitimately running,
   * which would make the idle guard fire on healthy work.
   */
  it('cannot call a transaction idle while one statement may still be running', () => {
    expect(DB_IDLE_IN_TRANSACTION_TIMEOUT_MS).toBeGreaterThanOrEqual(DB_STATEMENT_TIMEOUT_MS);
  });
});
