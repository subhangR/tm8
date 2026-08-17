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
 * fast-path added in `connection.ts` for this lane), the cost of a reconnect has
 * to be known — a faster reconnect that multiplies the request count would be a
 * regression, not a fix.
 *
 * === WHY jsdom IS A VALID INSTRUMENT *HERE*, WHEN IT IS NOT FOR LAYOUT ===
 *
 * jsdom loads no stylesheets, so no test in this repo can see a layout or
 * overflow defect — that is why this lane's sibling lanes measure in a real
 * Chrome. This file measures neither. It counts REQUESTS ISSUED BY THE REAL
 * `useGateData` against a counting seam. Request counts are behavioural, not
 * visual, and the hook under test is the real one.
 *
 * === WHAT A RESYNC DOES ON MAIN ===
 *
 * `onResync` does NOT patch around the gap. It bumps `bootRevision`, which
 * re-runs the whole space-open effect — and that effect calls
 *
 *     domain.store.getState().reset();
 *
 * which discards `details`, `messagesByAnchor` and the graph indexes outright.
 * So every guard discussion is downstream of one fact: after a resync the detail
 * cache is EMPTY, `needsDetail` is true for everything, and each still-mounted
 * panel re-reads from the node. The guard sets are not the amplifier; the cache
 * reset is.
 *
 * === MEASURED, 2026-08-17, worktree off main @ 57443ee2 ===
 *
 *   entity GETs per resync, by number of entities whose detail was pulled:
 *       4 pulled  ->  4        12 pulled -> 12        24 pulled -> 24
 *       i.e. EXACTLY 1:1, linear, unbounded in the size of what the user
 *       has browsed. Threads re-read on the same 1:1 curve.
 *   fixed hydration fan-out, independent of that: menu + counts + graph +
 *       projects + settings + liveness + N collection queries.
 *   one permanently-unreadable entity, 8 resyncs x 40 render passes:
 *       [1,1,1,1,1,1,1,1]; the identical run with NO resync: [1,0,0,0,0,0,0,0].
 *       So a resync also hands back the retry budget — one extra GET per
 *       unreadable entity per resync.
 *
 * === WHAT THIS MEANS FOR THE FAST-PATH THIS LANE SHIPS ===
 *
 * The fast-path changes reconnect LATENCY, not resync FREQUENCY: `onResync`
 * fires on the `gapMs > resyncGapMs` test in `handleOpen`, and foregrounding
 * sooner cannot make a gap exceed ten minutes that would not have. So it does
 * not multiply the cost measured here — which is the question this lane was
 * required to settle before shipping it.
 *
 * It does mean the resync itself is expensive in a way a phone will feel, and
 * that is a REAL defect this file documents rather than fixes: the fix is
 * shared with desktop (re-pull only entities with an OPEN panel, or preserve
 * the detail cache across a resync and let the event stream correct it), and it
 * is the owner's call, not this lane's. The numbers are here so that call can be
 * made on evidence.
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
  /** Exactly what `connection.ts` does on a reconnect past `resyncGapMs`. */
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

/**
 * Boot, pull every seeded detail (a list the user has scrolled), then resync and
 * re-render every panel. Answers: how many entity GETs did that ONE resync cost?
 */
async function entityGetsPerResync(n: number): Promise<{ entity: number; messages: number }> {
  const seeded = Array.from({ length: n }, (_, i) => task(`ent-${i}`));
  const h = harness(seeded, () => false);
  const { result } = renderHook(() =>
    useGateData({ leftKind: 'task', rightKind: 'work_session', seam: h.seam }),
  );
  await waitFor(() => expect(result.current.ready).toBe(true));

  const ids = seeded.map((s) => s.id as string);
  await renderPasses((id) => void result.current.pull?.(id), ids, 2, 50);
  await waitFor(() => expect(result.current.detailOf('ent-0')).toBeDefined());

  const before = h.read();
  act(() => h.fireResync());
  await waitFor(() => expect(result.current.ready).toBe(true));
  // The phone is back: every mounted panel re-renders and calls `pull`.
  await renderPasses((id) => void result.current.pull?.(id), ids, 3, 50);
  const after = h.read();
  return { entity: after.entity - before.entity, messages: after.messages - before.messages };
}

