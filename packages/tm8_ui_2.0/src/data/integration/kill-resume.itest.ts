/**
 * ACCEPTANCE 2 (LLD §11): **kill the socket mid-stream — no loss, no duplicate
 * through the seam** — plus the honesty states the UI renders while it happens.
 *
 * The socket is severed from UNDERNEATH the client, by closing the platform
 * WebSocket the seam is holding (`SocketSpy.severLatest`). Deliberately not by
 * calling anything on the seam: `SocketHandle.close()` silences its own
 * handlers first, which is precisely the code path a real disconnect does NOT
 * take, and a test that used it would exercise a graceful hang-up while
 * claiming to exercise a network failure.
 *
 * The window is arranged so the POLL FALLBACK genuinely runs: reconnect backoff
 * is stretched and the poll cadence is tightened, so mutations committed while
 * the socket is down have to arrive over `events.poll` or not at all. That is
 * the LLD §6 claim under test — "the poll fallback feeds the same dispatch
 * path… WS and poll agree on one seq spine by construction rather than by
 * test" — and here it becomes by test as well.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  QUIET_MS,
  assertHarnessWiring,
  createSeamHarness,
  createSpace,
  createTask,
  expectQuiet,
  groundTruth,
  pollSpine,
  startIntegrationNode,
  waitFor,
  type IntegrationNode,
  type SeamHarness,
  type SpaceFixture,
} from './node-fixture';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 240_000 });

describe('socket severed mid-stream (real node)', () => {
  let node: IntegrationNode;
  let space: SpaceFixture;
  let harness: SeamHarness;

  beforeAll(async () => {
    assertHarnessWiring();
    node = await startIntegrationNode('kill_resume');
    space = await createSpace(node, 'b4 kill resume');
    harness = createSeamHarness(node, {
      connection: {
        // Long enough that the client is provably in `polling` — and provably
        // ADVANCING there — before the socket comes back.
        backoffBaseMs: 3_000,
        backoffMaxMs: 8_000,
        pollIntervalMs: 250,
        accelerateIntervalMs: 200,
        pollLimit: 200,
      },
    });
    await harness.seam.openSpace(space.spaceId);
  });

  afterAll(async () => {
    harness?.dispose();
    await node?.close();
  });

  it('loses nothing and duplicates nothing across a severed socket, and says so honestly while down', async () => {
    // ---- phase 1: live ------------------------------------------------------
    await createTask(node, space.spaceId, 'before-the-cut');
    const beforeTruth = groundTruth(node, space.spaceId, space.memberId, 0);
    const lastBefore = beforeTruth.visible[beforeTruth.visible.length - 1]!;
    await waitFor(
      () => harness.events.some((e) => e.seq === lastBefore),
      () => `waiting for pre-cut seq ${String(lastBefore)}; have [${harness.events.map((e) => e.seq).join(',')}]`,
    );
    expect(harness.seam.getConnection().phase).toBe('live');
    const cursorAtCut = harness.seam.realControls.cursorOf(space.spaceId);
    const countAtCut = harness.events.length;

    // ---- the cut ------------------------------------------------------------
    harness.spy.severLatest();
    await waitFor(
      () => harness.seam.getConnection().phase === 'polling',
      () => `phase is ${harness.seam.getConnection().phase}, expected polling after the socket was severed`,
    );

    // HONESTY: 'polling' is not 'offline'. HTTP is still answering, so the UI
    // must render degraded-but-advancing, never disconnected. The distinction
    // is decided by transport evidence, and here the transport is fine.
    const polling = harness.seam.getConnection();
    expect(polling.phase).toBe('polling');
    if (polling.phase === 'polling') {
      expect(Number.isNaN(Date.parse(polling.disconnectedSince)), 'disconnectedSince must be a real instant').toBe(false);
    }

    // ---- phase 2: mutations committed WHILE the socket is down -------------
    // These can only reach `seam.onEvent` through the events.poll fallback.
    await createTask(node, space.spaceId, 'during-the-outage-1');
    await createTask(node, space.spaceId, 'during-the-outage-2');
    const outageTruth = groundTruth(node, space.spaceId, space.memberId, cursorAtCut);
    expect(outageTruth.visible.length, 'the outage window must mint rows').toBeGreaterThan(0);
    const lastOutage = outageTruth.visible[outageTruth.visible.length - 1]!;

    await waitFor(
      () => harness.events.some((e) => e.seq === lastOutage),
      () => `poll fallback never delivered seq ${String(lastOutage)}; have [${harness.events.map((e) => e.seq).join(',')}]`,
    );
    // The positive control for "the fallback did the work": events arrived
    // while the phase was still `polling`. Without this, a fast reconnect could
    // deliver everything over WS and the fallback would be untested while the
    // suite stayed green.
    expect(
      harness.events.length,
      'no event arrived during the outage — the poll fallback was not exercised',
    ).toBeGreaterThan(countAtCut);

    // ---- phase 3: the socket comes back ------------------------------------
    await waitFor(
      () => harness.seam.getConnection().phase === 'live',
      () => `phase is ${harness.seam.getConnection().phase}, expected live after reconnect`,
      60_000,
    );
    expect(harness.spy.sockets.length, 'the client must have opened a SECOND socket').toBeGreaterThan(1);

    // ---- phase 4: live again ------------------------------------------------
    await createTask(node, space.spaceId, 'after-the-reconnect');
    const finalTruth = groundTruth(node, space.spaceId, space.memberId, 0);
    const lastFinal = finalTruth.visible[finalTruth.visible.length - 1]!;
    await waitFor(
      () => harness.events.some((e) => e.seq === lastFinal),
      () => `waiting for post-reconnect seq ${String(lastFinal)}; have [${harness.events.map((e) => e.seq).join(',')}]`,
    );
    await expectQuiet(harness.events, QUIET_MS);

    // ---- the two properties -------------------------------------------------
    const seqs = harness.events.map((e) => e.seq);

    // NO DUPLICATE. This is the sharp one: on reconnect the client re-resumes
    // from its cursor and the server replays, so the wire genuinely re-delivers
    // rows the poll fallback already applied. Every one of them must have been
    // dropped by the cursor law before reaching a consumer.
    expect(new Set(seqs).size, 'a duplicate seq reached seam.onEvent across the reconnect').toBe(seqs.length);
    expect([...seqs].sort((a, b) => a - b), 'seam.onEvent delivered out of seq order').toEqual(seqs);

    // NO LOSS. Against the table, not against another reader of the log.
    expect(seqs, 'the seam lost rows across the severed socket').toEqual(finalTruth.visible);

    // …and the poll route independently agrees, so the two transports still
    // describe one spine after all of that.
    const polled = await pollSpine(node, space.spaceId, 0);
    expect(harness.events.map((e): [number, string] => [e.seq, e.type])).toEqual(polled.spine);

    // ---- the honesty trace --------------------------------------------------
    // Exactly the states LLD §6/T4 allows, in the order they are reachable.
    // 'offline' must NOT appear: the node was reachable over HTTP throughout.
    expect(harness.phases.slice(0, 3)).toEqual(['live', 'polling', 'live']);
    expect(harness.phases, 'the seam reported offline while HTTP was answering').not.toContain('offline');
  });
});
