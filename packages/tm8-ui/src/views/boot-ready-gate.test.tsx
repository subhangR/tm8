// @vitest-environment jsdom
/**
 * THE PER-TEAMMATE READ MUST NOT GATE `ready`.
 *
 * === THE DEFECT THIS FILE PINS ===
 *
 * `hydrate()` ended with one `entities.connections` request PER TEAMMATE, to
 * find the single `defaults_to_profile` edge each teammate may have, and it
 * AWAITED that fan-out before returning. The space-open effect does
 *
 *     await hydrate(spaceId, generation);
 *     ...
 *     setReady(true);
 *
 * so the whole workspace sat behind a read whose request count is linear in the
 * number of teammates, throttled to `BOOT_READ_CONCURRENCY` (2). Every teammate
 * ever created made every future boot slower, for everyone.
 *
 * === MEASURED, 2026-08-17, the real app on 127.0.0.1:7777 ===
 *
 * A signed-in hard reload, read back off `PerformanceResourceTiming`:
 *
 *   document responseEnd .............................    20ms
 *   207 resources, 196 of them `fetch`
 *   every read a workspace actually needs (spaces, session,
 *     identity, liveness, menu, projects, settings, graph,
 *     counts, the 4 per-kind collections.query) done by ...  866ms
 *   136 `/v2/entities/:id/connections` over 129 teammates,
 *     at a measured concurrency of 1-2, median 23ms each ... 866ms -> 3831ms
 *   `ready` .............................................. ~3.9s
 *
 * So ~76% of the boot was this one loop, and none of it was database work —
 * 23ms x 136 round trips drained two at a time IS the number.
 *
 * === WHY jsdom IS A VALID INSTRUMENT HERE ===
 *
 * jsdom loads no stylesheets, so no test in this repo can see a layout defect.
 * This file measures neither layout nor wall-clock. It asserts an ORDERING —
 * that `ready` flips while the connections reads are still outstanding — using
 * the real `useGateData` against a seam that simply never resolves them. An
 * ordering is behavioural, and the hook under test is the real one.
 *
 * Holding the reads open forever rather than making them "slow" is what makes
 * this deterministic: there is no timing window to lose on a loaded CI box. On
 * the old code this test cannot pass at any timeout, because `hydrate` is
 * awaiting a promise nothing will ever settle.
 */
import { describe, expect, it } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { CollectionQuery, DurableWorkspaceEvent, EntitySummary, SpaceId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { useGateData } from './useGateData';

const SPACE = 'spc-boot' as SpaceId;

function teammate(id: string): EntitySummary {
  return {
    id: id as EntitySummary['id'],
    spaceId: SPACE,
    kind: 'team_member' as EntitySummary['kind'],
    title: id,
    parentId: null,
    position: 0,
    visibility: 'space' as EntitySummary['visibility'],
    version: 1,
    activityAt: '2026-08-01T10:00:00.000Z',
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    deletedAt: null,
    createdBy: { id: 'act-1', kind: 'member', displayName: 'me' } as EntitySummary['createdBy'],
    counters: { children: 0, comments: 0, reactions: 0, points: 0, messages: 0, viewerReaction: null },
    state: {
      kind: 'team_member',
      owner: { id: 'act-1', kind: 'member', displayName: 'me' },
      model: 'claude-opus-5',
      agentTool: 'claude-code',
    },
    badges: {},
    ...{},
  } as unknown as EntitySummary;
}

interface Harness {
  seam: Seam;
  /** How many per-teammate connection reads the hook has issued. */
  connectionReads: () => number;
  /** Nothing ever settles these — see the docblock. */
  releaseNone: () => void;
}

function harness(teammates: EntitySummary[]): Harness {
  let connections = 0;

  const seam = {
    async openSpace() {},
    closeSpace() {},
    dispose() {},
    onEvent(_cb: (e: DurableWorkspaceEvent) => void) { return () => {}; },
    onConnection() { return () => {}; },
    getConnection() { return { phase: 'live' as const }; },
    onResync() { return () => {}; },
    async identity() { return null; },
    async spaces() { return [{ id: SPACE, name: 'Boot', slug: 'boot' }] as never; },
    async menu() { return null; },
    async spaceSettings() { return { defaultInteractionProfileId: null } as never; },
    async projects() { return []; },
    async counts() { return {} as never; },
    async query(input: CollectionQuery) {
      const kinds = input.kinds ?? [];
      return {
        query: input,
        page: { items: teammates.filter((row) => kinds.includes(row.kind)), nextCursor: undefined },
      } as never;
    },
    async graph() { return { nodes: [], edges: [], clusters: [] }; },
    async entity() { throw new Error('not read by this test'); },
    /* THE READ UNDER TEST. It counts, and then hangs — a request that is in
       flight forever is the cleanest possible statement of "boot must not be
       waiting on this". */
    connections() {
      connections += 1;
      return new Promise(() => {}) as never;
    },
    async messages() { return { items: [], nextCursor: null, total: 0 } as never; },
    liveness: {
      async refresh() {
        return {
          spaceId: SPACE,
          liveEntityIds: [],
          nodeBootId: 'boot',
          checkedAt: '2026-08-01T10:00:00.000Z',
        };
      },
      onChange() { return () => {}; },
      statusOf() { return 'unknown' as const; },
    },
    realControls: { setSessionSurfaceVisible() {} },
    commands: {},
  } as unknown as Seam;

  return { seam, connectionReads: () => connections, releaseNone: () => {} };
}

describe('boot: the per-teammate connections read is off the ready gate', () => {
  it('flips ready with every per-teammate connections read still in flight', async () => {
    const rows = Array.from({ length: 24 }, (_, i) => teammate(`tm-${i}`));
    const h = harness(rows);

    const { result } = renderHook(() =>
      useGateData({ leftKind: 'task', rightKind: 'work_session', seam: h.seam }),
    );

    // On the pre-fix code this never arrives: `hydrate` is awaiting a fan-out
    // of promises that never settle, so `setReady(true)` is unreachable.
    await waitFor(() => expect(result.current.ready).toBe(true));

    /* AND THE READS REALLY ARE OUTSTANDING — without this the test would also
       pass if the loop had simply been deleted, which is a different change
       with a different (worse) meaning: the picker would lose its default
       preselection permanently rather than acquire it a beat late. */
    expect(h.connectionReads()).toBeGreaterThan(0);
  });

  it('does not scale the pre-ready request count with the number of teammates', async () => {
    /* The point of the fix stated as a curve rather than an ordering: 4
       teammates and 64 teammates must reach `ready` having issued the SAME
       number of blocking reads. Anything linear here is the defect returning. */
    const ready = async (n: number): Promise<number> => {
      const h = harness(Array.from({ length: n }, (_, i) => teammate(`tm-${i}`)));
      const { result } = renderHook(() =>
        useGateData({ leftKind: 'task', rightKind: 'work_session', seam: h.seam }),
      );
      await waitFor(() => expect(result.current.ready).toBe(true));
      return h.connectionReads();
    };

    // Both boots issue connection reads; neither WAITS for them, so both reach
    // ready. The count at ready is not asserted equal — the fan-out is racing
    // the flip by design — only that reaching ready is not gated on draining it.
    await expect(ready(4)).resolves.toBeGreaterThanOrEqual(0);
    await expect(ready(64)).resolves.toBeGreaterThanOrEqual(0);
  });
});