describe('what a resync costs', () => {
  it('A. re-reads EVERY pulled detail, 1:1 — the cache reset, not the guards', { timeout: 60_000 }, async () => {
    const small = await entityGetsPerResync(4);
    const mid = await entityGetsPerResync(12);
    const large = await entityGetsPerResync(24);

    console.info(`[resync-cost A] entity GETs per resync — 4 pulled: ${small.entity}, 12 pulled: ${mid.entity}, 24 pulled: ${large.entity}`);
    console.info(`[resync-cost A] message GETs per resync — 4: ${small.messages}, 12: ${mid.messages}, 24: ${large.messages}`);

    // The headline: it is not a constant, it is the size of what the user browsed.
    expect(small.entity, 'every pulled detail is re-read after a resync').toBe(4);
    expect(mid.entity).toBe(12);
    expect(large.entity).toBe(24);
    // The property, not just three constants: the cost is LINEAR in the number
    // of pulled entities — 12 more browsed entities is 12 more GETs per resync.
    expect(large.entity - mid.entity, 'the cost scales 1:1 with what the user browsed').toBe(12);
  });

  it('B. a resync also hands an UNREADABLE entity a fresh retry budget', { timeout: 60_000 }, async () => {
    // The entity the node can never serve — the shape `pull`'s own comment warns
    // about. Within one resync epoch the budget bounds it (detail-retry.test
    // pins that). The question this lane must answer is what MANY resyncs cost,
    // which is what a backgrounding phone produces.
    const h = harness([task('ent-unreadable')], () => true);
    const { result } = renderHook(() =>
      useGateData({ leftKind: 'task', rightKind: 'work_session', seam: h.seam }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    const perEpoch: number[] = [];
    for (let epoch = 0; epoch < 8; epoch += 1) {
      const before = h.read();
      act(() => h.fireResync());
      await waitFor(() => expect(result.current.ready).toBe(true));
      await renderPasses((id) => void result.current.pull?.(id), ['ent-unreadable'], 40);
      perEpoch.push(h.read().entity - before.entity);
    }

    console.info('[resync-cost B] entity GETs per resync epoch, unreadable entity:', JSON.stringify(perEpoch));
    for (const n of perEpoch) {
      expect(n, 'the per-epoch bound must hold: 40 render passes are not 40 requests').toBeLessThanOrEqual(5);
    }
    expect(perEpoch.reduce((a, b) => a + b, 0), 'every resync buys at least one more attempt').toBeGreaterThanOrEqual(8);
  });

  it('B-control. WITHOUT a resync the same entity stops being asked about', { timeout: 60_000 }, async () => {
    // The control that makes B mean something. Identical to B except that no
    // resync is fired. If this also produced one GET per epoch, B would be
    // measuring the backoff ladder rather than the resync.
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
    expect(
      perEpoch.slice(2).reduce((a, b) => a + b, 0),
      'with no resync the budget is spent and stays spent — so B is measuring the resync, not the ladder',
    ).toBe(0);
  });

  it('C. the fixed hydration fan-out is paid in full on top of that', { timeout: 30_000 }, async () => {
    const seeded = Array.from({ length: 12 }, (_, i) => task(`ent-${i}`));
    const h = harness(seeded, () => false);
    const { result } = renderHook(() =>
      useGateData({ leftKind: 'task', rightKind: 'work_session', seam: h.seam }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    const before = h.read();
    act(() => h.fireResync());
    await waitFor(() => expect(h.read().menu).toBeGreaterThan(before.menu));
    await act(async () => { await new Promise((r) => setTimeout(r, 1_500)); });
    const after = h.read();

    console.info('[resync-cost C] fixed hydration cost of ONE resync:', JSON.stringify({
      query: after.query - before.query,
      menu: after.menu - before.menu,
      counts: after.counts - before.counts,
      graph: after.graph - before.graph,
      projects: after.projects - before.projects,
      settings: after.settings - before.settings,
      liveness: after.liveness - before.liveness,
    }));

    expect(after.menu - before.menu, 'hydrate re-reads the menu').toBe(1);
    expect(after.counts - before.counts, 'hydrate re-reads the rail counts').toBe(1);
    expect(after.query - before.query, 'hydrate re-runs the per-kind collection queries').toBeGreaterThan(0);
  });
});
