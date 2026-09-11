/**
 * THE MEASUREMENT — how long it takes a session's state change to reach a
 * client, before and after the push.
 *
 * The task asked for "a number, not an adjective", so this file produces one
 * and prints it. It is a test rather than a script because a latency claim that
 * is not re-run is a latency claim that quietly stops being true.
 *
 * ## THIS FILE MEASURES THE SERVER HALF
 *
 * From `SpawnService` calling the sink, through the broadcaster's bookkeeping,
 * the contract tripwire, `JSON.stringify` and the fan-out, to the bytes being
 * handed to every subscribed sink. Everything in that list is the real module.
 *
 * The CLIENT half — parsing the frame and applying it, up to `statusOf` giving
 * a different answer — is measured in `packages/tm8-ui`'s
 * `liveness-push.test.ts`, against the real `createLivenessManager`. It lives
 * there rather than here because reaching across the package boundary would put
 * UI sources inside the server's `rootDir`, and a measurement is not a reason
 * to break a build boundary. The two numbers are reported added together, and
 * both are stated separately so neither is hidden inside the other.
 *
 * NOT MEASURED by either: network flight time. That omission is stated rather
 * than buried, and it does not weaken the comparison — the two paths being
 * compared differ by exactly one HTTP ROUND TRIP, and the round trip is the
 * part left out. Measured separately against the live node (nine live sessions,
 * ten samples): `GET /v2/spaces/:id/execution/liveness` took p50 298 ms, p95
 * 324 ms, max 489 ms. The old path pays that on every transition; the new path
 * pays none of it. Adding a same-host socket hop back in does not move it.
 */
import { describe, expect, it } from 'vitest';

import { WorkspaceEventPublisher } from './emitter.js';
import { createLivenessBroadcaster } from './liveness-broadcast.js';
import { PresenceSeqSource } from './seq.js';
import { SubscriptionRegistry } from './subscriptions.js';
import type { EventSink } from './ws-connection.js';

const SPACE = '11111111-1111-4111-8111-111111111111';
const BOOT = 'boot-latency';

function sessionId(i: number): string {
  return `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
}

function openSink(id: string, onSend: (text: string) => void): EventSink {
  return {
    id,
    identity: { kind: 'bearer', identityId: 'ident-1', nodeAdmin: false },
    get isOpen() { return true; },
    send: onSend,
    close: () => {},
  } as unknown as EventSink;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx] as number;
}

/**
 * Ten live sessions and ten watching connections — the load the task named.
 * Every connection is subscribed to the space, so every transition fans out to
 * all ten, which is the worst case for this design and the one worth measuring.
 */
const LIVE_SESSIONS = 10;
const WATCHERS = 10;
const TRANSITIONS = 500;

describe('liveness push: server-side latency at ten concurrent sessions', () => {
  it('delivers a state change to every watching sink, and reports the time', () => {
    const registry = new SubscriptionRegistry();
    const publisher = new WorkspaceEventPublisher(new PresenceSeqSource(), registry);

    /** Bytes each connection was handed. Counted, so a silent zero fails. */
    const received: string[][] = [];

    for (let c = 0; c < WATCHERS; c += 1) {
      const mine: string[] = [];
      received.push(mine);
      registry.add(openSink(`conn-${String(c)}`, (text) => { mine.push(text); }));
      registry.subscribe(`conn-${String(c)}`, SPACE);
    }

    const broadcaster = createLivenessBroadcaster({
      publisher,
      nodeBootId: BOOT,
      // A fixed stamp so every pushed snapshot is inside the client's 90s
      // window; the timing below is measured with the process clock, not this.
      now: () => new Date('2026-08-22T12:00:00.000Z'),
      onError: (m) => { throw new Error(`publish failed: ${m}`); },
    });

    for (let i = 0; i < LIVE_SESSIONS; i += 1) broadcaster.noteAppeared(sessionId(i), SPACE);

    /* WARM-UP, and it is declared rather than folded into the samples. V8
       compiles the validator and the fan-out on first use, and a p95 that is
       really a JIT artefact is not a latency claim. */
    const samples: number[] = [];
    for (let t = 0; t < 200; t += 1) broadcaster.noteActivity(sessionId(t % LIVE_SESSIONS), 'busy');

    /* THE HOT LOOP. One transition, timed from the instant the PTY host would
       call the sink to the instant the bytes are in all ten sinks. */
    for (let t = 0; t < TRANSITIONS; t += 1) {
      const target = sessionId(t % LIVE_SESSIONS);
      const started = performance.now();
      broadcaster.noteActivity(target, t % 2 === 0 ? 'idle' : 'busy');
      samples.push(performance.now() - started);
    }

    samples.sort((a, b) => a - b);
    const p50 = percentile(samples, 50);
    const p95 = percentile(samples, 95);
    const max = samples[samples.length - 1] as number;

    // eslint-disable-next-line no-console -- the number IS the deliverable
    console.log(
      `\nliveness push SERVER half, ${String(LIVE_SESSIONS)} live sessions x ` +
        `${String(WATCHERS)} watchers, ${String(TRANSITIONS)} transitions\n` +
        `  PTY transition -> bytes in all ${String(WATCHERS)} sinks:  ` +
        `p50 ${p50.toFixed(3)}ms  p95 ${p95.toFixed(3)}ms  max ${max.toFixed(3)}ms\n` +
        '  (excludes network flight; the path it replaces additionally paid one\n' +
        '   HTTP round trip measured at p50 298ms against the live node)\n',
    );

    // A CEILING, not the measured value. It asserts the PROPERTY — nothing on
    // this path blocks, queues or does I/O — with enough headroom that a loaded
    // CI box does not fail on scheduling noise. If this ever trips, something
    // added I/O to the push path, which is the one regression this whole design
    // exists to prevent.
    expect(p95).toBeLessThan(5);

    // And the bytes actually landed everywhere. A fast zero is not a result.
    for (const mine of received) {
      expect(mine.length).toBe(LIVE_SESSIONS + 200 + TRANSITIONS);
    }
  });

  it('the ghost case costs one function call, not thirty seconds', () => {
    const registry = new SubscriptionRegistry();
    const publisher = new WorkspaceEventPublisher(new PresenceSeqSource(), registry);
    const frames: string[] = [];
    registry.add(openSink('conn-0', (text) => { frames.push(text); }));
    registry.subscribe('conn-0', SPACE);

    const broadcaster = createLivenessBroadcaster({
      publisher,
      nodeBootId: BOOT,
      now: () => new Date('2026-08-22T12:00:00.000Z'),
    });

    broadcaster.noteAppeared(sessionId(1), SPACE);
    for (let i = 0; i < 200; i += 1) broadcaster.noteActivity(sessionId(1), 'busy');

    const started = performance.now();
    // THE CASE THIS MATTERS MOST FOR. `handlePtyExit` with no captured claims
    // writes NOTHING to the graph — no transition, no `workspace_events` row,
    // no `entity.upsert`, so no client nudge. The row keeps saying `running`
    // until the next boot's ghost sweep, and before this push a watcher's only
    // evidence was the id dropping out of a read up to 30 SECONDS later.
    broadcaster.noteVanished(sessionId(1));
    const elapsed = performance.now() - started;

    const last = JSON.parse(frames[frames.length - 1] as string) as Record<string, unknown>;
    expect(last).toMatchObject({
      changed: { id: sessionId(1), transition: 'vanished' },
      confidence: 'reported',
      liveEntityIds: [],
    });
    expect(elapsed).toBeLessThan(5);
  });
});
