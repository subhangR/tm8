// @vitest-environment jsdom
/**
 * ONE TRANSIENT FAILURE MUST NOT STRAND A PANEL FOREVER.
 *
 * === WHY THIS FILE EXISTS ===
 *
 * The owner's production session recorded, for entity GETs alone:
 * 452 x 200, 23 x 499 (client aborted — the http client's own timeout guard),
 * 13 x 503, 3 x 404. The node was healthy for the overwhelming majority of
 * reads, and the detail panel still never rendered.
 *
 * `pull` claims a detail read BEFORE it awaits it:
 *
 *     if (needsDetail) pulledDetails.current.add(id);
 *     const [detail] = await Promise.all([seam.entity(id).catch(() => undefined), ...]);
 *
 * so when that read rejects, the id stays in `pulledDetails` with nothing in
 * `details`. `needsDetail` is then permanently false and `renderPanel` — which
 * calls `pull` FROM RENDER precisely because the detail is missing — can never
 * cause it to be read again. `loading={!detail}` stays true for the life of
 * the page. ONE 503 poisons ONE entity FOREVER.
 *
 * The guard itself is right: the comment above it correctly warns that CLEARING
 * it on failure turns an unreadable entity into an unbounded request loop
 * against the node. Both failure modes are real, and the fix has to refuse both
 * — retry a transient failure on a bounded budget, and never retry a FINAL
 * answer (404/403) at all.
 *
 * Entity LISTS survive the same 503 because `ensureKind` catches into an
 * honestly-empty `rows[kind::*]`, which a later query replaces. Only the detail
 * path claims-then-discards.
 *
 * === RED-FIRST RECORD (measured, not predicted) ===
 *
 * This exact file, run against HEAD's `useGateData.ts` (3838ee4, `pull`
 * re-arming nothing on failure), 2026-08-02:
 *
 *   npx vitest run src/views/detail-retry.test.tsx
 *    ×  a detail read that failed once is retried on the next render 6083ms
 *       AssertionError: a transient failure must not strand the panel: the node
 *       answered 200 on every later read: expected undefined to be defined
 *    Tests  1 failed | 2 passed (3)
 *
 * The other two pass RED for an uninteresting reason — HEAD never retries
 * anything, so "does not loop" and "a 404 is asked once" are trivially true of
 * the broken tree. They are here as the guard on the FIX: a naive "just clear
 * the guard on failure" makes the first green and both of them red.
 */
import { describe, expect, it } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { CollabError, type CollectionQuery, type DurableWorkspaceEvent, type EntityDetail, type EntitySummary, type SpaceId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { useGateData } from './useGateData';

const SPACE = 'spc-retry' as SpaceId;

function task(id: string, over: Partial<EntitySummary> = {}): EntitySummary {
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
    createdBy: { id: 'act-1', kind: 'member', displayName: 'me' } as EntitySummary['createdBy'],
    counters: { children: 0, comments: 0, reactions: 0, points: 0, messages: 0, viewerReaction: null },
    state: { kind: 'task', workStatus: 'open', priority: 'medium', axes: {}, assignees: [], acceptance: { total: 0, completed: 0 } },
    badges: {},
    ...over,
  } as EntitySummary;
}

/** The shape `seam.entity` answers with — a summary plus the heavy sections. */
function detailOf(summary: EntitySummary): EntityDetail {
  return {
    ...summary,
    content: { kind: 'task', body: 'the detail body' },
    hierarchy: { ancestors: [], children: [] },
    connections: { items: [], nextCursor: null, total: 0 },
    capabilities: {},
  } as unknown as EntityDetail;
}

interface Harness {
  seam: Seam;
  entityCalls: () => number;
  messageCalls: () => number;
  emit: (event: DurableWorkspaceEvent) => void;
}

/**
 * `entityFails` decides, per attempt, whether `seam.entity` rejects. A 503 is
 * modelled as the http client models it: a retryable `CollabError`, which is
 * exactly what a timeout-abort (the 499s) also throws.
 */
