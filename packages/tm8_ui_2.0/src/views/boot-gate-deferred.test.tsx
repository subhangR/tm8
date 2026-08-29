// @vitest-environment jsdom
/**
 * SIX READS THAT FIRST PAINT DOES NOT NEED MUST NOT HOLD THE WORKSPACE SHUT.
 *
 * === THE DEFECT THIS FILE PINS ===
 *
 * `hydrate()` awaited eleven reads and the space-open effect does
 *
 *     await hydrate(spaceId, generation);
 *     ...
 *     setReady(true);
 *
 * so every one of them gated first paint. Four of those reads carry comments
 * in `useGateData.ts` itself saying they are an ENHANCEMENT that must never
 * cost the boot — `spaces.counts` ("the counters failing must never cost the
 * boot"), `identity` ("an enhancement to boot, not an availability gate"),
 * `menu`, and liveness — and were then `await`ed inside the `Promise.all` that
 * gates `ready`. FAILING them cost the boot nothing. SUCCEEDING SLOWLY cost it
 * up to a second. The code already knew the right answer and did the other
 * thing.
 *
 * Two more are `collections.query` at `MAX_COLLECTION_LIMIT` for `team_member`
 * and `interaction_profile`: the complete option sets behind the launch
 * sheet's two pickers, which nobody can see until they open the sheet.
 * Measured at 0.33s of every boot on prod, 2026-08-19.
 *
 * === WHY THE ASSERTION IS "STILL IN FLIGHT" AND NOT AN ORDERING ===
 *
 * A test that only checked "ready happened before the deferred read resolved"
 * would pass on a fast seam by luck, and would keep passing if someone put one
 * of these reads back on the gate — the gate would just be quick. So the seam
 * here holds every non-gating read OPEN: the promise does not settle until the
 * test releases it. `ready === true` while all six are unresolved is a
 * property no accidental ordering can satisfy.
 *
 * The converse matters just as much and is asserted below: this is a
 * RESCHEDULING, not a deletion. Released, every one of them must land and
 * populate its surface. A "fix" that simply dropped the reads would pass the
 * first assertion and fail the second.
 *
 * === WHY jsdom IS A VALID INSTRUMENT HERE ===
 *
 * Nothing here measures layout or wall-clock. It observes which seam methods
 * the real `useGateData` has called at the moment `ready` flips, and what
 * reaches the hook's own returned state afterwards. Both are behavioural.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type {
  CollectionQuery,
  DurableWorkspaceEvent,
  EntitySummary,
  MenuConfig,
  SpaceId,
} from '@tm8/contract';
import type { Seam } from '../data/seam';
import { nodeKeyOf, readLaunchCache, writeLaunchCache } from '../data/launch-cache';
import { useGateData } from './useGateData';

const SPACE = 'spc-defer' as SpaceId;

/** A promise the test decides when — and how — to settle. */
interface Gate<T> {
  promise: Promise<T>;
  release: (value: T) => void;
  fail: (reason: unknown) => void;
  pending: () => boolean;
}

function gate<T>(): Gate<T> {
  let settle: ((value: T) => void) | undefined;
  let reject: ((reason: unknown) => void) | undefined;
  let settled = false;
  // Attached immediately so a `fail()` nobody has awaited yet is never an
  // unhandled rejection in the test process.
  const promise = new Promise<T>((res, rej) => { settle = res; reject = rej; });
  promise.catch(() => undefined);
  return {
    promise,
    release: (value: T) => { settled = true; settle?.(value); },
    fail: (reason: unknown) => { settled = true; reject?.(reason); },
    pending: () => !settled,
  };
}

function row(id: string, kind: string, extra: Record<string, unknown> = {}, version = 1): EntitySummary {
  return {
    id: id as EntitySummary['id'],
    spaceId: SPACE,
    kind: kind as EntitySummary['kind'],
    title: id,
    parentId: null,
    position: 0,
    visibility: 'space' as EntitySummary['visibility'],
    version,
    activityAt: '2026-08-01T10:00:00.000Z',
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    deletedAt: null,
    createdBy: { id: 'act-1', kind: 'member', displayName: 'me' } as EntitySummary['createdBy'],
    counters: { children: 0, comments: 0, reactions: 0, points: 0, messages: 0, viewerReaction: null },
    state: { kind, ...extra },
    badges: {},
  } as unknown as EntitySummary;
}

