/**
 * Health-check-then-start — SIDECAR-PACKAGING.md §6.
 *
 * Two probes, in order, because they answer different questions:
 *   * `pg_isready`  — liveness: is the postmaster accepting connections at all?
 *   * `SELECT 1`    — readiness: can *we*, over *our* socket, as *our* role,
 *                     actually run a query? `pg_isready` can say yes a beat
 *                     before the database truly serves queries.
 *
 * Budget: 60 attempts × 250 ms ≈ 15 s, then `StartTimeout`. Never an unbounded
 * loop — a boot that hangs forever is worse than one that fails with a reason.
 */

import { createConnection } from 'node:net';

import { toolPath } from './binaries.js';
import { SidecarError } from './errors.js';
import { describeFailure, run, tail } from './exec.js';
import type { SidecarLogger } from './log.js';

export const HEALTH_ATTEMPTS = 60;
export const HEALTH_INTERVAL_MS = 250;

export interface ProbeTarget {
  readonly binariesDir: string;
  readonly socketDir: string;
  readonly pgPort: number;
  /** Maintenance database — always present after `initdb`. */
  readonly database: string;
  readonly user: string;
}

export interface ProbeOutcome {
  readonly ok: boolean;
  readonly detail: string;
}

/** Liveness probe over the data-dir socket. */
export async function pgIsReady(t: ProbeTarget): Promise<ProbeOutcome> {
  const r = await run(
    toolPath(t.binariesDir, 'pg_isready'),
    ['-h', t.socketDir, '-p', String(t.pgPort), '-d', t.database, '-U', t.user, '-t', '5'],
    { timeoutMs: 10_000 },
  );
  return { ok: r.ok, detail: r.ok ? tail(r.stdout, 2) : describeFailure(r) };
}

/**
 * Readiness probe.
 *
 * Implemented with `psql` so W1 needs no Node Postgres driver. When the facade
 * introduces the application connection pool at W2, swap a pool-backed probe in
 * through `waitForReady`'s `readiness` argument — the state machine does not
 * change.
 */
export async function selectOne(t: ProbeTarget): Promise<ProbeOutcome> {
  const r = await run(
    toolPath(t.binariesDir, 'psql'),
    [
      '-h', t.socketDir,
      '-p', String(t.pgPort),
      '-U', t.user,
      '-d', t.database,
      '-v', 'ON_ERROR_STOP=1',
      '-tAc', 'SELECT 1',
    ],
    { timeoutMs: 10_000 },
  );
  const ok = r.ok && r.stdout.trim() === '1';
  return { ok, detail: ok ? 'SELECT 1 → 1' : describeFailure(r) };
}

export type ReadinessProbe = (t: ProbeTarget) => Promise<ProbeOutcome>;

export interface WaitForReadyOptions {
  readonly attempts?: number;
  readonly intervalMs?: number;
  readonly logger?: SidecarLogger;
  /** Overridable for the W2 pool-backed probe and for tests. */
  readonly readiness?: ReadinessProbe;
  /** Extra context appended to `StartTimeout.detail` (postmaster log tail). */
  readonly onTimeoutDetail?: () => string | Promise<string>;
  readonly sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) =>
  new Promise<void>((r) => {
    setTimeout(r, ms).unref();
  });

/**
 * Poll until both probes pass.
 * @throws SidecarError `StartTimeout` when the budget is exhausted.
 */
export async function waitForReady(t: ProbeTarget, opts: WaitForReadyOptions = {}): Promise<void> {
  const attempts = opts.attempts ?? HEALTH_ATTEMPTS;
  const intervalMs = opts.intervalMs ?? HEALTH_INTERVAL_MS;
  const readiness = opts.readiness ?? selectOne;
  const sleep = opts.sleep ?? realSleep;
  let lastDetail = 'no probe ran';

  for (let i = 1; i <= attempts; i++) {
    const live = await pgIsReady(t);
    if (live.ok) {
      const ready = await readiness(t);
      if (ready.ok) {
        opts.logger?.debug(`health: ready after ${i} attempt(s)`);
        return;
      }
      lastDetail = `pg_isready ok, readiness failed: ${ready.detail}`;
    } else {
      lastDetail = live.detail;
    }
    if (i < attempts) await sleep(intervalMs);
  }

  const extra = opts.onTimeoutDetail ? await opts.onTimeoutDetail() : '';
  throw new SidecarError(
    'StartTimeout',
    `tm8: the sidecar Postgres did not become ready within ${(attempts * intervalMs) / 1000}s.`,
    { detail: extra ? `${lastDetail}\n---\n${extra}` : lastDetail },
  );
}

/**
 * Is anything listening on a loopback TCP port?
 *
 * Used for the `PortInUse` guard (§7) and, during crash reclaim, to confirm a
 * postmaster really is down before removing a stale lock.
 */
export function isTcpPortOpen(port: number, host = '127.0.0.1', timeoutMs = 750): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = createConnection({ port, host });
    const done = (open: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}
