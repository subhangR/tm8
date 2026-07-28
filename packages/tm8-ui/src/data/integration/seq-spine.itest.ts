/**
 * ACCEPTANCE 1 (LLD §11): **WS and poll agree on the seq spine.**
 *
 * Drive mutations through the real node; collect what arrives at
 * `seam.onEvent` over a real WebSocket; walk `events.poll` to exhaustion over
 * raw HTTP from the same starting cursor; and compare BOTH against the
 * `workspace_events` table read by a superuser `psql` that touches nothing on
 * the delivery path.
 *
 * WHY THE TABLE IS IN THE COMPARISON AT ALL. WS-versus-poll on its own is a
 * check two instruments can pass while both truncating identically — and
 * identical truncation is exactly the W5 cursor-truncation class (9 rows
 * seeded, 3 returned, no error). The table is the seeded-count control that
 * neither instrument can influence.
 *
 * WHAT THIS SUITE CAN BE SATISFIED BY, stated so nobody has to guess: a spine
 * agreement over an EMPTY spine is vacuous, so `expect(spine.length)` carries a
 * floor everywhere, and the floor is derived from the table rather than
 * hard-coded to a number this file made up.
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

/**
 * Both knobs, at file top. They are independent, and a generous `beforeAll`
 * third argument covers NEITHER — the hook overrun in particular presents as an
 * UNNAMED file-level abort with every test reported as passing, which is the
 * worst possible failure shape for a suite whose job is to be believed.
 * The defaults are 5s test / 10s hook; this hook creates a database, applies 43
 * migrations, boots a composition root and later drops the database.
 */
vi.setConfig({ testTimeout: 180_000, hookTimeout: 240_000 });

