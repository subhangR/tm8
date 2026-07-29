// @vitest-environment jsdom
/**
 * THE LOOP: create → server event → the row is on screen. No refresh.
 *
 * === WHY THIS FILE EXISTS ===
 *
 * Every link of this chain was already built and green. `createRealSeam`
 * implements the commands over HTTP; `socket.ts` holds a real WebSocket that
 * subscribes, resumes and reconnects; `createDomainStore(seam)` subscribes to
 * `seam.onEvent` and folds every event into a normalized projection. Four
 * lanes, four passing suites, and the feature was dead — because NO VIEW READ
 * THE STORE. `useGateData` kept its own `rows` state and refreshed it on
 * openSpace, on resync and after its own spawn. The event stream arrived,
 * reduced correctly into a projection nobody rendered, and stopped.
 *
 * That is the four-links-green defect (DoD §3) in its purest form, and it is
 * invisible to every test that owns only one link. So this file asserts the
 * one thing none of them could: that an event ALONE moves the screen.
 *
 * === THE ASSERTION THAT MATTERS ===
 *
 * `query` call counts are captured before the event and compared after. A test
 * that only checked "the row is there" would pass identically if the hook had
 * responded to the event by re-running its reads — which is a different, much
 * weaker feature (and one that cannot work at all when the node emits an event
 * for something another client did while this client is idle). The row must
 * arrive FROM THE EVENT PAYLOAD.
 *
 * === RED-FIRST RECORD (measured, not predicted) ===
 *
 * Run against the tree with the injection port added and the projection NOT
 * wired — `rowsFor` still serving its own `rows` state, i.e. HEAD's behaviour:
 *
 *   2026-07-29T12:30:21Z  RUN v4.1.10 …/packages/tm8-ui
 *   bunx vitest run src/views/live-event-loop.test.tsx
 *    FAIL  > the created task is ON SCREEN, and it got there without a re-read
 *      AssertionError: the event-created task must be in the rendered rows:
 *      expected [ 'ent-task-seeded' ] to include 'ent-task-created'
 *    FAIL  > an event that MOVES a task out of a filter takes it off screen
 *      AssertionError: a task marked done must leave the Open list:
 *      expected [ 'ent-task-seeded' ] to have a length of +0 but got 1
 *    FAIL  > an edit to a row already on screen shows the NEW title
 *      AssertionError: expected [ 'before' ] to deeply equal [ 'after' ]
 *    Test Files  1 failed (1) · Tests  3 failed | 5 passed (8)
 *
 * The five that passed red are the read-path and the no-lie guards — they are
 * true of the broken tree too, and they are here to stop the fix from buying
 * the loop with a lie (a projection that scavenged the store for every list
 * would turn all five of them red).
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type {
  CollectionQuery,
  DurableWorkspaceEvent,
  EntitySummary,
  SpaceId,
} from '@tm8/contract';
import type { Seam } from '../data/seam';
import { useGateData } from './useGateData';

const SPACE = 'spc-live' as SpaceId;

/** A summary with every envelope field the projection reads, and nothing else
    invented: this is data a node would send, not a convenience shape. */
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
    activityAt: '2026-07-29T10:00:00.000Z',
    createdAt: '2026-07-29T10:00:00.000Z',
    updatedAt: '2026-07-29T10:00:00.000Z',
    deletedAt: null,
    createdBy: { id: 'act-1', kind: 'member', displayName: 'me' } as EntitySummary['createdBy'],
    counters: { children: 0, comments: 0, reactions: 0, points: 0, messages: 0, viewerReaction: null },
    state: { kind: 'task', workStatus: 'open', priority: 'medium', axes: {}, assignees: [], acceptance: { total: 0, completed: 0 } },
    badges: {},
    ...over,
  } as EntitySummary;
}

interface Harness {
  seam: Seam;
  emit: (event: DurableWorkspaceEvent) => void;
  queryCalls: () => number;
}

/**
 * A hand-built seam rather than the fixture seam, for one reason: the fixture
 * seam has no control that emits an arbitrary event (`fixtureControls` covers
 * connection, liveness and resync only), and `src/data/fixtures/` is not this
 * seat's to extend. Everything here answers exactly what boot reads.
 */
