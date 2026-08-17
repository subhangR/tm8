// @vitest-environment jsdom
/**
 * THE PER-TEAMMATE DEFAULT MUST COST NO REQUEST.
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
 * === WHAT THE FIX IS, AND WHY THIS FILE ASSERTS ZERO RATHER THAN "LATER" ===
 *
 * The first cut simply detached the loop so it stopped gating `ready`. That was
 * worth ~3s and it was still N requests. The node now projects the answer onto
 * the row itself — `state.defaultProfileId`, assembled in the server's
 * `entity-read.ts` from the batch edge query `loadRelations` already runs for
 * the page — so the launch memo reads it off a summary boot had already
 * fetched. N requests became NONE.
 *
 * So the assertion here is `toBe(0)`, not an ordering. A test that only pinned
 * "ready comes first" would pass on the intermediate fix and quietly permit the
 * fan-out to return, still costing every teammate a round trip in the
 * background. Zero is the property worth defending.
 *
 * The seam's `connections` THROWS rather than returning empty, so a zero here
 * is evidence and not merely the absence of it.
 *
 * === WHY jsdom IS A VALID INSTRUMENT HERE ===
 *
 * jsdom loads no stylesheets, so no test in this repo can see a layout defect.
 * This file measures neither layout nor wall-clock. It COUNTS REQUESTS issued
 * by the real `useGateData` against a counting seam, and checks a value that
 * arrived on a row. Both are behavioural, and the hook under test is the real
 * one.
 */
import { describe, expect, it } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { CollectionQuery, DurableWorkspaceEvent, EntitySummary, SpaceId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { useGateData } from './useGateData';

const SPACE = 'spc-boot' as SpaceId;

function teammate(id: string, defaultProfileId: string | null): EntitySummary {
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
      // A model/agentTool pair the launch catalog actually knows: the memo
      // DROPS any teammate whose model is unsupported, so a placeholder here
      // would empty `launch.teammates` and make every assertion below vacuous.
      model: 'claude-opus-5',
      agentTool: 'claude-code',
      // The field under test. `null` is the honest shape for a teammate with
      // no default — see the contract note on `defaultProfileId`.
      defaultProfileId,
    },
    badges: {},
  } as unknown as EntitySummary;
}

interface Harness {
  seam: Seam;
  /** How many per-teammate connection reads the hook has issued. */
  connectionReads: () => number;
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
    /* THE READ THAT MUST NOT HAPPEN. It counts AND throws: a seam that quietly
       returned an empty page would let a reintroduced fan-out pass every
       assertion in this file while costing a round trip per teammate. */
    connections() {
      connections += 1;
      throw new Error('boot must not read connections per teammate');
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

  return { seam, connectionReads: () => connections };
}

describe('boot: the per-teammate default costs no request at all', () => {
  it('reaches ready without issuing a single entities.connections read', async () => {
    const rows = Array.from({ length: 24 }, (_, i) => teammate(`tm-${i}`, `prof-${i}`));
    const h = harness(rows);

    const { result } = renderHook(() =>
      useGateData({ leftKind: 'task', rightKind: 'work_session', seam: h.seam }),
    );

    await waitFor(() => expect(result.current.ready).toBe(true));

    /* THE WHOLE POINT. Before the projection this was 24 requests, awaited, at
       concurrency 2 — twelve serial waves before the workspace could open. The
       seam's `connections` impl throws if called, so a zero here is not the
       absence of evidence: any regression that reintroduces the fan-out fails
       loudly rather than quietly costing a second. */
    expect(h.connectionReads()).toBe(0);
  });

  it('carries each teammate default off the row the boot read already returned', async () => {
    const rows = [teammate('tm-a', 'prof-a'), teammate('tm-b', null), teammate('tm-c', 'prof-c')];
    const h = harness(rows);

    const { result } = renderHook(() =>
      useGateData({ leftKind: 'task', rightKind: 'work_session', seam: h.seam }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    const byId = new Map(result.current.launch.teammates.map((t) => [t.id, t.defaultProfileId]));
    expect(byId.get('tm-a')).toBe('prof-a');
    expect(byId.get('tm-c')).toBe('prof-c');
    /* ABSENT, NOT NULL, and that distinction is the field's contract: a
       teammate with no default of its own leaves the picker on the SPACE
       default rather than asserting a profile the node never named. */
    expect(byId.get('tm-b')).toBeUndefined();
    expect(h.connectionReads()).toBe(0);
  });

  it('does not scale the pre-ready request count with the number of teammates', async () => {
    /* The fix stated as a curve rather than an ordering: 4 teammates and 64
       teammates must reach `ready` having issued the SAME number of reads.
       Anything linear here is the defect returning. */
    const readsAtReady = async (n: number): Promise<number> => {
      const h = harness(Array.from({ length: n }, (_, i) => teammate(`tm-${i}`, `prof-${i}`)));
      const { result } = renderHook(() =>
        useGateData({ leftKind: 'task', rightKind: 'work_session', seam: h.seam }),
      );
      await waitFor(() => expect(result.current.ready).toBe(true));
      return h.connectionReads();
    };

    expect(await readsAtReady(4)).toBe(0);
    expect(await readsAtReady(64)).toBe(0);
  });
});