describe('WS and poll agree on the seq spine (real node)', () => {
  let node: IntegrationNode;
  let space: SpaceFixture;
  let harness: SeamHarness;

  beforeAll(async () => {
    assertHarnessWiring();
    node = await startIntegrationNode('seq_spine');
    space = await createSpace(node, 'b4 seq spine');
  });

  afterAll(async () => {
    harness?.dispose();
    await node?.close();
  });

  it('replays history from seq 0 and then streams live, matching poll and the table exactly', async () => {
    // ---- history exists BEFORE the seam does --------------------------------
    // `openSpace` sends subscribe (which seeds at NOW and replays nothing) and
    // then ALWAYS resume{since: 0}. If the unconditional resume were ever
    // dropped, this history would simply never arrive — which is the whole
    // reason the client sends it unconditionally (LLD §6 fact 2).
    await createTask(node, space.spaceId, 'history-1');
    await createTask(node, space.spaceId, 'history-2');

    const historyTruth = groundTruth(node, space.spaceId, space.memberId, 0);
    expect(historyTruth.visible.length, 'fixture must produce history to replay').toBeGreaterThan(0);

    harness = createSeamHarness(node);
    await harness.seam.openSpace(space.spaceId);

    // ---- live mutations, one through the SEAM's own command path ------------
    const liveTitle = `live-${String(Date.now())}`;
    const created = await harness.seam.commands.createTask({
      spaceId: space.spaceId,
      title: liveTitle,
      clientMutationId: `cmid_seam_${String(Date.now())}`,
    });
    expect(created.patches.length, 'createTask must answer authoritative patches').toBeGreaterThan(0);
    await createTask(node, space.spaceId, 'live-raw-http');

    // ---- wait on the TABLE's account of the window, never on a sleep -------
    const truth = groundTruth(node, space.spaceId, space.memberId, 0);
    const lastVisible = truth.visible[truth.visible.length - 1]!;
    await waitFor(
      () => harness.events.some((e) => e.seq === lastVisible),
      () => `seam holds seqs [${harness.events.map((e) => e.seq).join(',')}], table's last visible is ${String(lastVisible)}`,
    );
    // One mutation mints several rows across pump ticks; let the tail drain
    // before taking the spine, or the comparison races the pump rather than
    // measuring it.
    await expectQuiet(harness.events, QUIET_MS);

    // ---- the three accounts ------------------------------------------------
    const wsSpine = harness.events.map((e): [number, string] => [e.seq, e.type]);
    const polled = await pollSpine(node, space.spaceId, 0);

    expect(wsSpine.length, 'a spine agreement over an empty spine proves nothing').toBeGreaterThan(3);
    expect(polled.pages, 'the poll walk must terminate on an empty page').toBeGreaterThan(0);

    // (1) WS === poll, on BOTH seq and type. Comparing seqs alone would pass a
    //     transposition or a substitution; a count would pass either.
    expect(wsSpine, 'WS and poll disagree on the seq spine').toEqual(polled.spine);

    // (2) …and both agree with the table. This is the control: it is the only
    //     one of the three that no instrument under test produced.
    expect(
      wsSpine.map(([seq]) => seq),
      'the wire does not carry every row the table holds for this member',
    ).toEqual(truth.visible);

    // (3) strictly increasing, no duplicates — the seam's own guarantee
    //     ("strictly increasing seq per space, no duplicates") stated as an
    //     assertion rather than as a comment in seam.ts.
    const seqs = wsSpine.map(([seq]) => seq);
    expect(new Set(seqs).size, 'a duplicate seq reached seam.onEvent').toBe(seqs.length);
    expect([...seqs].sort((a, b) => a - b), 'seam.onEvent delivered out of seq order').toEqual(seqs);

    // (4) the seam's own cursor is the high-water mark it dispatched.
    expect(harness.seam.realControls.cursorOf(space.spaceId)).toBe(seqs[seqs.length - 1]);

    // (5) the command's clientMutationId came back on the echo — the property
    //     the optimistic journal reconciles on (asserted in depth in
    //     optimistic-echo.test.ts; here it proves the seam did not strip it
    //     while assembling the spine).
    expect(
      harness.events.some((e) => e.clientMutationId !== undefined),
      'no event carried a clientMutationId — the optimistic echo path is not observable',
    ).toBe(true);

    // (6) the seam reached 'live', and the ONLY transport noise on the way is
    //     SECOND LIFE of this assertion (Delta 2, 2026-07-28): its first life
    //     tolerated exactly ONE noise context — 'execution.liveness', the
    //     background cadence read 404ing against a node with no A21 route
    //     (designed degradation, disposition in liveness.itest.ts). Delta 2
    //     landed the route, the read now SUCCEEDS, and the failure that
    //     brought you here was reality improving past the recorded
    //     expectation — the exact-set discipline working as designed.
    //
    //     The assertion remains an EXACT set, not a filter: 'events.poll'
    //     noise, a malformed frame, a throwing listener, a socket-factory
    //     failure — or a liveness REGRESSION re-introducing the 404 — would
    //     each change it, and each would be a real finding.
    expect(harness.seam.getConnection().phase).toBe('live');
    expect(harness.phases[harness.phases.length - 1]).toBe('live');
    expect(
      [...new Set(harness.errors.map((e) => e.context))].sort(),
      'unexpected transport noise on the way to live',
    ).toEqual([]);
  });

  it('poll from a mid-stream cursor returns exactly the tail the table holds after it', async () => {
    // Agreement "from 0" can hide a route that ignores `since` and always
    // answers the whole log. This asks the same question from the middle.
    const before = groundTruth(node, space.spaceId, space.memberId, 0);
    const mark = before.visible[Math.floor(before.visible.length / 2)]!;

    const tail = await pollSpine(node, space.spaceId, mark);
    const tailTruth = groundTruth(node, space.spaceId, space.memberId, mark);

    expect(tailTruth.visible.length, 'the mid-stream window must be non-empty').toBeGreaterThan(0);
    expect(tail.spine.map(([seq]) => seq), 'poll from a mid-stream cursor does not match the table').toEqual(
      tailTruth.visible,
    );
    // The positive control for the assertion above: the tail is genuinely
    // SHORTER than the whole spine, so "since was honoured" is measured rather
    // than assumed.
    expect(tail.spine.length).toBeLessThan(before.visible.length);
  });
});
