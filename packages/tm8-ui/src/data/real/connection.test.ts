/**
 * connection.ts — the LLD §6 state machine, driven entirely by fakes.
 *
 * ZERO NETWORK: the WebSocket is a `FakeSocket`, `poll` is a closure, and the
 * clock is manual. No test here can reach :4610, :5442, or anything else — the
 * manager has no way to construct a transport of its own.
 */
import { describe, expect, it } from 'vitest';
import { CollabError, type DurableWorkspaceEvent, type SpaceId } from '@tm8/contract';
import { createConnectionManager, toCursor, type ConnectionManager } from './connection';
import type { DurableEventPage } from './ops';
import type { ConnectionState } from '../seam';
import { FakeClock, fakeSocketPool, flush, type FakeSocketPool } from './test-support';

interface PollCall { spaceId: SpaceId; since: number }

interface Harness {
  conn: ConnectionManager;
  clock: FakeClock;
  pool: FakeSocketPool;
  polls: PollCall[];
  events: DurableWorkspaceEvent[];
  phases: ConnectionState[];
  resyncs: SpaceId[];
  refusals: Array<{ spaceId: SpaceId; error: CollabError }>;
  reconnects: number;
  setPoll(fn: (call: PollCall) => DurableEventPage | Promise<DurableEventPage>): void;
}

function mk(config?: Parameters<typeof createConnectionManager>[0]['config']): Harness {
  const clock = new FakeClock();
  const pool = fakeSocketPool();
  const polls: PollCall[] = [];
  const events: DurableWorkspaceEvent[] = [];
  const phases: ConnectionState[] = [];
  const resyncs: SpaceId[] = [];
  const refusals: Array<{ spaceId: SpaceId; error: CollabError }> = [];
  const counters = { reconnects: 0 };
  let pollFn: (call: PollCall) => DurableEventPage | Promise<DurableEventPage> =
    (call) => ({ items: [], nextCursor: String(call.since) });

  const conn = createConnectionManager({
    wsUrl: 'ws://fake.invalid/v2/ws',
    webSocketFactory: pool.factory,
    poll: async (spaceId, since) => {
      const call = { spaceId, since };
      polls.push(call);
      return pollFn(call);
    },
    timers: clock.timers,
    now: clock.now,
    random: clock.random,
    config,
  });

  conn.onEvent((e) => events.push(e));
  conn.onConnection((s) => phases.push(s));
  conn.onResync((s) => resyncs.push(s));
  conn.onSpaceRefused((spaceId, error) => refusals.push({ spaceId, error }));
  conn.onReconnect(() => { counters.reconnects += 1; });

  return {
    conn, clock, pool, polls, events, phases, resyncs, refusals,
    get reconnects() { return counters.reconnects; },
    setPoll(fn) { pollFn = fn; },
  } as Harness;
}

/** `Array.prototype.at` is ES2022; this package targets ES2021. */
function lastFrame(ws: { frames(): Array<Record<string, unknown>> }): Record<string, unknown> | undefined {
  const frames = ws.frames();
  return frames[frames.length - 1];
}

function ev(spaceId: SpaceId, seq: number): DurableWorkspaceEvent {
  return {
    type: 'entity.upsert',
    spaceId,
    seq,
    occurredAt: '2026-07-28T12:00:00.000Z',
    schemaVersion: 1,
    entity: { id: `e-${seq}` },
  } as unknown as DurableWorkspaceEvent;
}

// ---------------------------------------------------------------------------

