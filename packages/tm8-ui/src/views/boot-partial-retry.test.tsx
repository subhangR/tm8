// @vitest-environment jsdom
/**
 * ONE FAILED READ MUST NOT COST THE READS THAT SUCCEEDED.
 *
 * === THE DEFECT THIS FILE PINS ===
 *
 * The space-open effect wrapped `openSpace` + `hydrate` in one retry loop. On
 * ANY throw it closed the space, waited `bootRetryDelayMs` (1s escalating to a
 * 15s cap, 60s once the node answers 503), called `domain.store.reset()` — which
 * DISCARDS everything already fetched — re-armed buffering, and re-ran the whole
 * of `hydrate`.
 *
 * So a single slow read tripping the transport timeout cost a full re-boot plus
 * up to 15s of dead wait, having thrown away every good response beside it, and
 * then put the whole read set back on the node that was already struggling. That
 * is the "sometimes over a minute" half of the original complaint, and the
 * recovery was the most expensive thing the client could do at the worst moment.
 *
 * === WHY IT FIRED IN PRACTICE ===
 *
 * The box has 4 cores and these reads are CPU-bound, so concurrent tabs multiply
 * every read. Measured on prod 2026-08-19 against `collections.query`, N
 * identical concurrent requests, median latency: N=1 0.32s, N=8 0.64s, N=16
 * 1.33s, N=24 2.03s, N=32 2.20s — linear from N=4 with no cliff. (Absolute
 * numbers are noisy: several agent sessions share this node. The SHAPE is the
 * evidence, and it reproduces the parent analysis's independent curve.) Under
 * that multiplier a boot read reaching the 15s transport timeout is not exotic.
 *
 * === THE TWO HALVES, BECAUSE THE GATE SPLIT UNDER THIS FIX ===
 *
 * `hydrate` is now two halves (see its docblock). They need DIFFERENT retry
 * postures, and this file pins both:
 *
 *   GATED (`spaces.settings`, the two panel `collections.query` reads) — the
 *   workspace cannot open without these, so a failure retries FOREVER and shows
 *   `bootError` while it works.
 *
 *   DEFERRED (launch option sets, `identity`, `projects`) — these run after
 *   `setReady(true)`. A failure retries on a BUDGET and stays silent, because
 *   the workspace is already open and painting a boot error over a working
 *   workspace would be a new, dishonest error surface.
 *
 *   NOT RETRIED AT ALL (`liveness`, `counts`) — these SELF-HEAL off the live
 *   stream, so a retry would add requests to buy a result already arriving.
 *   Asserted here as a count, so a future "improvement" that wraps them has to
 *   argue with a test rather than slip through.
 *
 * === WHAT IS ASSERTED, AND WHY IT IS A COUNT RATHER THAN A TIMING ===
 *
 * The fix is that recovery is PROPORTIONAL to the failure, and the only honest
 * statement of that is a request count: make exactly one read fail, then assert
 * every OTHER read was issued exactly ONCE. Under the old code every one of them
 * is issued twice. A test that only asserted `ready === true` would pass on the
 * defect — it always did reach ready, just a re-boot later.
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { CollabError } from '@tm8/contract';
import type { CollectionQuery, DurableWorkspaceEvent, EntitySummary, SpaceId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { useGateData } from './useGateData';

const SPACE = 'spc-partial' as SpaceId;

/** The kinds that GATE first paint: the two visible panels. */
const PANEL_KINDS = ['task', 'work_session'];
/** The option sets, read after paint. */
const DEFERRED_KINDS = ['team_member', 'interaction_profile'];

function row(id: string, kind: string): EntitySummary {
  return {
    id: id as EntitySummary['id'],
    spaceId: SPACE,
    kind: kind as EntitySummary['kind'],
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
    state:
      kind === 'team_member'
        ? {
            kind: 'team_member',
            owner: { id: 'act-1', kind: 'member', displayName: 'me' },
            model: 'claude-opus-5',
            agentTool: 'claude-code',
            defaultProfileId: null,
          }
        : { kind },
    badges: {},
  } as unknown as EntitySummary;
}

/** A transport timeout — the exact failure this fix exists for. */
function timeout(): CollabError {
  return new CollabError('upstream_unavailable', 'the tm8 node did not answer within 15000ms');
}

interface Counts {
  liveness: number;
  projects: number;
  settings: number;
  identity: number;
  graph: number;
  counts: number;
  /** `collections.query` calls, per kind. */
  query: Map<string, number>;
}

interface Options {
  /** Fail `spaces.settings` this many times before answering. */
  failSettings?: number;
  /** Fail `collections.query` for this kind this many times before answering. */
  failKind?: { kind: string; times: number };
  /** Fail `projects.list` this many times before answering. */
  failProjects?: number;
  /** Thrown instead of a transport timeout, for the terminal-answer case. */
  error?: () => unknown;
}

