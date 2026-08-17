/**
 * RESUME ON FOREGROUND — the phone lifecycle path (Lane 6).
 *
 * === THE DEFECT, STATED AS A MEASUREMENT ===
 *
 * `connection.ts` had no `visibilitychange` and no `online` handler. Its two
 * recovery mechanisms are both written for a tab that stays open:
 *
 *   - the jittered backoff ladder (0.5s → 8s), and
 *   - the 1.5s `events.poll` fallback.
 *
 * A backgrounded phone gets neither. The OS freezes both timers, and on the way
 * back the client waits out a delay computed from failures measured against a
 * network it has since left. The numbers below are that wait, before and after.
 *
 * === MEASURED, 2026-08-17, worktree off main @ 57443ee2 (printed by this file) ===
 *
 *   time to the next /v2/ws attempt after a foreground, ladder at its cap:
 *       BEFORE (no lifecycle path):  6000ms
 *       AFTER  (resume on visible):     0ms
 *   /v2/ws connections opened by ONE foreground:        1  (not a burst)
 *   /v2/ws connections opened by 20 rapid visibility flaps within the
 *       1s floor:                                       1  (herd protection held)
 *   events.poll requests issued by one foreground:      1  (the frozen poller,
 *       primed immediately instead of up to 1.5s stale)
 *
 * The floor is the whole reason this is safe. `resumeMinIntervalMs` bounds how
 * often the LADDER MAY BE RESET; inside it the ordinary jittered backoff still
 * runs. So a phone flapping visibility against a node that is refusing
 * connections cannot turn the ladder into a hot loop — which is precisely the
 * failure the existing "jitter never below half" comment exists to prevent, and
 * this lane's job was to not undo it.
 */
import { describe, expect, it } from 'vitest';
import type { SpaceId } from '@tm8/contract';
import { createConnectionManager, type LifecycleSource } from './connection';
import type { DurableEventPage } from './ops';
import { FakeClock, fakeSocketPool, flush } from './test-support';

const SPACE = 'sp-phone' as SpaceId;

interface Harness {
  clock: FakeClock;
  pool: ReturnType<typeof fakeSocketPool>;
  polls: number;
  /** Fire the browser signal the manager subscribed to. */
  resume: () => void;
  sockets: () => number;
  dispose: () => void;
}

/**
 * `lifecycle: undefined` is not an option here — the default subscribes to the
 * real DOM, and this file runs in Node. Passing an explicit source is also what
 * lets the "before" case be measured honestly: it is the SAME manager with the
 * signal never delivered, not a different code path.
 */
function mk(opts: { wired: boolean; resumeMinIntervalMs?: number }): Harness {
  const clock = new FakeClock();
  const pool = fakeSocketPool();
  const counters = { polls: 0 };
  let fire: () => void = () => {};

  const lifecycle: LifecycleSource = (onResume) => {
    if (opts.wired) fire = () => onResume('visible');
    return () => {};
  };

  const conn = createConnectionManager({
    wsUrl: 'ws://fake.invalid/v2/ws',
    webSocketFactory: pool.factory,
    poll: async (spaceId, since): Promise<DurableEventPage> => {
      counters.polls += 1;
      return { items: [], nextCursor: String(since) };
    },
    timers: clock.timers,
    now: clock.now,
    random: clock.random,
    lifecycle,
    ...(opts.resumeMinIntervalMs !== undefined
      ? { config: { resumeMinIntervalMs: opts.resumeMinIntervalMs } }
      : {}),
  });

  conn.openSpace(SPACE);

  return {
    clock,
    pool,
    get polls() { return counters.polls; },
    resume: () => fire(),
    sockets: () => pool.sockets.length,
    dispose: () => conn.dispose(),
  } as Harness;
}

/**
 * Drive the ladder to its 8s cap the way a phone does: the socket keeps failing
 * while the radio is down. Each attempt is opened and immediately dropped.
 */
function climbLadderToCap(h: Harness): void {
  h.pool.last().openIt();
  h.pool.last().drop();
  // Each step doubles until the cap; 6 failures is comfortably past 8s.
  for (let i = 0; i < 6; i += 1) {
    h.clock.advance(10_000);
    h.pool.last().drop();
  }
}

/** Fake time until a NEW socket is constructed, in 1ms steps. */
function msUntilNextSocket(h: Harness, limitMs: number): number {
  const before = h.sockets();
  for (let t = 0; t <= limitMs; t += 1) {
    if (h.sockets() > before) return t;
    h.clock.advance(1);
  }
  return Number.POSITIVE_INFINITY;
}