/* A model/agentTool pair the launch catalog actually knows: the launch memo
   DROPS any teammate whose model is unsupported, so a placeholder would empty
   `launch.teammates` and make the "it still arrives" assertions vacuous. */
const teammate = (id: string, version = 1) =>
  row(id, 'team_member', {
    owner: { id: 'act-1', kind: 'member', displayName: 'me' },
    model: 'claude-opus-5',
    agentTool: 'claude-code',
    defaultProfileId: null,
  }, version);

/** A menu that is NOT the shipped default, so its arrival is distinguishable. */
const SERVER_MENU: MenuConfig = {
  schemaVersion: 1,
  revision: 7,
  groups: [{ id: 'only', label: 'Only', items: [{ type: 'view', ref: 'settings' }] }],
} as unknown as MenuConfig;

interface Harness {
  seam: Seam;
  /** Every non-gating read, held open until released. */
  deferred: {
    counts: Gate<Record<string, { total: number; unseen: number }>>;
    identity: Gate<unknown>;
    liveness: Gate<unknown>;
    projects: Gate<unknown[]>;
    launch: Map<string, Gate<EntitySummary[]>>;
  };
  releaseAll: () => void;
  /** How many times `spaces.menu.get` was read. Must stay zero. */
  menuReads: () => number;
  /** Every `collections.query` issued, in call order, with its limit. */
  queries: () => Array<{ kind: string; limit: number | undefined }>;
  /** The highest number of deferred reads in flight at once. */
  peakDeferredConcurrency: () => number;
}

function harness(options: {
  serverRows?: EntitySummary[];
  settingsMenu?: MenuConfig | undefined;
} = {}): Harness {
  const serverRows = options.serverRows ?? [teammate('tm-a'), row('prof-1', 'interaction_profile')];
  const launch = new Map<string, Gate<EntitySummary[]>>([
    ['team_member', gate<EntitySummary[]>()],
    ['interaction_profile', gate<EntitySummary[]>()],
  ]);
  const deferred = {
    counts: gate<Record<string, { total: number; unseen: number }>>(),
    identity: gate<unknown>(),
    liveness: gate<unknown>(),
    projects: gate<unknown[]>(),
    launch,
  };
  let menuReads = 0;
  const queries: Array<{ kind: string; limit: number | undefined }> = [];
  let inFlight = 0;
  let peak = 0;

  /* Wraps a held read so the file can also assert the deferred set stays
     BOUNDED. "After paint" must not mean "all at once" — these reads share the
     same small pool as the gating ones, against a tab that is now rendering. */
  const tracked = async <T,>(promise: Promise<T>): Promise<T> => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    try {
      return await promise;
    } finally {
      inFlight -= 1;
    }
  };

  const seam = {
    async openSpace() {},
    closeSpace() {},
    dispose() {},
    onEvent(_cb: (e: DurableWorkspaceEvent) => void) { return () => {}; },
    onConnection() { return () => {}; },
    getConnection() { return { phase: 'live' as const }; },
    onResync() { return () => {}; },
    async spaces() { return [{ id: SPACE, name: 'Defer', slug: 'defer' }] as never; },
    /* THE READ THAT MUST NOT HAPPEN AT ALL. `spaces.settings` already returns
       the menu, off the same `space_menu_configs` row. It counts rather than
       throwing because a throw here would be absorbed by the old code's own
       `.catch` and read as a soft-fail rather than as a regression. */
    async menu() { menuReads += 1; return null; },
    async spaceSettings() {
      return {
        members: [{ actor: { id: 'act-1', kind: 'member', displayName: 'me' }, role: 'owner' }],
        taskAxes: [],
        taskWorkflows: [],
        ...(options.settingsMenu === undefined ? {} : { menu: options.settingsMenu }),
        defaultChannelId: null,
        defaultInteractionProfileId: null,
        settingsRevision: 1,
      } as never;
    },
    projects() { return tracked(deferred.projects.promise) as never; },
    identity() { return tracked(deferred.identity.promise) as never; },
    counts() { return tracked(deferred.counts.promise) as never; },
    async query(input: CollectionQuery) {
      const kind = (input.kinds ?? [])[0] ?? '';
      queries.push({ kind, limit: (input as { limit?: number }).limit });
      const held = launch.get(kind);
      const items = held ? await tracked(held.promise) : serverRows.filter((r) => r.kind === kind);
      return { query: input, page: { items, nextCursor: undefined } } as never;
    },
    async graph() { return { nodes: [], edges: [], clusters: [] }; },
    async entity() { throw new Error('not read by this test'); },
    connections() { throw new Error('boot must not read connections per teammate'); },
    async messages() { return { items: [], nextCursor: null, total: 0 } as never; },
    liveness: {
      refresh() { return tracked(deferred.liveness.promise) as never; },
      onChange() { return () => {}; },
      statusOf() { return 'unknown' as const; },
    },
    realControls: { setSessionSurfaceVisible() {} },
    commands: {},
  } as unknown as Seam;

  return {
    seam,
    deferred,
    releaseAll: () => {
      deferred.counts.release({ task: { total: 3, unseen: 1 } });
      deferred.identity.release({ memberships: [{ spaceId: SPACE, memberId: 'act-1' }] });
      deferred.liveness.release({
        spaceId: SPACE,
        liveEntityIds: ['ses-live'],
        nodeBootId: 'boot',
        checkedAt: '2026-08-01T10:00:00.000Z',
      });
      deferred.projects.release([]);
      for (const [kind, held] of launch) {
        held.release(serverRows.filter((r) => r.kind === kind));
      }
    },
    menuReads: () => menuReads,
    queries: () => [...queries],
    peakDeferredConcurrency: () => peak,
  };
}