describe('connection: connect — subscribe is ALWAYS followed by resume', () => {
  it('sends subscribe then resume(0) on a first-ever open', () => {
    const h = mk();
    h.conn.openSpace('sp-1');
    h.pool.last().openIt();

    // Order matters: the fan-out membership, then the only seed this client owns.
    expect(h.pool.last().frames()).toEqual([
      { type: 'subscribe', spaceIds: ['sp-1'] },
      { type: 'resume', spaceId: 'sp-1', since: 0 },
    ]);
    expect(h.conn.getConnection()).toEqual({ phase: 'live' });
  });

  it('resumes EVERY open space, not just the newest', () => {
    const h = mk();
    h.conn.openSpace('sp-1');
    h.conn.openSpace('sp-2');
    h.pool.last().openIt();

    const frames = h.pool.last().frames();
    expect(frames[0]).toEqual({ type: 'subscribe', spaceIds: ['sp-1', 'sp-2'] });
    expect(frames.filter((f) => f.type === 'resume')).toEqual([
      { type: 'resume', spaceId: 'sp-1', since: 0 },
      { type: 'resume', spaceId: 'sp-2', since: 0 },
    ]);
  });

  it('resumes from the ADVANCED cursor after a reconnect, never from 0 again', () => {
    const h = mk();
    h.conn.openSpace('sp-1');
    h.pool.last().openIt();
    h.pool.last().deliver(ev('sp-1', 42));

    h.pool.last().drop();
    h.clock.advance(1_000);           // fire the backoff timer
    h.pool.last().openIt();

    expect(h.pool.last().frames()).toEqual([
      { type: 'subscribe', spaceIds: ['sp-1'] },
      { type: 'resume', spaceId: 'sp-1', since: 42 },
    ]);
  });

  it('re-opening an ALREADY-open space on a live socket sends nothing (idempotent)', () => {
    // server-owner re-review advisory: the seq law would drop the duplicates,
    // but generating a redundant replay round is still work nobody asked for.
    const h = mk();
    h.conn.openSpace('sp-1');
    h.pool.last().openIt();
    h.pool.last().deliver(ev('sp-1', 5));
    const settled = h.pool.last().frames().length;

    h.conn.openSpace('sp-1');
    expect(h.pool.last().frames()).toHaveLength(settled);
    expect(h.conn.cursorOf('sp-1')).toBe(5);
  });

  it('a space opened while already live is subscribed and resumed immediately', () => {
    const h = mk();
    h.conn.openSpace('sp-1');
    h.pool.last().openIt();
    const before = h.pool.last().frames().length;

    h.conn.openSpace('sp-2');
    expect(h.pool.last().frames().slice(before)).toEqual([
      { type: 'subscribe', spaceIds: ['sp-2'] },
      { type: 'resume', spaceId: 'sp-2', since: 0 },
    ]);
  });
});

