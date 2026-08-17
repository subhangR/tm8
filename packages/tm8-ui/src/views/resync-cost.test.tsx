// @vitest-environment jsdom
/**
 * WHAT DOES A RESYNC ACTUALLY COST?  (Lane 6 — backgrounded-phone lifecycle)
 *
 * === WHY THIS FILE EXISTS ===
 *
 * `connection.ts` fires `onResync` whenever a reconnect closes a gap wider than
 * `resyncGapMs` (10 min). On a desktop tab that is rare. On a phone, ten minutes
 * backgrounded is NORMAL, so a phone PWA takes this path on a large fraction of
 * its foregrounds. Before making reconnects FASTER (the visibilitychange/online
 * fast-path this lane exists to add), the cost of a reconnect has to be known —
 * a faster reconnect that multiplies the request count is a regression.
 *
 * `useGateData`'s `onResync` handler clears three guards and re-runs hydration:
 *
 *     pulledDetails.current.clear();
 *     pulledMessages.current.clear();
 *     readFailures.current.clear();
 *     void hydrate(space);
 *
 * and `pull`'s own comments name the hazard that clearing creates — "renderPanel
 * calls pull FROM RENDER whenever the detail is missing, so clearing the guard
 * on failure turns one unreadable entity into an unbounded request loop".
 *
 * === WHY jsdom IS A VALID INSTRUMENT *HERE*, WHEN IT IS NOT FOR LAYOUT ===
 *
 * jsdom loads no stylesheets, so no test in this repo can see a layout or
 * overflow defect — that is why this lane's sibling lanes measure in a real
 * Chrome. But this file measures neither: it counts REQUESTS ISSUED BY THE REAL
 * `useGateData` against a counting seam. Request counts are behavioural, not
 * visual, and the hook under test is the real one. The number this file reports
 * is the number a phone pays.
 *
 * === MEASURED, 2026-08-17, base 238c10fa ===
 *
 * Reported by the `console.info` lines below (run this file to reproduce):
 *
 *   A. steady state, 12 entities cached, 12 panels pulled, 5 render passes:
 *      entity GETs per resync = 0        message GETs per resync = 0
 *      fixed cost = {query:4, menu:1, counts:1, graph:1, projects:1,
 *                    settings:1, liveness:1} = 10 requests, FLAT
 *   B. one PERMANENTLY unreadable entity, 8 resyncs, 40 render passes each:
 *      entity GETs per epoch = [1,1,1,1,1,1,1,1]  (8 total)
 *      B-control, identical but NO resync = [1,0,0,0,0,0,0,0]
 *      => the resync IS the re-armer, and it costs exactly ONE extra GET per
 *         unreadable entity per resync. Linear in resyncs, not unbounded.
 *   C. the same 10-request fan-out, confirmed in isolation.
 *
 * The headline is (A): clearing `pulledDetails`/`pulledMessages` re-fetches
 * NOTHING for an entity whose detail is cached, because `needsDetail` is
 * `details[id] === undefined && !pulledDetails.has(id)` — and `hydrate` does not
 * clear the store's `details` (only a SPACE SWITCH does, via `setRows({})`).
 * The guard sets are the second term of an AND whose first term is already
 * false. So the widely-feared "resync re-pulls every open detail" does NOT
 * happen, and `onResync` clearing the detail guards is NOT the amplifier it
 * looks like. It should be left exactly as it is.
 *
 * The real per-resync cost is the fixed hydration fan-out: 10 requests, FLAT in
 * the number of entities and open panels. The only entity-proportional term is
 * (B) — `readFailures.current.clear()` handing back the retry budget — and it
 * is one GET per UNREADABLE entity per resync, which on a healthy node is zero.
 *
 * CONCLUSION FOR THIS LANE: a faster reconnect does not multiply reads through
 * this path, so the visibilitychange/online fast-path is safe to add on this
 * evidence. It does NOT license removing the backoff — see the socket-level
 * guard in `connection.ts`, where the cost of a faster reconnect actually lives.
 */
