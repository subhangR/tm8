/**
 * WIRE PROOF: the scheduler is actually constructed and started by the REAL
 * composition root, and the loops job is on it.
 *
 * This test exists because of a measurement, not a hypothesis. Before the
 * commit that added it, `createDefaultScheduler` was referenced in exactly two
 * places in the whole repository and both were doc comments — no production
 * path ever built a `Scheduler`, so the daily backup and all four retention
 * jobs had never run on any node, and the loop executor was on course to join
 * them. A feature can be fully implemented, fully migrated and fully unit
 * tested and still be dead code, and nothing in a per-module test suite
 * notices; only booting the real thing does.
 *
 * So this asserts against `bootstrap()` itself, never a re-implementation of
 * it: if someone deletes the wiring, this goes red. That is the entire job.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { LOOPS_JOB_NAME } from '../../src/scheduler/index.js';
import { startWsE2eNode, type WsE2eNode } from '../events/ws-e2e-harness.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 240_000 });

let node: WsE2eNode;

beforeAll(async () => {
  // Background jobs are opt-in at bootstrap (a scheduler started by every
  // scratch-DB harness and stopped by no one outlives its database); this file
  // exists to prove the wiring, so it opts in.
  node = await startWsE2eNode('scheduler_wired', { startBackgroundJobs: true });
});

afterAll(async () => {
  await node?.close();
});

describe('the R26 scheduler is wired into the composition root', () => {
  it('bootstrap() returns a RUNNING scheduler, not undefined', () => {
    // `undefined` is what every node returned before this was wired, and it is
    // the exact regression this file is here to catch.
    expect(node.production.scheduler).toBeDefined();
    expect(node.production.scheduler!.status().running).toBe(true);
  });

  it('registers the loops executor by name', () => {
    const names = node.production.scheduler!.status().jobs.map((job) => job.name);
    expect(names).toContain(LOOPS_JOB_NAME);
  });

  it('leaves the loops job idle-and-scheduled rather than mid-run at boot', () => {
    const loops = node.production.scheduler!
      .status().jobs.find((job) => job.name === LOOPS_JOB_NAME);
    expect(loops).toBeDefined();
    // `runOnStart` is false: a node must finish booting before it starts
    // spawning agent sessions, and a firing during boot would race ghost
    // reconciliation for the same session rows.
    expect(loops!.state).toBe('idle');
    expect(loops!.nextRunAt).not.toBeNull();
  });

  it('does NOT attach the daily backup — that is a separate operational call', () => {
    // No sidecar is passed at the composition root on purpose. Starting the
    // runner must not silently begin taking pg_dumps on nodes that have never
    // taken one; whoever owns backups decides that, not this feature.
    const names = node.production.scheduler!.status().jobs.map((job) => job.name);
    expect(names).not.toContain('sidecar.daily-backup');
  });

  it('stops cleanly, so shutdown cannot hang on a live timer', async () => {
    // The shutdown path awaits this. An unref'd timer that never clears reads
    // to an operator as a hang rather than the clean exit it nearly was.
    await node.production.scheduler!.stop();
    expect(node.production.scheduler!.status().running).toBe(false);
  });
});