function harness(seeded: EntitySummary[], entityFails: (attempt: number) => boolean): Harness {
  const subs = new Set<(e: DurableWorkspaceEvent) => void>();
  let entityCalls = 0;
  let messageCalls = 0;

  const seam = {
    async openSpace() {},
    closeSpace() {},
    dispose() {},
    onEvent(cb: (e: DurableWorkspaceEvent) => void) {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
    onConnection() { return () => {}; },
    getConnection() { return { phase: 'live' as const }; },
    onResync() { return () => {}; },
    async identity() { throw new Error('not read by this test'); },
    async spaces() { return [{ id: SPACE, name: 'Retry', slug: 'retry' }] as never; },
    async menu() { return null; },
    async spaceSettings() { return { defaultInteractionProfileId: null } as never; },
    async projects() { return []; },
    async counts() {
      const out: Record<string, { total: number; unseen: number }> = {};
      for (const row of seeded) {
        const cell = out[row.kind] ?? { total: 0, unseen: 0 };
        cell.total += 1;
        cell.unseen += 1;
        out[row.kind] = cell;
      }
      return out as never;
    },
    async query(input: CollectionQuery) {
      const kinds = input.kinds ?? [];
      return { query: input, page: { items: seeded.filter((s) => kinds.includes(s.kind)), nextCursor: undefined } } as never;
    },
    async graph() { return { nodes: seeded, edges: [], clusters: [] }; },
    async entity(id: string) {
      entityCalls += 1;
      if (entityFails(entityCalls)) {
        throw new CollabError('upstream_unavailable', 'tm8 returned HTTP 503', {
          retryable: true,
          details: { httpStatus: 503 },
        });
      }
      const found = seeded.find((s) => s.id === id);
      if (!found) throw new CollabError('not_found', 'no such entity');
      return detailOf(found) as never;
    },
    async connections() { return { items: [], nextCursor: null, total: 0 } as never; },
    async messages() {
      messageCalls += 1;
      // Deliberately answers EMPTY. With a counter above zero this keeps the
      // thread permanently "stale", which is what lets a counter bump re-arm a
      // second read — the whole point of the decoupling assertion below.
      return { items: [], nextCursor: null, total: 0 } as never;
    },
    liveness: {
      async refresh() { return { spaceId: SPACE, liveEntityIds: [], nodeBootId: 'boot', checkedAt: '2026-08-01T10:00:00.000Z' }; },
      onChange() { return () => {}; },
      statusOf() { return 'unknown' as const; },
    },
    realControls: { setSessionSurfaceVisible() {} },
    commands: {},
  } as unknown as Seam;

  return {
    seam,
    entityCalls: () => entityCalls,
    messageCalls: () => messageCalls,
    emit: (event) => { for (const cb of subs) cb(event); },
  };
}

/** What `renderPanel`/`GraphScreen` do: call `pull` from render while the
    detail is missing. Modelled as repeated calls, which is what a re-rendering
    panel produces. */
async function renderPasses(
  pull: (id: string) => void,
  id: string,
  times: number,
  gapMs = 0,
): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      pull(id);
      await Promise.resolve();
    });
    // Renders are spread over time by events, counters and the pulse cadence.
    // A retry that is refused by its own backoff has not been abandoned.
    if (gapMs > 0) await act(async () => { await new Promise((r) => setTimeout(r, gapMs)); });
  }
}