const mount = (h: Harness) =>
  renderHook(() => useGateData({ leftKind: 'task', rightKind: 'work_session', seam: h.seam }));

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('boot: the non-gating reads are off the gate', () => {
  it('opens the workspace while all six are still in flight', async () => {
    const h = harness();
    const { result } = mount(h);

    await waitFor(() => expect(result.current.ready).toBe(true));

    /* THE PROPERTY. Not "these resolved quickly" — none of them has resolved
       at all, and the workspace is open anyway. */
    expect(h.deferred.counts.pending()).toBe(true);
    expect(h.deferred.identity.pending()).toBe(true);
    expect(h.deferred.liveness.pending()).toBe(true);
    expect(h.deferred.projects.pending()).toBe(true);
    expect(h.deferred.launch.get('team_member')?.pending()).toBe(true);
    expect(h.deferred.launch.get('interaction_profile')?.pending()).toBe(true);
  });

  it('reads the menu off spaces.settings and never calls spaces.menu.get', async () => {
    const h = harness({ settingsMenu: SERVER_MENU });
    const { result } = mount(h);

    await waitFor(() => expect(result.current.ready).toBe(true));

    /* The duplicate is DELETED, not deferred: `spaces.settings` already
       carries this exact `MenuConfig`, and it is a whole round trip and a
       whole pool slot per boot on a node whose pool is the scarce thing. */
    expect(h.menuReads()).toBe(0);
    expect(result.current.menu.origin).toEqual({ source: 'server', revision: 7 });
    expect(result.current.menu.config).toEqual(SERVER_MENU);
  });

  it('still lands on the shipped default when settings carries no usable menu', async () => {
    /* The failure posture the fold had to preserve. A seam that omits `menu`
       — a rolling node, a fixture seam — reads as `absent` and gets the
       shipped default, exactly as a null from the deleted read did. It does
       NOT become a boot failure. */
    const h = harness({ settingsMenu: undefined });
    const { result } = mount(h);

    await waitFor(() => expect(result.current.ready).toBe(true));

    expect(result.current.bootError).toBeNull();
    expect(result.current.menu.origin).toEqual({ source: 'default', because: 'absent' });
  });

  it('keeps each kind\'s limit exactly as it was: panels default, pickers 200', async () => {
    /* Moving a read must not quietly change WHAT it asks for. The launch
       kinds' `limit: 200` is not decoration — an unbounded collections.query
       takes the server's DEFAULT_LIMIT of 50, and the 51st teammate then stops
       being offerable with no error and no reason shown. Panel kinds must keep
       the default for the opposite reason: those ARE paged lists. */
    const h = harness();
    const { result } = mount(h);
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => { h.releaseAll(); });

    const limitOf = (kind: string) => h.queries().find((q) => q.kind === kind)?.limit;
    expect(limitOf('task')).toBeUndefined();
    expect(limitOf('work_session')).toBeUndefined();
    expect(limitOf('team_member')).toBe(200);
    expect(limitOf('interaction_profile')).toBe(200);
  });

  it('a panel kind that is ALSO a launch source still gates, and keeps its 200', async () => {
    /* The overlap branch. `team_member` on a visible panel has two roles at
       once: the panel cannot paint without it, AND it is still the picker's
       complete option set. Deferring it would starve the panel; taking the
       server default for it would silently shorten the picker. It has to gate
       AND keep the launch limit — which is the one case where a launch-kind
       read is awaited by boot, and therefore the one case the tombstone pass
       must read its rows off the GATED loads rather than the deferred ones. */
    const h = harness({ serverRows: [teammate('tm-a')] });
    const { result } = renderHook(() =>
      useGateData({ leftKind: 'team_member', rightKind: 'work_session', seam: h.seam }),
    );

    // It gates: the workspace cannot open until the held read answers.
    await waitFor(() => expect(h.queries().some((q) => q.kind === 'team_member')).toBe(true));
    expect(result.current.ready).toBe(false);

    await act(async () => { h.releaseAll(); });
    await waitFor(() => expect(result.current.ready).toBe(true));

    expect(h.queries().find((q) => q.kind === 'team_member')?.limit).toBe(200);
    // And it is read ONCE, not once per role.
    expect(h.queries().filter((q) => q.kind === 'team_member')).toHaveLength(1);
    expect(result.current.launch.teammates.map((t) => t.id)).toEqual(['tm-a']);
  });

  it('is a RESCHEDULING, not a deletion: every surface fills once they land', async () => {
    const h = harness();
    const { result } = mount(h);
    await waitFor(() => expect(result.current.ready).toBe(true));

    /* Before: each surface honestly says "no answer yet" rather than a made-up
       one. `countsFor` is undefined and not zero — see its docblock. */
    expect(result.current.countsFor('task')).toBeUndefined();
    expect(result.current.viewerActor).toBeNull();
    expect(result.current.liveIds).toEqual([]);
    expect(result.current.launch.teammates).toEqual([]);

    await act(async () => { h.releaseAll(); });

    await waitFor(() => {
      expect(result.current.countsFor('task')).toEqual({ total: 3, unseen: 1 });
      expect(result.current.viewerActor?.id).toBe('act-1');
      expect(result.current.liveIds).toEqual(['ses-live']);
      expect(result.current.launch.teammates.map((t) => t.id)).toEqual(['tm-a']);
    });
  });

  it('keeps the deferred set bounded rather than firing it all at once', async () => {
    const h = harness();
    const { result } = mount(h);
    await waitFor(() => expect(result.current.ready).toBe(true));
    await waitFor(() => expect(h.peakDeferredConcurrency()).toBeGreaterThan(0));

    /* BOOT_READ_CONCURRENCY is 2 and it exists because unbounded per-kind
       reads approached the whole pool. Deferred reads still share that pool.
       The panel reads have resolved by `ready`, so anything in flight here is
       the deferred queue. */
    expect(h.peakDeferredConcurrency()).toBeLessThanOrEqual(2);

    await act(async () => { h.releaseAll(); });
  });
});

