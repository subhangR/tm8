// @vitest-environment jsdom
/**
 * SPAWNING A SESSION MUST MAKE THE ANCHOR'S RUNS APPEAR — proved by execution.
 *
 * === WHAT WAS BROKEN ===
 *
 * `execution.spawn` writes a `working_on` edge from the new session to every id
 * in `taskIds`. That edge is a CONNECTION OF THE ANCHOR, and `SubtreeBody`
 * derives its RUNS region from `detail.connections` — which is a SNAPSHOT taken
 * when the detail was read, not a live projection (`files/model.ts` states the
 * same rule for attachments, and states why the live edge family is the wrong
 * source: it only ever upserts, so it can never lose an edge).
 *
 * `spawn` ingested the command result's `patches` and the new session's own
 * detail, and stopped. Neither touches the ANCHOR's snapshot:
 *
 *   · `patches` carries SUMMARIES, and a summary has no `connections`;
 *   · `pull(anchor)` early-returns, because an open panel's detail is cached by
 *     definition — that is the whole reason `refetchDetail` exists;
 *   · no durable event invalidates a cached detail.
 *
 * So the panel you launched FROM went on rendering "RUNS · 0 / no runs recorded"
 * against a run that existed in the graph, until a full browser reload. The
 * `working_on` edge was written correctly the whole time — the defect was that
 * nothing re-read the anchor.
 *
 * The assertion below is deliberately about `detailOf`, not `connectionsOf`:
 * the snapshot is what the RUNS region reads, so a fix that only advanced the
 * live projection would leave the reported symptom exactly where it was.
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type {
  CollectionQuery,
  EntityDetail,
  EntityId,
  EntitySummary,
  ExecutionSpawnInput,
  SpaceId,
} from '@tm8/contract';
import type { Seam } from '../data/seam';
import { useGateData } from './useGateData';

const SPACE = 'spc-spawn' as SpaceId;
const TASK = 'ent-task' as EntityId;
const SESSION = 'ent-session' as EntityId;

function summary(id: string, over: Partial<EntitySummary> = {}): EntitySummary {
  return {
    id: id as EntitySummary['id'],
    spaceId: SPACE,
    kind: 'task' as EntitySummary['kind'],
    title: id,
    parentId: null,
    position: 0,
    visibility: 'space' as EntitySummary['visibility'],
    version: 1,
    activityAt: '2026-08-01T10:00:00.000Z',
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    deletedAt: null,
    createdBy: { id: 'act-1', kind: 'member', displayName: 'me', isAgent: false } as EntitySummary['createdBy'],
    counters: { children: 0, comments: 0, reactions: 0, points: 0, messages: 0, viewerReaction: null },
    state: {
      kind: 'task',
      workStatus: 'open',
      priority: 'medium',
      axes: {},
      assignees: [],
      acceptance: { total: 0, completed: 0 },
    },
    badges: {},
    ...over,
  } as EntitySummary;
}

const sessionSummary = summary(SESSION, {
  kind: 'work_session' as EntitySummary['kind'],
  state: { kind: 'work_session', status: 'running', sessionKind: 'agent', shareMode: 'none' },
} as Partial<EntitySummary>);

/** The anchor's detail, with the `working_on` run edge present or absent. */
function taskDetail(withRun: boolean): EntityDetail {
  const anchor = summary(TASK);
  return {
    ...anchor,
    content: { kind: 'task', body: '' },
    hierarchy: { parent: null, children: { items: [], nextCursor: null }, path: [] },
    connections: {
      outgoing: [],
      incoming: withRun
        ? [{
            type: 'working_on',
            direction: 'incoming',
            label: 'working_on (incoming)',
            edges: [{
              id: 'edge-working-on',
              type: 'working_on',
              source: sessionSummary,
              target: anchor,
              props: {},
              createdBy: anchor.createdBy,
              createdAt: '2026-08-01T10:00:00.000Z',
              updatedAt: '2026-08-01T10:00:00.000Z',
            }],
          }]
        : [],
      unresolvedHardDependencyCount: 0,
    },
    capabilities: {},
  } as unknown as EntityDetail;
}

function harness() {
  /* The server state the reads answer from: before spawn there is no run, and
     `commands.spawn` flips it exactly as the node's own write would. */
  let spawned = false;
  const rows = [summary(TASK)];

  const seam = {
    async openSpace() {},
    closeSpace() {},
    dispose() {},
    onEvent() { return () => {}; },
    onConnection() { return () => {}; },
    getConnection() { return { phase: 'live' as const }; },
    onResync() { return () => {}; },
    async identity() { throw new Error('not read by this test'); },
    async spaces() { return [{ id: SPACE, name: 'Spawn', slug: 'spawn' }] as never; },
    async menu() { return null; },
    async spaceSettings() { return { defaultInteractionProfileId: null } as never; },
    async projects() { return []; },
    async counts() { return {} as never; },
    async query(input: CollectionQuery) {
      const kinds = input.kinds ?? [];
      return {
        query: input,
        page: { items: rows.filter((r) => kinds.includes(r.kind)), nextCursor: undefined },
      } as never;
    },
    async graph() { return { nodes: rows, edges: [], clusters: [] }; },
    async entity(id: string) {
      if (id !== TASK) throw new Error(`unexpected read of ${id}`);
      return taskDetail(spawned) as never;
    },
    async connections() { return { items: [], nextCursor: null, total: 0 } as never; },
    async messages() { return { items: [], nextCursor: null, total: 0 } as never; },
    liveness: {
      async refresh() {
        return { spaceId: SPACE, liveEntityIds: [], nodeBootId: 'boot', checkedAt: '2026-08-01T10:00:00.000Z' };
      },
      onChange() { return () => {}; },
      statusOf() { return 'unknown' as const; },
    },
    realControls: { setSessionSurfaceVisible() {} },
    commands: {
      async spawn() {
        spawned = true;
        // Summaries only — exactly what the node returns, and exactly why this
        // result cannot repair the anchor's connections on its own.
        return { patches: [sessionSummary], entity: undefined } as never;
      },
    },
  } as unknown as Seam;

  return { seam };
}

function pull(data: ReturnType<typeof useGateData>, id: string): void {
  (data as ReturnType<typeof useGateData> & { pull(id: string): void }).pull(id);
}

describe('spawn refreshes the anchor it launched from', () => {
  it('lands the new run on the anchor detail the RUNS region reads', async () => {
    const h = harness();
    const { result } = renderHook(() =>
      useGateData({ leftKind: 'task', rightKind: 'work_session', seam: h.seam }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    // The panel is open: its detail is cached, which is what makes `pull` a
    // no-op for the rest of this test.
    await act(async () => { pull(result.current, TASK); await Promise.resolve(); });
    await waitFor(() => expect(result.current.detailOf(TASK)).toBeDefined());
    expect(result.current.detailOf(TASK)?.connections.incoming).toHaveLength(0);

    await act(async () => {
      await result.current.spawn({
        clientMutationId: 'mut-1',
        spaceId: SPACE,
        teamMemberId: 'ent-teammate' as EntityId,
        taskIds: [TASK],
      } as ExecutionSpawnInput);
    });

    await waitFor(() => {
      const runs = result.current
        .detailOf(TASK)
        ?.connections.incoming.find((group) => group.type === 'working_on');
      expect(
        runs?.edges.map((edge) => edge.source.id),
        'the anchor must be re-read after spawn — its connections are a snapshot, ' +
          'and the RUNS region has no other source',
      ).toEqual([SESSION]);
    });
  });
});