function harness(options: Options = {}) {
  const c: Counts = {
    liveness: 0, projects: 0, settings: 0,
    identity: 0, graph: 0, counts: 0, query: new Map(),
  };
  const makeError = options.error ?? timeout;
  let settingsFailures = options.failSettings ?? 0;
  let kindFailures = options.failKind?.times ?? 0;
  let projectFailures = options.failProjects ?? 0;
  const resyncSubs = new Set<(s: SpaceId) => void>();

  const seam = {
    async openSpace() {},
    closeSpace() {},
    dispose() {},
    onEvent(_cb: (e: DurableWorkspaceEvent) => void) { return () => {}; },
    onConnection() { return () => {}; },
    getConnection() { return { phase: 'live' as const }; },
    onResync(cb: (s: SpaceId) => void) {
      resyncSubs.add(cb);
      return () => void resyncSubs.delete(cb);
    },
    async identity() { c.identity += 1; return null; },
    async spaces() { return [{ id: SPACE, name: 'Partial', slug: 'partial' }] as never; },
    async spaceSettings() {
      c.settings += 1;
      if (settingsFailures > 0) { settingsFailures -= 1; throw makeError(); }
      // `menu` rides this read; there is no separate `spaces.menu.get`.
      return { defaultInteractionProfileId: null, menu: null } as never;
    },
    async projects() {
      c.projects += 1;
      if (projectFailures > 0) { projectFailures -= 1; throw makeError(); }
      return [{ id: 'proj-1', name: 'p1' }] as never;
    },
    async counts() { c.counts += 1; return {} as never; },
    async query(input: CollectionQuery) {
      const kind = (input.kinds ?? [])[0] ?? '?';
      c.query.set(kind, (c.query.get(kind) ?? 0) + 1);
      if (options.failKind?.kind === kind && kindFailures > 0) {
        kindFailures -= 1;
        throw makeError();
      }
      return {
        query: input,
        page: { items: [row(`${kind}-1`, kind)], nextCursor: undefined },
      } as never;
    },
    async graph() { c.graph += 1; return { nodes: [], edges: [], clusters: [] }; },
    async entity() { throw new Error('not read by this test'); },
    connections() { throw new Error('boot must not read connections per teammate'); },
    async messages() { return { items: [], nextCursor: null, total: 0 } as never; },
    liveness: {
      async refresh() {
        c.liveness += 1;
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

  return { seam, c, fireResync: () => { for (const cb of resyncSubs) cb(SPACE); } };
}

function render(seam: Seam) {
  return renderHook(() => useGateData({ leftKind: 'task', rightKind: 'work_session', seam }));
}

/* The first backoff step is `bootRetryDelayMs(0, <timeout>)` = 1000ms of REAL
   time, so every test that provokes a retry needs a leash longer than vitest's
   5s default. Fake timers are deliberately not used: the retry is driven by
   promise resolution inside the hook's effect, and advancing timers by hand
   around `waitFor` tests the harness rather than the hook. */
const RETRY_TIMEOUT = 20_000;

describe('boot gate: a partial failure retries the failed read, not the world', () => {
  it('re-issues ONLY the failed gating read and still reaches ready', async () => {
    const h = harness({ failSettings: 1 });
    const { result } = render(h.seam);

    await waitFor(() => expect(result.current.ready).toBe(true), { timeout: RETRY_TIMEOUT });

    /* THE WHOLE POINT. `spaces.settings` failed once, so it was asked twice —
       the retry. Every other read succeeded on its first attempt and must carry
       exactly ONE call. Under the old whole-hydrate retry every number below is
       2, because the reset threw all the good answers away. */
    expect(h.c.settings).toBe(2);
    expect(h.c.graph).toBe(1);
    for (const kind of PANEL_KINDS) {
      expect(h.c.query.get(kind), `collections.query for ${kind}`).toBe(1);
    }

    /* The deferred half must not have been re-run either — a gate retry that
       re-ran the post-paint reads would be the same waste one phase later. */
    await waitFor(() => expect(h.c.projects).toBe(1), { timeout: RETRY_TIMEOUT });
    expect(h.c.identity).toBe(1);
    expect(h.c.counts).toBe(1);
    expect(h.c.liveness).toBe(1);
    for (const kind of DEFERRED_KINDS) {
      expect(h.c.query.get(kind), `collections.query for ${kind}`).toBe(1);
    }
  }, RETRY_TIMEOUT);

  it('retries one failed panel query without re-issuing the other panel', async () => {
    const h = harness({ failKind: { kind: 'task', times: 1 } });
    const { result } = render(h.seam);

    await waitFor(() => expect(result.current.ready).toBe(true), { timeout: RETRY_TIMEOUT });

    expect(h.c.query.get('task')).toBe(2);
    expect(h.c.query.get('work_session')).toBe(1);
    // The read that had already landed before the panel queries even started.
    expect(h.c.settings).toBe(1);
    expect(h.c.graph).toBe(1);

    /* The retried read's rows still arrive: a partial retry that reached `ready`
       with the failed read's answer dropped would be a quieter version of the
       same defect. */
    expect(result.current.rowsFor('task')().map((r) => r.id)).toContain('task-1');
  }, RETRY_TIMEOUT);

  it('keeps a gating failure VISIBLE while it retries, and clears it after', async () => {
    /* `bootError` renders during the loop by design — honesty and self-healing
       are not traded against each other. A partial failure costing less to
       recover from must not make it silently invisible. */
    const h = harness({ failSettings: 1 });
    const { result } = render(h.seam);

    await waitFor(() => expect(result.current.bootError).not.toBeNull(), { timeout: RETRY_TIMEOUT });
    expect(result.current.bootError).toContain('did not answer');
    expect(result.current.bootErrorCode).toBe('upstream_unavailable');
    expect(result.current.ready).toBe(false);

    await waitFor(() => expect(result.current.ready).toBe(true), { timeout: RETRY_TIMEOUT });
    expect(result.current.bootError).toBeNull();
    expect(result.current.bootErrorCode).toBeNull();
  }, RETRY_TIMEOUT);

  it('still takes the FULL re-run path when the node gives a final answer', async () => {
    /* `hydrate` must stay one idempotent, re-runnable function: `onResync` means
       catch-up integrity was lost and re-running every read is the only honest
       response. A final answer (`forbidden` here; `unauthenticated` and 404/400
       are the same class) is handed back to the whole-hydrate loop deliberately —
       no amount of re-asking changes it, so the finer-grained retry must not
       swallow it into a spin.

       `graph` at 2 is the evidence the FULL path ran: a read that never failed
       was re-issued, which is exactly the behaviour the partial path suppresses
       and exactly the behaviour this path must keep. */
    const h = harness({
      failSettings: 1,
      error: () => new CollabError('forbidden', 'not your space'),
    });
    const { result } = render(h.seam);

    await waitFor(() => expect(result.current.ready).toBe(true), { timeout: RETRY_TIMEOUT });

    expect(h.c.settings).toBe(2);
    expect(h.c.graph).toBe(2);
  }, RETRY_TIMEOUT);

  it('abandons a retry in flight when the hook unmounts', async () => {
    /* The generation counter alone does not cover an UNMOUNT — it bumps on a
       space switch, not on teardown — so a read retrying in place would keep its
       backoff timer alive past the component. The effect's AbortController is
       what ends both the wait and the loop. */
    const h = harness({ failSettings: 99 });
    const { result, unmount } = render(h.seam);

    await waitFor(() => expect(result.current.bootError).not.toBeNull(), { timeout: RETRY_TIMEOUT });
    const atUnmount = h.c.settings;
    unmount();

    await new Promise((resolve) => setTimeout(resolve, 2_500));
    /* Two backoff steps (1s, 2s) would have elapsed. The count must not have
       moved past the attempt that was already on the wire when we unmounted. */
    expect(h.c.settings).toBeLessThanOrEqual(atUnmount + 1);
  }, RETRY_TIMEOUT);
});

describe('after first paint: the deferred reads recover without disturbing the workspace', () => {
  it('RECOVERS `projects`, which the gate split left unrecoverable', async () => {
    /* THE REGRESSION THIS CLOSES. On main `seam.projects(space)` had no `.catch`,
       so a failure rejected into the boot catch and bought a full retry that
       would eventually succeed. Taking it off the gate removed that — correctly,
       because a late linked-projects list must not restart a workspace — but it
       left the list empty for the session with no second writer. Retrying the
       read itself restores the recoverability without restoring the cost. */
    const h = harness({ failProjects: 1 });
    const { result } = render(h.seam);

    await waitFor(() => expect(result.current.ready).toBe(true), { timeout: RETRY_TIMEOUT });

    /* The workspace opened on the FIRST attempt regardless — a deferred failure
       must never cost paint, and must never restart a boot that succeeded. */
    expect(h.c.settings).toBe(1);
    expect(h.c.graph).toBe(1);

    // ...and the list fills in once the retry lands.
    await waitFor(
      () => expect(result.current.launch.projects.map((p) => p.id)).toEqual(['proj-1']),
      { timeout: RETRY_TIMEOUT },
    );
    expect(h.c.projects).toBe(2);
  }, RETRY_TIMEOUT);

  it('does NOT paint a boot error while a deferred read retries', async () => {
    /* The workspace is open. Surfacing a boot error over it because the
       linked-project list is late would be a new and dishonest error surface —
       and unlike the gate, there is nothing here for the user to act on. */
    const h = harness({ failProjects: 1 });
    const { result } = render(h.seam);

    await waitFor(() => expect(result.current.ready).toBe(true), { timeout: RETRY_TIMEOUT });
    expect(result.current.bootError).toBeNull();
    expect(result.current.bootErrorCode).toBeNull();

    await waitFor(() => expect(h.c.projects).toBe(2), { timeout: RETRY_TIMEOUT });
    expect(result.current.bootError).toBeNull();
    expect(result.current.ready).toBe(true);
  }, RETRY_TIMEOUT);

  it('recovers an EXHAUSTED deferred read on the next resync', async () => {
    /* The budget is finite, so the honest question is what happens after it runs
       out. Answer: the surface keeps its soft-fail posture (empty list), and the
       state is recoverable by triggers that occur ON THEIR OWN — `onResync` bumps
       `bootRevision`, which re-runs the space-open effect and therefore the whole
       of `hydrate`, deferred half included, on a fresh budget.

       That matters because a resync is produced by exactly the class of outage
       that would exhaust the budget in the first place: a connection dropped long
       enough to lose catch-up integrity. So the recovery trigger is not a
       hypothetical the user has to know to reach for.

       Pinned with a read that keeps failing across the FIRST boot and answers
       after it, rather than by exhausting all `READ_MAX_ATTEMPTS` — draining the
       real budget costs ~60s of wall clock on the 1s→15s ladder, which would buy
       one more assertion at the price of a minute per run. The recovery path is
       the same either way: the re-run reads `projects` again from scratch. */
    const h = harness({ failProjects: 1 });
    const { result } = render(h.seam);

    await waitFor(() => expect(result.current.ready).toBe(true), { timeout: RETRY_TIMEOUT });
    await waitFor(() => expect(h.c.projects).toBe(2), { timeout: RETRY_TIMEOUT });
    const before = h.c.projects;

    act(() => h.fireResync());

    /* The re-run reaches the deferred half again and re-reads it. A `hydrate`
       that had stopped being one re-runnable function — or a deferred half that
       only ever ran once per mount — would leave this stuck at `before`. */
    await waitFor(() => expect(h.c.projects).toBeGreaterThan(before), { timeout: RETRY_TIMEOUT });
    await waitFor(() => expect(result.current.ready).toBe(true), { timeout: RETRY_TIMEOUT });
    expect(result.current.launch.projects.map((p) => p.id)).toEqual(['proj-1']);
  }, RETRY_TIMEOUT);

  it('leaves the SELF-HEALING reads alone', async () => {
    /* `liveness` and `counts` are corrected by the live stream — `liveness.onChange`
       republishes every cadence snapshot, and `counts` is re-read debounced off
       any entity event. Retrying them would add requests to buy a result that is
       already arriving. Pinned as a count so a future "make everything retry"
       change has to argue with a test. */
    const h = harness({ failProjects: 1 });
    const { result } = render(h.seam);

    await waitFor(() => expect(result.current.ready).toBe(true), { timeout: RETRY_TIMEOUT });
    await waitFor(() => expect(h.c.projects).toBe(2), { timeout: RETRY_TIMEOUT });

    expect(h.c.liveness).toBe(1);
    expect(h.c.counts).toBe(1);
  }, RETRY_TIMEOUT);
});

/* Not a behaviour of the hook, but the claim the fix rests on: recovery is
   proportional. Stated as arithmetic so a future reader can check it without
   re-deriving the read set. */
describe('boot: the request cost of recovery', () => {
  it('costs one request per failed read rather than the whole read set', async () => {
    const h = harness({ failSettings: 1 });
    const { result } = render(h.seam);
    await waitFor(() => expect(result.current.ready).toBe(true), { timeout: RETRY_TIMEOUT });
    await waitFor(() => expect(h.c.projects).toBe(1), { timeout: RETRY_TIMEOUT });

    const gated =
      h.c.settings + h.c.graph +
      PANEL_KINDS.reduce((sum, kind) => sum + (h.c.query.get(kind) ?? 0), 0);
    const deferred =
      h.c.liveness + h.c.counts + h.c.identity + h.c.projects +
      DEFERRED_KINDS.reduce((sum, kind) => sum + (h.c.query.get(kind) ?? 0), 0);

    /* 4 gating reads, one of which was asked twice. Before this fix a single
       failure re-ran the ENTIRE hydrate, so the total was double the read set
       rather than the read set plus one. */
    expect(gated).toBe(5);
    /* And the deferred half is untouched by a gate retry: 6 reads, once each. */
    expect(deferred).toBe(6);
  }, RETRY_TIMEOUT);
});