describe('a detail read that fails is not abandoned forever', () => {
  it('does not duplicate a detail read while the first request is still in flight', async () => {
    const row = task('ent-slow');
    const h = harness([row], () => false);
    let resolveDetail: ((detail: EntityDetail) => void) | undefined;
    let calls = 0;
    Object.assign(h.seam, {
      entity: () => {
        calls += 1;
        return new Promise<EntityDetail>((resolve) => { resolveDetail = resolve; });
      },
    });
    const { result, rerender } = renderHook(() =>
      useGateData({ leftKind: 'task', rightKind: 'work_session', seam: h.seam }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    act(() => {
      for (let index = 0; index < 5; index += 1) result.current.pull?.(row.id);
    });
    rerender();
    act(() => result.current.pull?.(row.id));
    expect(calls).toBe(1);

    await act(async () => {
      resolveDetail?.(detailOf(row));
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.detailOf(row.id)).toBeDefined());
  });

  it('a detail read that failed once is retried on the next render', { timeout: 30_000 }, async () => {
    // Fails attempt 1 (the 503), healthy from attempt 2 — the owner's node.
    const h = harness([task('ent-poisoned')], (attempt) => attempt === 1);
    const { result } = renderHook(() =>
      useGateData({ leftKind: 'task', rightKind: 'work_session', seam: h.seam }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    // A served 503 takes the SLOW ladder on purpose (3s first step): the retry
    // is itself the load holding an overloaded node down. So the panel must
    // re-render across that window, which is what a mounted panel does.
    await renderPasses((id) => void result.current.pull?.(id), 'ent-poisoned', 5, 1_000);

    await waitFor(() => {
      expect(
        result.current.detailOf('ent-poisoned'),
        'a transient failure must not strand the panel: the node answered 200 on every later read',
      ).toBeDefined();
    });
  });

  it('a 404 is FINAL — the node answered, so it is not asked again', { timeout: 30_000 }, async () => {
    // `seeded` has no such id, so the harness throws not_found: the shape of
    // the 3 x 404 in the owner's log. A terminal answer must cost ONE request
    // no matter how many times the panel re-renders.
    const h = harness([task('ent-present')], () => false);
    const { result } = renderHook(() =>
      useGateData({ leftKind: 'task', rightKind: 'work_session', seam: h.seam }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    await renderPasses((id) => void result.current.pull?.(id), 'ent-missing', 5, 900);

    expect(result.current.detailOf('ent-missing')).toBeUndefined();
    expect(
      h.entityCalls(),
      'a 404 must not be retried: the node looked and told us',
    ).toBe(1);
  });

  it("a dead DETAIL does not silence that anchor's THREAD", { timeout: 30_000 }, async () => {
    // The budget is PER HALF. Detail and thread fail for different reasons, so
    // a 404 on the detail must not also stop this anchor's thread from ever
    // being re-read. The discriminating move is the counter bump AFTER the
    // detail has died: with one shared budget the second read is refused
    // before it is even claimed, so `messageCalls` stays at 1.
    const row = task('ent-dead-detail', {
      counters: { children: 0, comments: 0, reactions: 0, points: 0, messages: 1, viewerReaction: null },
    } as Partial<EntitySummary>);
    // The row exists as a SUMMARY (so the counter is readable) but the detail
    // read 404s — the shape of an entity the list can see and the detail cannot.
    const h = harness([row], () => false);
    (h.seam as unknown as { entity: (id: string) => Promise<unknown> }).entity = async () => {
      throw new CollabError('not_found', 'no such entity');
    };
    const { result } = renderHook(() =>
      useGateData({ leftKind: 'task', rightKind: 'work_session', seam: h.seam }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    await renderPasses((id) => void result.current.pull?.(id), row.id, 1, 300);
    const afterFirst = h.messageCalls();
    expect(afterFirst, 'the first pull reads the thread').toBeGreaterThan(0);

    // The node says this anchor gained a message. The thread is genuinely stale
    // now (the fake always answers empty), so the thread read must re-arm.
    act(() => {
      h.emit({
        type: 'entity.upsert',
        spaceId: SPACE,
        seq: 99,
        entity: {
          ...row,
          counters: { children: 0, comments: 0, reactions: 0, points: 0, messages: 2, viewerReaction: null },
        },
      } as unknown as DurableWorkspaceEvent);
    });

    await renderPasses((id) => void result.current.pull?.(id), row.id, 2, 300);

    expect(
      h.messageCalls(),
      "the thread must be re-read after the counter advanced — the detail's terminal 404 must not spend the thread's budget",
    ).toBeGreaterThan(afterFirst);
  });

  it('the retry is BOUNDED — an entity that never reads does not loop the node', { timeout: 30_000 }, async () => {
    // Never succeeds. This is the shape the existing comment warns about.
    const h = harness([task('ent-unreadable')], () => true);
    const { result } = renderHook(() =>
      useGateData({ leftKind: 'task', rightKind: 'work_session', seam: h.seam }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    await renderPasses((id) => void result.current.pull?.(id), 'ent-unreadable', 40);

    expect(result.current.detailOf('ent-unreadable')).toBeUndefined();
    expect(
      h.entityCalls(),
      '40 render passes must not become 40 requests — that is the unbounded loop the guard exists to prevent',
    ).toBeLessThanOrEqual(5);
  });
});