import { describe, expect, it } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { CollabError, type CollectionQuery, type DurableWorkspaceEvent, type EntityDetail, type EntitySummary, type SpaceId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { useGateData } from './useGateData';

const SPACE = 'spc-resync' as SpaceId;

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

function detailOf(summary: EntitySummary): EntityDetail {
  return {
    ...summary,
    content: { kind: 'task', body: 'the detail body' },
    hierarchy: { ancestors: [], children: [] },
    connections: { items: [], nextCursor: null, total: 0 },
    capabilities: {},
  } as unknown as EntityDetail;
}

/** Every read the hook can issue, counted separately. */
interface Counts {
  entity: number;
  messages: number;
  query: number;
  menu: number;
  counts: number;
  graph: number;
  projects: number;
  settings: number;
  liveness: number;
}

interface Harness {
  seam: Seam;
  read: () => Counts;
  /** What `connection.ts` does on a reconnect past `resyncGapMs`. */
  fireResync: () => void;
  emit: (event: DurableWorkspaceEvent) => void;
}

function harness(seeded: EntitySummary[], entityFails: (attempt: number) => boolean): Harness {
  const subs = new Set<(e: DurableWorkspaceEvent) => void>();
  const resyncSubs = new Set<(s: SpaceId) => void>();
  const c: Counts = {
    entity: 0, messages: 0, query: 0, menu: 0, counts: 0,
    graph: 0, projects: 0, settings: 0, liveness: 0,
  };

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
    onResync(cb: (s: SpaceId) => void) {
      resyncSubs.add(cb);
      return () => void resyncSubs.delete(cb);
    },
    async identity() { throw new Error('not read by this test'); },
    async spaces() { return [{ id: SPACE, name: 'Resync', slug: 'resync' }] as never; },
    async menu() { c.menu += 1; return null; },
    async spaceSettings() { c.settings += 1; return { defaultInteractionProfileId: null } as never; },
    async projects() { c.projects += 1; return []; },
    async counts() {
      c.counts += 1;
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
      c.query += 1;
      const kinds = input.kinds ?? [];
      return { query: input, page: { items: seeded.filter((s) => kinds.includes(s.kind)), nextCursor: undefined } } as never;
    },
    async graph() { c.graph += 1; return { nodes: seeded, edges: [], clusters: [] }; },
    async entity(id: string) {
      c.entity += 1;
      if (entityFails(c.entity)) {
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
      c.messages += 1;
      return { items: [], nextCursor: null, total: 0 } as never;
    },
    liveness: {
      async refresh() {
        c.liveness += 1;
        return { spaceId: SPACE, liveEntityIds: [], nodeBootId: 'boot', checkedAt: '2026-08-01T10:00:00.000Z' };
      },
      onChange() { return () => {}; },
      statusOf() { return 'unknown' as const; },
    },
    realControls: { setSessionSurfaceVisible() {} },
    commands: {},
  } as unknown as Seam;

  return {
    seam,
    read: () => ({ ...c }),
    fireResync: () => { for (const cb of resyncSubs) cb(SPACE); },
    emit: (event) => { for (const cb of subs) cb(event); },
  };
}

async function renderPasses(
  pull: (id: string) => void,
  ids: string[],
  times: number,
  gapMs = 0,
): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      for (const id of ids) pull(id);
      await Promise.resolve();
    });
    if (gapMs > 0) await act(async () => { await new Promise((r) => setTimeout(r, gapMs)); });
  }
}

function delta(before: Counts, after: Counts): Counts {
  return {
    entity: after.entity - before.entity,
    messages: after.messages - before.messages,
    query: after.query - before.query,
    menu: after.menu - before.menu,
    counts: after.counts - before.counts,
    graph: after.graph - before.graph,
    projects: after.projects - before.projects,
    settings: after.settings - before.settings,
    liveness: after.liveness - before.liveness,
  };
}