describe('boot: the launch-cache tombstone moved with the reads it depends on', () => {
  it('retracts a seeded row the server no longer returns — after paint, not before', async () => {
    /* A teammate deleted while the browser was closed. It is seeded from cache,
       so the picker is populated before the first read is even sent; nothing
       else can ever remove it, because the server cannot send an
       `entity.deleted` for something deleted before this client connected. */
    const ghost = teammate('tm-ghost');
    writeLaunchCache(nodeKeyOf(undefined), SPACE, [ghost]);
    const h = harness({ serverRows: [teammate('tm-a')] });

    const { result } = mount(h);
    await waitFor(() => expect(result.current.ready).toBe(true));

    /* THE PASS MUST NOT RUN EARLY. Its input is the launch reads, which are
       still in flight — running it on the gate would read "not returned" off a
       read that has not answered and tombstone the whole picker on every boot.
       So the seed is still on offer here, which is the correct, honest state. */
    expect(result.current.launch.teammates.map((t) => t.id)).toEqual(['tm-ghost']);

    await act(async () => { h.releaseAll(); });

    await waitFor(() => {
      expect(result.current.launch.teammates.map((t) => t.id)).toEqual(['tm-a']);
    });
  });

  it('does NOT retract the picker when the launch read never answered', async () => {
    /* THE INFERENCE HAS A PRECONDITION. "The server did not return it" means
       "it was deleted" only if the server actually spoke. On the gate that was
       free — a rejecting launch read took the whole boot down, so the pass
       never ran on a half-answer. Off the gate the rejection is absorbed, and
       without a guard the pass would read an empty `returned` set and retract
       the viewer's entire seeded picker over one transient blip.

       This is the failure mode the deferral INTRODUCES, so it is pinned here
       rather than left to the reviewer's imagination. */
    const seeded = teammate('tm-seeded');
    writeLaunchCache(nodeKeyOf(undefined), SPACE, [seeded]);

    const h = harness({ serverRows: [] });
    const { result } = mount(h);
    await waitFor(() => expect(result.current.ready).toBe(true));

    await act(async () => {
      h.deferred.launch.get('team_member')?.fail(new Error('node blinked'));
      h.deferred.launch.get('interaction_profile')?.release([]);
      h.deferred.counts.release({});
      h.deferred.identity.release({ memberships: [] });
      h.deferred.liveness.release({
        spaceId: SPACE, liveEntityIds: [], nodeBootId: 'boot',
        checkedAt: '2026-08-01T10:00:00.000Z',
      });
      h.deferred.projects.release([]);
    });

    /* Still on offer, and the cache still holds it: a read that failed
       measured NOTHING, and must not be written down as a zero. */
    await waitFor(() => expect(result.current.countsFor('task')).toBeUndefined());
    expect(result.current.launch.teammates.map((t) => t.id)).toEqual(['tm-seeded']);
    expect(readLaunchCache(nodeKeyOf(undefined), SPACE)?.map((r) => r.id)).toEqual(['tm-seeded']);
  });

  it('leaves a seeded row alone when something newer has touched it', async () => {
    /* THE WINDOW THE DEFERRAL WIDENED. This pass used to run BEFORE
       `releaseBufferedEvents()`, so no event could have touched a seeded row
       and "the launch read did not return it" meant deleted. It now runs with
       the stream live. A row the launch read omits but something fresher has
       re-asserted at a HIGHER version is not evidence of a deletion, and
       tombstoning over it would hide a row the server had just spoken about.

       Driven here through `graph.query`, which is a real path to exactly that
       state and needs no event plumbing: it ingests summaries of any kind, and
       nothing it returns is ever in a launch read's `returned` set. */
    const seeded = teammate('tm-moved', 1);
    writeLaunchCache(nodeKeyOf(undefined), SPACE, [seeded]);

    const h = harness({ serverRows: [teammate('tm-a')] });
    (h.seam as unknown as { graph: () => Promise<unknown> }).graph = async () => ({
      nodes: [teammate('tm-moved', 9)],
      edges: [],
      clusters: [],
    });

    const { result } = mount(h);
    await waitFor(() => expect(result.current.ready).toBe(true));
    await act(async () => { h.releaseAll(); });

    await waitFor(() => expect(result.current.launch.teammates.map((t) => t.id)).toContain('tm-a'));
    expect(result.current.launch.teammates.map((t) => t.id)).toContain('tm-moved');
  });
});
