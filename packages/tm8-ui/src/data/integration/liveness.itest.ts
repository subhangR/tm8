/**
 * ACCEPTANCE 6, second life: **`execution.liveness` EXISTS (catalog row A21,
 * Delta 2, commits dd41e89 + 194c64e) and the seam serves real liveness data.**
 *
 * This file's first life was `liveness-absent.itest.ts` — a SCHEDULED FAILURE
 * whose header carried its own disposition: when Delta 2 lands, the catalog
 * canary flips, the literal-path branch in `real/ops.ts` is deleted, and this
 * suite is rewritten against the live route. That is exactly what happened
 * (signal [SO->BRIDGE 32], ACK [BRIDGE->SO 33], 2026-07-28); the corpus rule —
 * a test that asserts a gap writes its disposition the day it is written —
 * completed its full arc here.
 *
 * What real data can and cannot prove on this node, stated honestly:
 *   - A REAL SNAPSHOT with the C-1 shape, claims-scoped, `nodeBootId` present:
 *     proven below.
 *   - 'stale' FROM REAL DATA: proven below — a fresh snapshot whose live set
 *     does not contain a recorded-running session is precisely the
 *     node-restarted case R-UI-5 exists for.
 *   - 'live' FROM REAL DATA requires a genuinely spawned PTY (work_session is
 *     born only from execution.spawn, which launches a real agent process).
 *     That belongs to the Phase-2 terminal-attach integration, where a real
 *     session exists anyway — NOT faked here with an injected id, because a
 *     fabricated live set would test the fabrication, not the read.
 *   - 'unknown' is still the answer BEFORE any snapshot arrives, and 'unknown'
 *     is never 'live' — the property that protects a user survives the route
 *     existing.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { isOperationName } from '@tm8/contract';

import {
  assertHarnessWiring,
  createSeamHarness,
  createSpace,
  createTask,
  startIntegrationNode,
  type IntegrationNode,
  type SeamHarness,
  type SpaceFixture,
} from './node-fixture';
import { LIVENESS_OP, livenessPath } from '../real/ops';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 240_000 });

describe('execution.liveness serves real data through the seam (real node, A21)', () => {
  let node: IntegrationNode;
  let space: SpaceFixture;
  let harness: SeamHarness;
  let taskId: string;

  beforeAll(async () => {
    assertHarnessWiring();
    node = await startIntegrationNode('liveness');
    space = await createSpace(node, 'b4 liveness');
    taskId = await createTask(node, space.spaceId, 'a task to ask liveness about');
    harness = createSeamHarness(node);
  });

  afterAll(async () => {
    harness?.dispose();
    await node?.close();
  });

  it('the catalog canary, retired honestly: the row exists and owns the path', () => {
    expect(isOperationName(LIVENESS_OP)).toBe(true);
    expect(livenessPath(space.spaceId)).toBe(
      `/v2/spaces/${space.spaceId}/execution/liveness`,
    );
  });

  it("statusOf answers 'unknown' BEFORE any snapshot — never 'live'", () => {
    // Order matters: this runs before the first refresh() below, pinning the
    // pre-snapshot honesty that survived from this file's first life.
    const answer = harness.seam.liveness.statusOf({ id: taskId, workStatus: 'running' });
    expect(answer, "no liveness evidence yet — the answer must be 'unknown'").toBe('unknown');
    expect(answer).not.toBe('live');
  });

  it('refresh() resolves a REAL C-1 snapshot: liveEntityIds, nodeBootId, checkedAt, stamped spaceId', async () => {
    const snap = await harness.seam.liveness.refresh(space.spaceId);
    expect(snap.spaceId).toBe(space.spaceId);
    expect(Array.isArray(snap.liveEntityIds)).toBe(true);
    // No PTY has ever been spawned on this scratch node: the honest live set
    // is EMPTY — a real measurement, not a default (the route answered).
    expect(snap.liveEntityIds).toEqual([]);
    expect(typeof snap.nodeBootId).toBe('string');
    expect(snap.nodeBootId.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(snap.checkedAt))).toBe(false);
  });

  it("statusOf answers 'stale' from REAL data: recorded-running + absent from a fresh live set", () => {
    // The R-UI-5 core case, now data-backed end-to-end: the snapshot above is
    // real and fresh, the session id is not in its live set, recorded status
    // says running — the ONLY honest answer is 'stale', never 'live'.
    const answer = harness.seam.liveness.statusOf({ id: taskId, workStatus: 'running' });
    expect(answer).toBe('stale');
    expect(answer).not.toBe('live');
  });

  it("statusOf answers 'not-running' from recorded status alone, no snapshot consulted", () => {
    // Unchanged from the first life: the classification that proves 'unknown'
    // and 'stale' are real distinctions rather than blanket fallbacks.
    for (const workStatus of ['done', 'cancelled', 'open', 'blocked', 'exited'] as const) {
      expect(harness.seam.liveness.statusOf({ id: taskId, workStatus })).toBe('not-running');
    }
    expect(harness.seam.liveness.statusOf({ id: taskId, workStatus: null })).toBe('not-running');
  });

  it('openSpace still resolves without awaiting the liveness read (LLD §16)', async () => {
    await expect(harness.seam.openSpace(space.spaceId)).resolves.toBeUndefined();
  });
});
