// @vitest-environment jsdom
/**
 * EVENT-DRIVEN BOARD RE-READS GO THROUGH THE SAME SINGLE-FLIGHT AS EVERY OTHER.
 *
 * PR #769 review, M1: the board trigger's `run` was synchronous — it only
 * bumped `boardTick`, and the drain effect then fired EVERY cached board's
 * grouped `collections.query` at once. So the coalesced trigger saw each
 * round finish instantly: the round was never in flight while the reads were,
 * nothing bounded them, and boards are never evicted. Under a continuous event
 * stream with grouped reads slower than the 2s ceiling, waves overlapped again
 * — the exact shape event-refresh.ts exists to remove.
 *
 * Pinned here: while a round's grouped reads are outstanding, (a) at most
 * EVENT_REFRESH_CONCURRENCY are in flight and (b) no second round starts, no
 * matter how long the event stream keeps moving; and (c) the refresh reads
 * exactly the queries the boards were first loaded with.
 */
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { CollectionQuery, SpaceId } from '@tm8/contract';
import { FIXTURE_SPACE_ID, createFixtureSeam } from '../data/fixtures/seam-fixture';
import { EVENT_REFRESH_CONCURRENCY, EVENT_REFRESH_MAX_WAIT_MS } from './event-refresh';
import { useGateData } from './useGateData';

const BOARDS = 8;
const FILTERS = Array.from({ length: BOARDS }, (_, i) => ({ axes: { lane: [`lane-${i}`] } }));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const SPACE_B = '019f0000-0000-7000-8000-0000000000b0' as SpaceId;

/** One event on the durable stream, as the node would deliver it. */
const eventOn = (seam: ReturnType<typeof createFixtureSeam>) => {
  let n = 0;
  return () => act(async () => {
    await seam.commands.createEntity({
      clientMutationId: `board-refresh-extra-${++n}`,
      spaceId: FIXTURE_SPACE_ID,
      kind: 'task',
      title: `event ${n}`,
    } as never);
  });
};