function harness(seeded: EntitySummary[]): Harness {
  const subs = new Set<(e: DurableWorkspaceEvent) => void>();
  let queryCalls = 0;

  const seam = {
    async openSpace() {},
    closeSpace() {},
    dispose() {},
    onEvent(cb: (e: DurableWorkspaceEvent) => void) {
      subs.add(cb);
      return () => void subs.delete(cb);
    },
    onConnection() {
      return () => {};
    },
    getConnection() {
      return { phase: 'live' as const };
    },
    onResync() {
      return () => {};
    },
    async identity() {
      throw new Error('not read by this test');
    },
    async spaces() {
      return [{ id: SPACE, name: 'Live', slug: 'live' }] as never;
    },
    async menu() {
      return null;
    },
    async query(input: CollectionQuery) {
      queryCalls += 1;
      const kinds = input.kinds ?? [];
      const items = seeded.filter((s) => kinds.includes(s.kind));
      return { query: input, page: { items, nextCursor: undefined } } as never;
    },
    async entity() {
      throw new Error('not read by this test');
    },
    async messages() {
      throw new Error('not read by this test');
    },
    liveness: {
      async refresh() {
        return { spaceId: SPACE, liveEntityIds: [], nodeBootId: 'boot', checkedAt: '2026-07-29T10:00:00.000Z' };
      },
      onChange() {
        return () => {};
      },
      statusOf() {
        return 'unknown' as const;
      },
    },
    commands: {},
  } as unknown as Seam;

  return {
    seam,
    emit: (event) => {
      for (const cb of subs) cb(event);
    },
    queryCalls: () => queryCalls,
  };
}

const OPEN = { workStatus: ['open'], deleted: 'exclude' };