describe('what a resync costs', () => {
  it('A. a resync re-fetches NO detail and NO thread that is already cached', { timeout: 30_000 }, async () => {
    // Twelve entities, all readable — the steady state of a phone that has been
    // scrolling a list and has one panel open.
    const seeded = Array.from({ length: 12 }, (_, i) => task(`ent-${i}`));
    const h = harness(seeded, () => false);
    const { result } = renderHook(() =>
      useGateData({ leftKind: 'task', rightKind: 'work_session', seam: h.seam }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    // Cache every detail, the way a list that has been scrolled does.
    const ids = seeded.map((s) => s.id as string);
    await renderPasses((id) => void result.current.pull?.(id), ids, 2, 50);
    await waitFor(() => expect(result.current.detailOf('ent-0')).toBeDefined());

    const before = h.read();
    act(() => h.fireResync());
    // The phone foregrounds: every mounted panel re-renders and calls `pull`.
    await renderPasses((id) => void result.current.pull?.(id), ids, 5, 50);
    const after = h.read();
    const d = delta(before, after);

    console.info('[resync-cost A] cached steady state, 12 entities:', JSON.stringify(d));

    expect(
      d.entity,
      'clearing pulledDetails must not re-fetch a detail the store still has: needsDetail ANDs on details[id] === undefined',
    ).toBe(0);
    expect(
      d.messages,
      'clearing pulledMessages must not re-fetch a thread that is not stale',
    ).toBe(0);
  });

  it('B. a resync hands an UNREADABLE entity a fresh retry budget, every time', { timeout: 60_000 }, async () => {
    // The entity the node can never serve — the shape `pull`'s comment warns
    // about. Within one resync epoch the budget bounds it (detail-retry.test
    // pins <= 5). The question this lane must answer is what happens across
    // MANY resyncs, which is what a backgrounding phone produces.
    const h = harness([task('ent-unreadable')], () => true);
    const { result } = renderHook(() =>
      useGateData({ leftKind: 'task', rightKind: 'work_session', seam: h.seam }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    const perEpoch: number[] = [];
    for (let epoch = 0; epoch < 8; epoch += 1) {
      const before = h.read();
      act(() => h.fireResync());
      await renderPasses((id) => void result.current.pull?.(id), ['ent-unreadable'], 40);
      perEpoch.push(h.read().entity - before.entity);
    }

    console.info('[resync-cost B] entity GETs per resync epoch, unreadable entity:', JSON.stringify(perEpoch));

    // Each epoch stays bounded — the budget still works WITHIN an epoch.
    for (const n of perEpoch) {
      expect(n, 'the per-epoch bound must hold: 40 render passes are not 40 requests').toBeLessThanOrEqual(5);
    }
    // ...but the budget is REFRESHED by each resync, so the cost is linear in
    // the number of resyncs. That is the amplification a phone pays.
    const total = perEpoch.reduce((a, b) => a + b, 0);
    console.info('[resync-cost B] total entity GETs across 8 resyncs:', total);
    expect(total, 'documents the measured amplification, not an aspiration').toBeGreaterThan(0);
  });

  it('B-control. WITHOUT a resync the same entity stops being asked about', { timeout: 60_000 }, async () => {
    // The control that makes B's claim mean something. Identical to B in every
    // way except that no resync is fired. If this also produced one GET per
    // epoch, B would be measuring the backoff ladder rather than the resync.
    const h = harness([task('ent-unreadable')], () => true);
    const { result } = renderHook(() =>
      useGateData({ leftKind: 'task', rightKind: 'work_session', seam: h.seam }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    const perEpoch: number[] = [];
    for (let epoch = 0; epoch < 8; epoch += 1) {
      const before = h.read();
      await renderPasses((id) => void result.current.pull?.(id), ['ent-unreadable'], 40);
      perEpoch.push(h.read().entity - before.entity);
    }

    console.info('[resync-cost B-control] entity GETs per epoch, NO resync:', JSON.stringify(perEpoch));
    const tail = perEpoch.slice(2).reduce((a, b) => a + b, 0);
    expect(
      tail,
      'with no resync the budget is spent and stays spent — so B is measuring the resync, not the ladder',
    ).toBe(0);
  });

  it('C. the fixed hydration fan-out is paid in full on every resync', { timeout: 30_000 }, async () => {
    const seeded = Array.from({ length: 12 }, (_, i) => task(`ent-${i}`));
    const h = harness(seeded, () => false);
    const { result } = renderHook(() =>
      useGateData({ leftKind: 'task', rightKind: 'work_session', seam: h.seam }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    const before = h.read();
    act(() => h.fireResync());
    await waitFor(() => expect(h.read().menu).toBeGreaterThan(before.menu));
    // Let the bounded per-kind loads drain.
    await act(async () => { await new Promise((r) => setTimeout(r, 1_500)); });
    const d = delta(before, h.read());

    console.info('[resync-cost C] fixed hydration cost of ONE resync:', JSON.stringify(d));

    expect(d.menu, 'hydrate re-reads the menu').toBe(1);
    expect(d.counts, 'hydrate re-reads the rail counts').toBe(1);
    expect(d.query, 'hydrate re-runs the per-kind collection queries').toBeGreaterThan(0);
  });
});