describe('board re-reads on the durable stream', () => {
  it('are bounded and single-flight, and re-read the same queries', async () => {
    // The limit must actually bind, or (a) passes vacuously.
    expect(BOARDS).toBeGreaterThan(EVENT_REFRESH_CONCURRENCY);

    const seam = createFixtureSeam();
    let hold = false;
    let inFlight = 0;
    let maxInFlight = 0;
    const grouped: string[] = [];
    const held: Array<() => void> = [];
    const spied = {
      ...seam,
      async query(input: CollectionQuery) {
        if (input.groupBy === undefined) return seam.query(input);
        grouped.push(JSON.stringify(input));
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          if (hold) await new Promise<void>((r) => held.push(r));
          return await seam.query(input);
        } finally {
          inFlight -= 1;
        }
      },
    };

    const { result, unmount } = renderHook(() => {
      const data = useGateData({ leftKind: 'task', rightKind: 'work_session', seam: spied });
      // Called FROM RENDER, as BoardScreen / EntityListPanel call it.
      const boards = FILTERS.map((f) => data.boardFor('task')(f as never, 'status'));
      return { data, boards };
    });

    await waitFor(() => expect(result.current.data.ready).toBe(true));
    await waitFor(() => expect(result.current.boards.every((b) => b !== undefined)).toBe(true));
    await waitFor(() => expect(inFlight).toBe(0));
    const loaded = [...grouped].sort();
    expect(loaded).toHaveLength(BOARDS);

    // Every grouped read from here on is an event-driven refresh, and it hangs
    // until released: a grouped read slower than the whole debounce ceiling.
    grouped.length = 0;
    maxInFlight = 0;
    hold = true;

    let n = 0;
    const event = () => act(async () => {
      await seam.commands.createEntity({
        clientMutationId: `board-refresh-${++n}`,
        spaceId: FIXTURE_SPACE_ID,
        kind: 'task',
        title: `event ${n}`,
      } as never);
    });

    await event();
    await waitFor(() => expect(grouped.length).toBeGreaterThan(0), { timeout: 4_000 });

    // Keep the stream moving well past the 2s ceiling while the round hangs.
    const until = Date.now() + EVENT_REFRESH_MAX_WAIT_MS + 1_000;
    while (Date.now() < until) {
      await event();
      await sleep(100);
    }

    // (a) bounded, (b) no second wave behind the first.
    expect(maxInFlight).toBeLessThanOrEqual(EVENT_REFRESH_CONCURRENCY);
    expect(grouped.length).toBe(EVENT_REFRESH_CONCURRENCY);

    // Let the reads through. The round drains its remaining boards, then —
    // because events arrived mid-round — exactly one more round follows.
    hold = false;
    while (held.length > 0) held.shift()!();
    await waitFor(() => expect(grouped.length).toBe(2 * BOARDS), { timeout: 5_000 });
    await waitFor(() => expect(inFlight).toBe(0));
    expect(maxInFlight).toBeLessThanOrEqual(EVENT_REFRESH_CONCURRENCY);

    // (c) the same data is read: each round re-reads exactly the loaded queries.
    expect(grouped.slice(0, BOARDS).sort()).toEqual(loaded);
    expect(grouped.slice(BOARDS).sort()).toEqual(loaded);

    // And no third round with no further events.
    await sleep(EVENT_REFRESH_MAX_WAIT_MS + 200);
    expect(grouped.length).toBe(2 * BOARDS);

    unmount();
    seam.dispose();
  }, 30_000);

  // PR #776 review, SHOULD-1: the refresh `.catch` wrote `{ groups: [], error }`
  // over the cached board, so one refused round (a queue-full 503 arrives
  // exactly when the node is busy) turned every open board into an error panel.
  it('a failed refresh keeps the last good board', async () => {
    const seam = createFixtureSeam();
    let fail = false;
    let failures = 0;
    const spied = {
      ...seam,
      async query(input: CollectionQuery) {
        if (input.groupBy !== undefined && fail) {
          failures += 1;
          throw Object.assign(new Error('upstream_unavailable'), { code: 'upstream_unavailable' });
        }
        return seam.query(input);
      },
    };

    const { result, unmount } = renderHook(() => {
      const data = useGateData({ leftKind: 'task', rightKind: 'work_session', seam: spied });
      const boards = FILTERS.map((f) => data.boardFor('task')(f as never, 'status'));
      return { data, boards };
    });

    await waitFor(() => expect(result.current.data.ready).toBe(true));
    await waitFor(() => expect(result.current.boards.every((b) => b !== undefined)).toBe(true));
    const good = result.current.boards;
    expect(good.every((b) => b!.error === undefined)).toBe(true);
    // Non-vacuous: at least one board has groups that an error board would drop.
    expect(good.some((b) => b!.groups.length > 0)).toBe(true);

    fail = true;
    await eventOn(seam)();
    // The whole round fails, every board's read.
    await waitFor(() => expect(failures).toBe(BOARDS), { timeout: 4_000 });
    await act(async () => { await sleep(50); });

    for (const [i, board] of result.current.boards.entries()) {
      expect(board!.error).toBeUndefined();
      expect(board!.groups).toEqual(good[i]!.groups);
    }

    unmount();
    seam.dispose();
  }, 15_000);

  // PR #776 review, SHOULD-2: disposing the trigger does not cancel a running
  // round, so after a space switch its queued tasks still sent the OLD space's
  // grouped reads — one per cached board, only for the generation check to
  // throw every answer away.
  it('a round in flight across a space switch reads no more of the old space', async () => {
    const seam = createFixtureSeam();
    const [home] = await seam.spaces();
    let hold = false;
    const held: Array<() => void> = [];
    const grouped: CollectionQuery[] = [];
    const spied = {
      ...seam,
      async spaces() {
        return [home!, { ...home!, id: SPACE_B, name: 'Other' }];
      },
      async query(input: CollectionQuery) {
        if (input.groupBy === undefined) return seam.query(input);
        grouped.push(input);
        if (hold) await new Promise<void>((r) => held.push(r));
        return seam.query(input);
      },
    };

    const { result, unmount } = renderHook(() => {
      const data = useGateData({ leftKind: 'task', rightKind: 'work_session', seam: spied });
      const boards = FILTERS.map((f) => data.boardFor('task')(f as never, 'status'));
      return { data, boards };
    });

    await waitFor(() => expect(result.current.data.ready).toBe(true));
    await waitFor(() => expect(result.current.boards.every((b) => b !== undefined)).toBe(true));
    expect(result.current.data.spaceId).toBe(FIXTURE_SPACE_ID);

    grouped.length = 0;
    hold = true;
    await eventOn(seam)();
    // The round is mid-flight: its first batch hangs, the rest are queued.
    await waitFor(() => expect(grouped.length).toBe(EVENT_REFRESH_CONCURRENCY), { timeout: 4_000 });

    act(() => result.current.data.selectSpace(SPACE_B));
    await waitFor(() => expect(result.current.data.spaceId).toBe(SPACE_B));

    hold = false;
    while (held.length > 0) held.shift()!();
    await act(async () => { await sleep(200); });

    const oldSpace = grouped.filter((q) => q.spaceId === FIXTURE_SPACE_ID);
    // Only the batch already in flight at the switch; none of the queued rest.
    expect(oldSpace).toHaveLength(EVENT_REFRESH_CONCURRENCY);

    unmount();
    seam.dispose();
  }, 15_000);
});