describe('the live event loop — an event moves the screen, alone', () => {
  it('the created task is ON SCREEN, and it got there without a re-read', async () => {
    const h = harness([task('ent-task-seeded')]);
    const { result } = renderHook(() =>
      useGateData({ leftKind: 'task', rightKind: 'work_session', seam: h.seam }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    const read = () => result.current.rowsFor('task')(OPEN).map((r) => r.id as string);
    await waitFor(() => expect(read()).toEqual(['ent-task-seeded']));

    const before = h.queryCalls();

    // THE SERVER SPEAKS. This is the frame the node emits after a write —
    // `createTask` returns, the durable event follows over the socket.
    act(() => {
      h.emit({
        type: 'entity.upsert',
        spaceId: SPACE,
        seq: 1,
        entity: task('ent-task-created', { activityAt: '2026-07-29T11:00:00.000Z' }),
      } as unknown as DurableWorkspaceEvent);
    });

    expect(read(), 'the event-created task must be in the rendered rows').toContain(
      'ent-task-created',
    );
    // Newest activity first — the server's own default sort, so a new task
    // lands where the user is looking rather than below the fold.
    expect(read()[0]).toBe('ent-task-created');
    expect(
      h.queryCalls(),
      'the row must come from the EVENT — a re-read is a different, weaker feature',
    ).toBe(before);
  });

  it('an event that MOVES a task out of a filter takes it off screen', async () => {
    const h = harness([task('ent-task-seeded')]);
    const { result } = renderHook(() =>
      useGateData({ leftKind: 'task', rightKind: 'work_session', seam: h.seam }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    const read = () => result.current.rowsFor('task')(OPEN).map((r) => r.id as string);
    await waitFor(() => expect(read()).toEqual(['ent-task-seeded']));

    act(() => {
      h.emit({
        type: 'entity.upsert',
        spaceId: SPACE,
        seq: 2,
        entity: task('ent-task-seeded', {
          version: 2,
          state: { kind: 'task', workStatus: 'done', priority: 'medium', axes: {}, assignees: [], acceptance: { total: 0, completed: 0 } } as EntitySummary['state'],
        }),
      } as unknown as DurableWorkspaceEvent);
    });

    expect(read(), 'a task marked done must leave the Open list').toHaveLength(0);
  });

  it('an edit to a row already on screen shows the NEW title, not the read one', async () => {
    const h = harness([task('ent-task-seeded', { title: 'before' })]);
    const { result } = renderHook(() =>
      useGateData({ leftKind: 'task', rightKind: 'work_session', seam: h.seam }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    const titles = () => result.current.rowsFor('task')(OPEN).map((r) => r.title);
    await waitFor(() => expect(titles()).toEqual(['before']));

    act(() => {
      h.emit({
        type: 'entity.upsert',
        spaceId: SPACE,
        seq: 3,
        entity: task('ent-task-seeded', { title: 'after', version: 2 }),
      } as unknown as DurableWorkspaceEvent);
    });

    expect(titles()).toEqual(['after']);
  });

  it('an UNDECIDABLE filter never gains a guessed row', async () => {
    // `readyToPull` is a server-side judgement no summary field answers. The
    // honest response is that the list keeps exactly what the read returned —
    // showing the new task there would be inventing membership, which is the
    // same class of lie as inventing the row.
    const h = harness([task('ent-task-seeded')]);
    const { result } = renderHook(() =>
      useGateData({ leftKind: 'task', rightKind: 'work_session', seam: h.seam }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    const read = () => result.current.rowsFor('task')({ readyToPull: true }).map((r) => r.id as string);
    await waitFor(() => expect(read()).toEqual(['ent-task-seeded']));

    act(() => {
      h.emit({
        type: 'entity.upsert',
        spaceId: SPACE,
        seq: 4,
        entity: task('ent-task-created', { activityAt: '2026-07-29T11:00:00.000Z' }),
      } as unknown as DurableWorkspaceEvent);
    });

    expect(read()).toEqual(['ent-task-seeded']);
  });

  it('an event for ANOTHER SPACE never reaches this space’s list', async () => {
    const h = harness([task('ent-task-seeded')]);
    const { result } = renderHook(() =>
      useGateData({ leftKind: 'task', rightKind: 'work_session', seam: h.seam }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    const read = () => result.current.rowsFor('task')(OPEN).map((r) => r.id as string);
    await waitFor(() => expect(read()).toEqual(['ent-task-seeded']));

    act(() => {
      h.emit({
        type: 'entity.upsert',
        spaceId: 'spc-other' as SpaceId,
        seq: 5,
        entity: task('ent-task-elsewhere', { spaceId: 'spc-other' as SpaceId }),
      } as unknown as DurableWorkspaceEvent);
    });

    expect(read()).toEqual(['ent-task-seeded']);
  });
});

describe('the loop does not cost the read path', () => {
  it('a kind that was never read stays honestly empty, not store-scavenged', async () => {
    // The store is a flat entity table; deriving lists from it ALONE would
    // make a never-read kind look empty-because-read rather than
    // empty-because-unread. `rowsFor` still answers [] and still schedules the
    // read — the projection augments the read, it does not replace it.
    const h = harness([task('ent-task-seeded')]);
    const { result } = renderHook(() =>
      useGateData({ leftKind: 'task', rightKind: 'work_session', seam: h.seam }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));

    const before = h.queryCalls();
    expect(result.current.rowsFor('doc')(OPEN)).toEqual([]);
    await waitFor(() => expect(h.queryCalls()).toBeGreaterThan(before));
  });

  it('rowsFor keeps referential identity when nothing has changed', async () => {
    // A projection rebuilt per render would hand every consumer a new array
    // identity every time, and the memo/effect deps downstream would churn
    // forever. Asserted because the fix is one line and the failure is a
    // render loop nobody attributes to this file.
    const h = harness([task('ent-task-seeded')]);
    const { result, rerender } = renderHook(() =>
      useGateData({ leftKind: 'task', rightKind: 'work_session', seam: h.seam }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    await waitFor(() => expect(result.current.rowsFor('task')(OPEN)).toHaveLength(1));

    const first = result.current.rowsFor('task')(OPEN);
    rerender();
    expect(result.current.rowsFor('task')(OPEN)).toBe(first);
  });
});

describe('liveness stays the seam’s verdict', () => {
  it('never derives a verdict from the event payload', async () => {
    // The projection now feeds `livenessOf`'s row lookup. R-UI-5 says the
    // verdict comes from `seam.liveness.statusOf` and nowhere else, so this
    // pins that the new path still ASKS rather than reading `state.status`.
    const h = harness([task('ent-task-seeded')]);
    const statusOf = vi.fn(() => 'not-running' as const);
    (h.seam as unknown as { liveness: { statusOf: unknown } }).liveness.statusOf = statusOf;

    const { result } = renderHook(() =>
      useGateData({ leftKind: 'task', rightKind: 'work_session', seam: h.seam }),
    );
    await waitFor(() => expect(result.current.ready).toBe(true));
    await waitFor(() => expect(result.current.rowsFor('task')(OPEN)).toHaveLength(1));

    expect(result.current.livenessOf('ent-task-seeded')).toBe('not-running');
    expect(statusOf).toHaveBeenCalled();
  });
});