describe('connection: THE seq law — strictly increasing, no duplicates, gaps legal', () => {
  it('drops seq <= lastApplied and delivers strictly increasing', () => {
    const h = mk();
    h.conn.openSpace('sp-1');
    h.pool.last().openIt();
    const ws = h.pool.last();

    ws.deliver(ev('sp-1', 1));
    ws.deliver(ev('sp-1', 2));
    ws.deliver(ev('sp-1', 2));   // exact duplicate — the resume/live overlap
    ws.deliver(ev('sp-1', 1));   // late replay
    ws.deliver(ev('sp-1', 3));

    expect(h.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(h.conn.cursorOf('sp-1')).toBe(3);
  });

  it('accepts GAPS — seq is authoritative and not dense', () => {
    const h = mk();
    h.conn.openSpace('sp-1');
    h.pool.last().openIt();

    h.pool.last().deliver(ev('sp-1', 5));
    h.pool.last().deliver(ev('sp-1', 900));

    expect(h.events.map((e) => e.seq)).toEqual([5, 900]);
    expect(h.conn.cursorOf('sp-1')).toBe(900);
  });

  it('keeps one cursor PER SPACE', () => {
    const h = mk();
    h.conn.openSpace('sp-1');
    h.conn.openSpace('sp-2');
    h.pool.last().openIt();

    h.pool.last().deliver(ev('sp-1', 10));
    h.pool.last().deliver(ev('sp-2', 3));   // lower than sp-1's, and must NOT be dropped

    expect(h.events.map((e) => `${e.spaceId}:${e.seq}`)).toEqual(['sp-1:10', 'sp-2:3']);
  });

  it('never dispatches an event for a space that is not open', () => {
    const h = mk();
    h.conn.openSpace('sp-1');
    h.pool.last().openIt();
    h.pool.last().deliver(ev('sp-other', 1));
    expect(h.events).toEqual([]);
  });

  it('a listener that throws does not stall the stream or the cursor', () => {
    const h = mk();
    h.conn.onEvent(() => { throw new Error('bad listener'); });
    h.conn.openSpace('sp-1');
    h.pool.last().openIt();
    h.pool.last().deliver(ev('sp-1', 1));
    h.pool.last().deliver(ev('sp-1', 2));
    expect(h.events.map((e) => e.seq)).toEqual([1, 2]);
  });
});

describe('connection: the accelerate loop is throughput, not correctness', () => {
  it('re-resumes from the advancing cursor and STOPS when it stops advancing', () => {
    const h = mk({ accelerateIntervalMs: 100 });
    h.conn.openSpace('sp-1');
    h.pool.last().openIt();
    const ws = h.pool.last();

    ws.deliver(ev('sp-1', 200));          // a replay batch landed
    h.clock.advance(100);
    expect(lastFrame(ws)).toEqual({ type: 'resume', spaceId: 'sp-1', since: 200 });

    ws.deliver(ev('sp-1', 400));
    h.clock.advance(100);
    expect(lastFrame(ws)).toEqual({ type: 'resume', spaceId: 'sp-1', since: 400 });

    // Cursor stopped advancing → the loop retires and the pump takes over.
    const settled = ws.frames().length;
    h.clock.advance(10_000);
    expect(ws.frames()).toHaveLength(settled);
  });

  it('never fires after the space closes', () => {
    const h = mk({ accelerateIntervalMs: 100 });
    h.conn.openSpace('sp-1');
    h.pool.last().openIt();
    h.pool.last().deliver(ev('sp-1', 9));
    h.conn.closeSpace('sp-1');
    const settled = h.pool.last().frames().length;
    h.clock.advance(1_000);
    // Only the unsubscribe from closeSpace, no further resume.
    expect(h.pool.last().frames().slice(settled)).toEqual([]);
  });
});

describe('connection: WS lost → polling on the SAME dispatch path', () => {
  it('flips to polling with a disconnectedSince and primes a poll immediately', async () => {
    const h = mk();
    h.conn.openSpace('sp-1');
    h.pool.last().openIt();
    h.pool.last().deliver(ev('sp-1', 7));

    h.pool.last().drop();
    await flush();

    const phase = h.conn.getConnection();
    expect(phase.phase).toBe('polling');
    expect((phase as { disconnectedSince: string }).disconnectedSince).toBe('2026-07-28T12:00:00.000Z');
    // Primed, not one interval stale — and from the cursor, not from zero.
    expect(h.polls).toEqual([{ spaceId: 'sp-1', since: 7 }]);
  });

  it('polled events go through the same dedupe/order law as WS events', async () => {
    const h = mk();
    h.setPoll(({ since }) => ({
      items: since < 3 ? [ev('sp-1', 1), ev('sp-1', 2), ev('sp-1', 3)] : [],
      nextCursor: '3',
    }));
    h.conn.openSpace('sp-1');
    h.pool.last().openIt();
    h.pool.last().deliver(ev('sp-1', 1));    // WS delivered seq 1 already

    h.pool.last().drop();
    await flush();

    // seq 1 arrives again from the poll and is DROPPED by the same rule.
    expect(h.events.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('reuses the string nextCursor VERBATIM as the next since', async () => {
    const h = mk({ pollIntervalMs: 1_500 });
    h.setPoll(() => ({ items: [], nextCursor: '512' }));
    h.conn.openSpace('sp-1');
    h.pool.last().openIt();
    h.pool.last().drop();
    await flush();

    h.clock.advance(1_500);
    await flush();

    expect(h.polls.map((p) => p.since)).toEqual([0, 512]);
  });

  it("the server's cursor wins over observed high-water — the all-rows-skipped wedge", async () => {
    const h = mk();
    // A page whose rows were ALL skipped server-side: no items, but the cursor
    // moved. Without preferring it, `since` would never advance again.
    h.setPoll(() => ({ items: [], nextCursor: '900' }));
    h.conn.openSpace('sp-1');
    h.pool.last().openIt();
    h.pool.last().drop();
    await flush();
    h.clock.advance(1_500);
    await flush();

    expect(h.conn.cursorOf('sp-1')).toBe(900);
    expect(h.polls[h.polls.length - 1]?.since).toBe(900);
  });

  it('the cursor NEVER rewinds — Math.max guards monotonicity', async () => {
    const h = mk();
    h.conn.openSpace('sp-1');
    h.pool.last().openIt();
    h.pool.last().deliver(ev('sp-1', 800));
    h.pool.last().drop();
    // A server that answers with a lower cursor must not re-deliver 800.
    h.setPoll(() => ({ items: [], nextCursor: '5' }));
    await flush();

    expect(h.conn.cursorOf('sp-1')).toBe(800);
  });

  it('a garbage nextCursor falls back to the observed high-water, never to 0', async () => {
    const h = mk();
    h.setPoll(() => ({ items: [ev('sp-1', 11)], nextCursor: '' }));
    h.conn.openSpace('sp-1');
    h.pool.last().openIt();
    h.pool.last().drop();
    await flush();
    expect(h.conn.cursorOf('sp-1')).toBe(11);
  });

  it('a failed poll retries from the SAME cursor — nothing is skipped', async () => {
    const h = mk();
    let attempt = 0;
    h.setPoll(() => {
      attempt += 1;
      if (attempt === 1) throw new CollabError('upstream_unavailable', 'down');
      return { items: [], nextCursor: '0' };
    });
    h.conn.openSpace('sp-1');
    h.pool.last().openIt();
    h.pool.last().deliver(ev('sp-1', 4));
    h.pool.last().drop();
    await flush();
    h.clock.advance(1_500);
    await flush();

    expect(h.polls.map((p) => p.since)).toEqual([4, 4]);
  });
});

describe('connection: polling vs offline is TRANSPORT evidence, never a refusal', () => {
  it('a poll that cannot reach the node goes offline', async () => {
    const h = mk();
    h.setPoll(() => { throw new CollabError('upstream_unavailable', 'ECONNREFUSED'); });
    h.conn.openSpace('sp-1');
    h.pool.last().openIt();
    h.pool.last().drop();
    await flush();

    expect(h.conn.getConnection().phase).toBe('offline');
  });

  it('a poll REFUSED with 403 stays polling — the node answered', async () => {
    const h = mk();
    h.setPoll(() => { throw new CollabError('forbidden', 'no'); });
    h.conn.openSpace('sp-1');
    h.pool.last().openIt();
    h.pool.last().drop();
    await flush();

    expect(h.conn.getConnection().phase).toBe('polling');
  });

  it('offline → polling → live is the full recovery path', async () => {
    const h = mk();
    let reachable = false;
    h.setPoll(() => {
      if (!reachable) throw new CollabError('upstream_unavailable', 'down');
      return { items: [], nextCursor: '0' };
    });
    h.conn.openSpace('sp-1');
    h.pool.last().openIt();
    h.pool.last().drop();
    await flush();
    expect(h.conn.getConnection().phase).toBe('offline');

    reachable = true;
    h.clock.advance(1_500);
    await flush();
    expect(h.conn.getConnection().phase).toBe('polling');

    h.clock.advance(10_000);      // let the backoff fire
    h.pool.last().openIt();
    expect(h.conn.getConnection().phase).toBe('live');

    expect(h.phases.map((p) => p.phase)).toEqual(['live', 'polling', 'offline', 'polling', 'live']);
  });

  it('an HTTP transport failure while LIVE does not fake a disconnect — events are flowing', () => {
    const h = mk();
    h.conn.openSpace('sp-1');
    h.pool.last().openIt();
    h.conn.noteTransport(false);
    expect(h.conn.getConnection()).toEqual({ phase: 'live' });
  });
});

describe('connection: WS regained', () => {
  it('stops the pollers and re-seeds, and reports a reconnect for the liveness cadence', async () => {
    const h = mk();
    h.conn.openSpace('sp-1');
    h.pool.last().openIt();
    h.pool.last().drop();
    await flush();
    expect(h.polls.length).toBeGreaterThan(0);      // the fallback did run while down

    h.clock.advance(10_000);
    // NOTE: polling correctly continues while the reconnecting socket exists
    // but has not yet reached OPEN — a constructed socket is not a live one.
    await flush();
    h.pool.last().openIt();
    expect(h.conn.getConnection().phase).toBe('live');
    expect(h.reconnects).toBe(1);

    const polledBeforeLive = h.polls.length;
    h.clock.advance(30_000);
    await flush();
    expect(h.polls.length).toBe(polledBeforeLive);  // silent from the moment it is live
    expect(h.pool.last().frames().some((f) => f.type === 'resume')).toBe(true);
  });
});

describe('connection: backoff — 0.5s → 8s cap, jittered', () => {
  it('doubles to the cap and never below half the capped delay', () => {
    const h = mk();
    h.conn.openSpace('sp-1');

    const delays: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      const before = h.pool.sockets.length;
      h.pool.last().drop();
      // Walk forward one ms at a time until the reconnect actually fires.
      let waited = 0;
      while (h.pool.sockets.length === before && waited < 20_000) {
        h.clock.advance(1);
        waited += 1;
      }
      delays.push(waited);
    }

    // random() === 0.5 ⇒ factor 0.75 over min(500·2^n, 8000).
    expect(delays).toEqual([375, 750, 1500, 3000, 6000, 6000]);
    expect(Math.max(...delays)).toBeLessThanOrEqual(8_000);
  });

  it('resets the backoff after a socket SURVIVES, not merely after it opens', () => {
    const h = mk();
    h.conn.openSpace('sp-1');
    h.pool.last().drop();
    h.clock.advance(400);
    h.pool.last().drop();
    h.clock.advance(800);
    h.pool.last().openIt();
    // Opening is not working. The counter is forgiven only once the connection
    // has lasted `stableAfterMs`.
    h.clock.advance(30_000);

    const before = h.pool.sockets.length;
    h.pool.last().drop();
    h.clock.advance(374);
    expect(h.pool.sockets.length).toBe(before);
    h.clock.advance(1);
    expect(h.pool.sockets.length).toBe(before + 1);
  });

  it('KEEPS BACKING OFF while a socket opens and is dropped again', () => {
    /*
     * THE DEFECT THIS PINS. `handleOpen` used to zero `reconnectAttempt` the
     * instant the socket opened. A node that accepts a socket and then drops it
     * — auth churn, an eviction, a proxy idle-timeout — therefore reset the
     * counter on every open, so the delay never grew and the client retried
     * every ~500ms indefinitely. The UI mirrored that as a live/polling strobe
     * roughly twice a second, which is what the bug was reported as.
     *
     * Each cycle here opens the socket and drops it well inside
     * `stableAfterMs`, so the backoff must keep climbing.
     */
    const h = mk();
    h.conn.openSpace('sp-1');

    const delays: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      h.pool.last().openIt();
      h.pool.last().drop();          // dropped long before it is stable
      const before = h.pool.sockets.length;
      let waited = 0;
      while (h.pool.sockets.length === before && waited < 20_000) {
        h.clock.advance(1);
        waited += 1;
      }
      delays.push(waited);
    }

    // Strictly increasing: the flap is no longer forgiven.
    expect(delays[1]).toBeGreaterThan(delays[0]!);
    expect(delays[2]).toBeGreaterThan(delays[1]!);
    expect(delays[3]).toBeGreaterThan(delays[2]!);
    // And the old behaviour — a constant ~375ms retry forever — is gone.
    expect(delays.every((d) => d === delays[0])).toBe(false);
  });
});

describe('connection: the resync rule — both triggers (LLD §6)', () => {
  it('a REFUSED resume loses catch-up integrity → onResync for that space', () => {
    const h = mk();
    h.conn.openSpace('sp-1');
    h.pool.last().openIt();
    h.pool.last().deliver({ type: 'control.refused', frame: 'resume', spaceId: 'sp-1', reason: 'forbidden' });
    expect(h.resyncs).toEqual(['sp-1']);
  });

  it('a refused resume with no spaceId resyncs every open space — it cannot be narrowed', () => {
    const h = mk();
    h.conn.openSpace('sp-1');
    h.conn.openSpace('sp-2');
    h.pool.last().openIt();
    h.pool.last().deliver({ type: 'control.refused', frame: 'resume', reason: 'malformed' });
    expect(h.resyncs.sort()).toEqual(['sp-1', 'sp-2']);
  });

  it('a disconnect gap past the threshold resyncs on reconnect', () => {
    const h = mk({ resyncGapMs: 600_000 });
    h.conn.openSpace('sp-1');
    h.pool.last().openIt();
    h.pool.last().drop();

    h.clock.advance(600_001);
    h.pool.last().openIt();

    expect(h.resyncs).toEqual(['sp-1']);
    // And the re-seed still happened, so there is no gap window.
    expect(h.pool.last().frames().some((f) => f.type === 'resume')).toBe(true);
  });

  it('a SHORT gap does not resync — the log replay is honest for 7 days', () => {
    const h = mk({ resyncGapMs: 600_000 });
    h.conn.openSpace('sp-1');
    h.pool.last().openIt();
    h.pool.last().drop();
    h.clock.advance(5_000);
    h.pool.last().openIt();
    expect(h.resyncs).toEqual([]);
  });
});

describe('connection: a refused subscribe is NEVER silent', () => {
  it('surfaces a forbidden CollabError for the named space', () => {
    const h = mk();
    h.conn.openSpace('sp-1');
    h.pool.last().openIt();
    h.pool.last().deliver({ type: 'control.refused', frame: 'subscribe', spaceId: 'sp-1', reason: 'forbidden' });

    expect(h.refusals).toHaveLength(1);
    expect(h.refusals[0]!.spaceId).toBe('sp-1');
    expect(h.refusals[0]!.error).toBeInstanceOf(CollabError);
    expect(h.refusals[0]!.error.code).toBe('forbidden');
    // And it is recorded, so a later openSpace can reject rather than hope.
    expect(h.conn.refusalOf('sp-1')?.code).toBe('forbidden');
  });

  it('a MALFORMED subscribe refusal is a client bug, reported as invalid_input', () => {
    const h = mk();
    h.conn.openSpace('sp-1');
    h.pool.last().openIt();
    h.pool.last().deliver({ type: 'control.refused', frame: 'subscribe', spaceId: 'sp-1', reason: 'malformed' });
    expect(h.refusals[0]!.error.code).toBe('invalid_input');
  });

  it('a refusal is NOT a resync — the two paths must not be confused', () => {
    const h = mk();
    h.conn.openSpace('sp-1');
    h.pool.last().openIt();
    h.pool.last().deliver({ type: 'control.refused', frame: 'subscribe', spaceId: 'sp-1', reason: 'forbidden' });
    expect(h.resyncs).toEqual([]);
  });

  it('closing the space clears the recorded refusal so a deliberate re-open can retry', () => {
    const h = mk();
    h.conn.openSpace('sp-1');
    h.pool.last().openIt();
    h.pool.last().deliver({ type: 'control.refused', frame: 'subscribe', spaceId: 'sp-1', reason: 'forbidden' });
    h.conn.closeSpace('sp-1');
    expect(h.conn.refusalOf('sp-1')).toBeUndefined();
  });
});

describe('connection: closeSpace / dispose', () => {
  it('unsubscribes, stops delivering, and KEEPS the cursor for a same-page re-open', () => {
    const h = mk();
    h.conn.openSpace('sp-1');
    h.pool.last().openIt();
    h.pool.last().deliver(ev('sp-1', 12));

    h.conn.closeSpace('sp-1');
    expect(lastFrame(h.pool.last())).toEqual({ type: 'unsubscribe', spaceIds: ['sp-1'] });

    h.pool.last().deliver(ev('sp-1', 13));
    expect(h.events.map((e) => e.seq)).toEqual([12]);

    h.conn.openSpace('sp-1');
    expect(lastFrame(h.pool.last())).toEqual({ type: 'resume', spaceId: 'sp-1', since: 12 });
  });

  it('dispose closes the socket, cancels every timer and delivers nothing more', async () => {
    const h = mk();
    h.conn.openSpace('sp-1');
    h.pool.last().openIt();
    h.conn.dispose();

    expect(h.pool.last().closeCalls).toBe(1);
    h.clock.advance(60_000);
    await flush();
    expect(h.clock.pending()).toBe(0);
    expect(h.events).toEqual([]);
  });

  it('dispose is idempotent', () => {
    const h = mk();
    h.conn.openSpace('sp-1');
    h.conn.dispose();
    expect(() => h.conn.dispose()).not.toThrow();
  });
});

describe('connection: a socket factory that throws does not stall in "connecting"', () => {
  it('degrades to the poll fallback instead of hanging', async () => {
    const clock = new FakeClock();
    const conn = createConnectionManager({
      wsUrl: 'ws://fake.invalid/v2/ws',
      webSocketFactory: () => { throw new Error('no websocket here'); },
      poll: async () => ({ items: [], nextCursor: '0' }),
      timers: clock.timers,
      now: clock.now,
      random: clock.random,
    });
    conn.openSpace('sp-1');
    await flush();
    expect(conn.getConnection().phase).toBe('polling');
    conn.dispose();
  });
});

describe('toCursor: explicit coercion, because Number("") is 0', () => {
  it('never turns an empty-ish value into a replay-from-zero cursor', () => {
    expect(toCursor('')).toBeNull();
    expect(toCursor('   ')).toBeNull();
    expect(toCursor(null)).toBeNull();
    expect(toCursor([])).toBeNull();
    expect(toCursor('abc')).toBeNull();
    expect(toCursor(Number.NaN)).toBeNull();
    // The control: real cursors still parse.
    expect(toCursor('512')).toBe(512);
    expect(toCursor(512)).toBe(512);
    expect(toCursor('0')).toBe(0);
  });
});

describe('connection: half-open watchdog — silence is probed, not trusted', () => {
  const cfg = { idleProbeAfterMs: 90_000, idleCheckIntervalMs: 45_000 };

  it('a quiet-but-alive socket stays live: the probe finds nothing and believes the quiet', async () => {
    const h = mk(cfg);
    h.conn.openSpace('sp-1');
    h.pool.last().openIt();
    await flush();
    const pollsAfterOpen = h.polls.length;

    // Two checks pass before silence crosses the 90s threshold; the third probes.
    h.clock.advance(45_000);
    await flush();
    expect(h.polls.length).toBe(pollsAfterOpen); // 45s silent: below threshold, no probe

    h.clock.advance(45_000);
    await flush();
    expect(h.polls.length).toBe(pollsAfterOpen + 1); // 90s silent: probed once

    // Empty probe = quiet really was quiet: still live, socket untouched.
    expect(h.conn.getConnection()).toEqual({ phase: 'live' });
    expect(h.pool.last().closeCalls).toBe(0);

    // And the clean probe RESET the silence clock: the next check does not probe.
    h.clock.advance(45_000);
    await flush();
    expect(h.polls.length).toBe(pollsAfterOpen + 1);
    h.conn.dispose();
  });

  it('a dead socket is detected: the log advanced while the socket sat silent → reconnect machinery engages', async () => {
    const h = mk(cfg);
    h.conn.openSpace('sp-1');
    h.pool.last().openIt();
    h.pool.last().deliver(ev('sp-1', 10));
    await flush();
    const firstSocket = h.pool.last();

    // The socket goes half-open: no close event, no frames — but the durable
    // log advances to 12 behind its back.
    h.setPoll(() => ({ items: [ev('sp-1', 11), ev('sp-1', 12)], nextCursor: '12' }));

    // Two steps with a flush between: the recurring check re-arms itself in a
    // microtask, which the manual clock cannot see inside one advance().
    h.clock.advance(45_000);
    await flush();
    h.clock.advance(45_000);
    await flush();

    // The probe's findings were dispatched through the ordinary path…
    expect(h.events.map((e) => e.seq)).toEqual([10, 11, 12]);
    expect(h.conn.cursorOf('sp-1')).toBe(12);
    // …the dead socket was closed, and the normal fallback took over.
    expect(firstSocket.closeCalls).toBe(1);
    expect(h.conn.getConnection().phase).toBe('polling');

    // Backoff then reconnect: the fresh socket resumes from the probed cursor.
    h.clock.advance(1_000);
    const fresh = h.pool.last();
    expect(fresh).not.toBe(firstSocket);
    fresh.openIt();
    expect(fresh.frames()).toEqual([
      { type: 'subscribe', spaceIds: ['sp-1'] },
      { type: 'resume', spaceId: 'sp-1', since: 12 },
    ]);
    h.conn.dispose();
  });

  it('frames arriving keep resetting the silence clock: no probe while events flow', async () => {
    const h = mk(cfg);
    h.conn.openSpace('sp-1');
    h.pool.last().openIt();
    await flush();
    const pollsAfterOpen = h.polls.length;

    for (let seq = 1; seq <= 4; seq++) {
      h.clock.advance(45_000);
      h.pool.last().deliver(ev('sp-1', seq));
      await flush();
    }
    expect(h.polls.length).toBe(pollsAfterOpen); // 3 minutes elapsed, never 90s silent
    expect(h.conn.getConnection()).toEqual({ phase: 'live' });
    h.conn.dispose();
  });
});