describe('resume on foreground', () => {
  it('BEFORE/AFTER: time to the next /v2/ws attempt once the ladder is at its cap', () => {
    // BEFORE — the signal exists but is never delivered (today's main).
    const before = mk({ wired: false });
    climbLadderToCap(before);
    const beforeMs = msUntilNextSocket(before, 20_000);

    // AFTER — the same manager, foregrounded.
    const after = mk({ wired: true });
    climbLadderToCap(after);
    const socketsBeforeResume = after.sockets();
    after.resume();
    const afterMs = after.sockets() > socketsBeforeResume ? 0 : msUntilNextSocket(after, 20_000);

    console.info(`[lifecycle] time to next /v2/ws attempt — BEFORE ${beforeMs}ms, AFTER ${afterMs}ms`);
    console.info(`[lifecycle] /v2/ws connections opened by ONE foreground: ${after.sockets() - socketsBeforeResume}`);

    // The ladder is genuinely at its cap: 8000 * (0.5 + 0.5*0.5) = 6000.
    expect(beforeMs, 'a foregrounded phone waits out the capped backoff today').toBe(6_000);
    expect(afterMs, 'a foreground must reconnect immediately').toBe(0);
    expect(
      after.sockets() - socketsBeforeResume,
      'one foreground is ONE connection attempt, never a burst',
    ).toBe(1);

    before.dispose();
    after.dispose();
  });

  it('20 rapid visibility flaps inside the floor cost ONE connection', () => {
    // The hazard the floor exists for. A phone emits visibilitychange for the
    // notification shade, the app switcher, a passing share sheet. Without the
    // floor each one would reset the ladder and the client would hammer a node
    // that is already refusing it.
    const h = mk({ wired: true });
    climbLadderToCap(h);
    const start = h.sockets();

    for (let i = 0; i < 20; i += 1) {
      h.resume();
      h.clock.advance(10); // 20 flaps over 200ms, well inside the 1s floor
    }
    const opened = h.sockets() - start;

    console.info(`[lifecycle] /v2/ws connections opened by 20 flaps within the floor: ${opened}`);
    expect(opened, 'the floor must hold: repeated foregrounds cannot defeat backoff').toBe(1);
    h.dispose();
  });

  it('a foreground past the floor is honoured again', () => {
    // The floor de-duplicates; it must not DROP a genuine later resume, or a
    // phone that is backgrounded for an hour would come back to a dead client.
    const h = mk({ wired: true });
    climbLadderToCap(h);
    const start = h.sockets();

    h.resume();
    expect(h.sockets() - start).toBe(1);
    h.pool.last().drop(); // that attempt failed too

    h.clock.advance(2_000); // past resumeMinIntervalMs
    // The ordinary ladder fired during that advance and left an attempt IN
    // FLIGHT. Resuming on top of it must not open a second socket — that is the
    // burst this lane exists to avoid — so the in-flight one is failed first,
    // which is the honest "still no network" state a real resume finds.
    h.pool.last().drop();
    const beforeSecond = h.sockets();
    h.resume();
    expect(
      h.sockets() - beforeSecond,
      'a resume after the floor must be honoured',
    ).toBe(1);
    h.dispose();
  });

  it('a resume NEVER opens a second socket on top of an in-flight attempt', () => {
    // The complement of the test above, stated as its own guarantee: whatever
    // the floor says, `connect()`'s own guard is what makes a foreground during
    // an outstanding attempt free.
    const h = mk({ wired: true, resumeMinIntervalMs: 0 });
    climbLadderToCap(h);
    h.resume();
    const inFlight = h.sockets();

    for (let i = 0; i < 10; i += 1) {
      h.clock.advance(1); // past the (disabled) floor every time
      h.resume();
    }

    expect(
      h.sockets(),
      'an outstanding connection attempt absorbs every further foreground',
    ).toBe(inFlight);
    h.dispose();
  });

  it('primes the frozen events.poll fallback instead of waiting out its interval', async () => {
    // The poller is the other thing the OS froze. Its next tick could be a full
    // 1.5s away, and the whole point of the fallback is that it is primed
    // immediately when the socket is down.
    const h = mk({ wired: true });
    climbLadderToCap(h);
    // The ladder left a poll IN FLIGHT (its promise has not settled because
    // nothing has yielded yet). `pollInFlight` correctly refuses a second
    // concurrent poll, so without this the test would measure the re-entrancy
    // guard rather than the priming.
    await flush();
    const before = h.polls;
    h.resume();

    console.info(`[lifecycle] events.poll requests issued by one foreground: ${h.polls - before}`);
    expect(h.polls - before, 'the frozen poller is primed on resume').toBeGreaterThan(0);
    h.dispose();
  });

  it('a foreground while the socket is LIVE costs nothing', () => {
    // A desktop tab that never hides must pay nothing for this path, and a
    // foreground on a healthy connection is not news.
    const h = mk({ wired: true });
    h.pool.last().openIt();
    const sockets = h.sockets();
    const polls = h.polls;

    for (let i = 0; i < 5; i += 1) {
      h.resume();
      h.clock.advance(5_000);
    }

    expect(h.sockets(), 'a live socket must not be disturbed').toBe(sockets);
    expect(h.polls, 'no poll while the socket is delivering').toBe(polls);
    h.dispose();
  });
});
