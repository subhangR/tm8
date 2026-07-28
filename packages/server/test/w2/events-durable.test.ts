/**
 * W2.G10 — the client→server control channel, and the authorization that must
 * ship WITH it rather than after it.
 *
 * ## Why the negative half is written first
 *
 * `SubscriptionAuthorizer` has existed in subscriptions.ts since the skeleton,
 * with `AllowAllSubscriptionAuthorizer` whose own docstring says it "MUST NOT
 * ship past W2". Before this file, `canSubscribe` had ZERO call sites anywhere
 * in packages/ — the interface, its allow-all implementation, and nothing else.
 * A written authorizer that nothing invokes is a comment, not a defence.
 *
 * It was inert only because nothing could subscribe from the wire. Landing the
 * control protocol is precisely what arms it, so the test that a subscriber
 * CANNOT reach another Space's events is written before the test that it can
 * reach its own. Every negative here has a positive half, because a guard that
 * refuses everyone passes every negative test ever written.
 *
 * ## These are seam tests, deliberately
 *
 * They drive `createControlChannel` directly with fake sinks rather than
 * through a real socket. The RFC 6455 transport is already covered by
 * test/events.test.ts and test/frame.test.ts against a real WebSocket client;
 * what is NOT covered anywhere is what the frames MEAN and who is allowed to
 * send them, which is what this file is for. The DB-backed proof that the
 * authorizer's predicate matches `spaces.get`'s lives in test/db/w2-events.pg.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  WORKSPACE_EVENT_SCHEMA_VERSION,
  WorkspaceControlFrameSchema,
  type DurableWorkspaceEvent,
} from '@tm8/contract';

import { createControlChannel, type SubscriptionAuthorizer } from '../../src/events/control.js';
import { createDurableEventPump } from '../../src/events/pump.js';
import { WorkspaceEventPublisher } from '../../src/events/emitter.js';
import type { DurableEventLog, DurableEventPage } from '../../src/events/poll.js';
import { PresenceSeqSource } from '../../src/events/seq.js';
import { SubscriptionRegistry } from '../../src/events/subscriptions.js';
import type { EventSink } from '../../src/events/ws-connection.js';
import type { RequestIdentity } from '../../src/http/types.js';

const ALLOWED = 'space_allowed';
const DENIED = 'space_denied';

/** A sink that records what it was sent. The whole point is what does NOT arrive. */
class RecordingSink implements EventSink {
  readonly sent: string[] = [];
  isOpen = true;

  constructor(
    readonly id: string = 'conn_1',
    readonly identity: RequestIdentity = { kind: 'auto-owner', identityId: 'identity_1' },
  ) {}

  send(text: string): void {
    this.sent.push(text);
  }

  close(): void {
    this.isOpen = false;
    for (const handler of this.closeHandlers) handler(1000, '');
  }

  // The transport half of EventSink. These tests drive the control channel, not
  // the socket, so nothing here reads from the wire — but they must EXIST or
  // this class is not an EventSink, and a structural stand-in that silently
  // omits part of the interface is how a seam test stops testing the seam.
  private readonly messageHandlers: Array<(text: string) => void> = [];
  private readonly closeHandlers: Array<(code: number, reason: string) => void> = [];

  onMessage(handler: (text: string) => void): void {
    this.messageHandlers.push(handler);
  }

  onClose(handler: (code: number, reason: string) => void): void {
    this.closeHandlers.push(handler);
  }

  /** Everything delivered, parsed. */
  all(): Array<Record<string, unknown>> {
    return this.sent.map((t) => JSON.parse(t) as Record<string, unknown>);
  }

  /**
   * Only the WorkspaceEvents.
   *
   * The socket carries two server→client shapes: events, and `control.*` acks.
   * A test about what a subscriber may SEE must count only the former, or a
   * refusal ack would register as a delivery and mask a leak.
   */
  events(): Array<Record<string, unknown>> {
    return this.all().filter((m) => !String(m['type']).startsWith('control.'));
  }

  /** Only the refusal acks. */
  acks(): Array<Record<string, unknown>> {
    return this.all().filter((m) => String(m['type']).startsWith('control.'));
  }
}

/**
 * Authorizes exactly one Space. Note it authorizes on IDENTITY, not on
 * connection id: the question "may this caller read this Space" is a property
 * of who they are, and an authorizer keyed on a connection handle cannot answer
 * it without a lookup that would have to trust the caller's own claim.
 */
const oneSpaceAuthorizer: SubscriptionAuthorizer = {
  canSubscribe: (_identity, spaceId) => Promise.resolve(spaceId === ALLOWED),
};

function durable(spaceId: string, seq: number): DurableWorkspaceEvent {
  return {
    type: 'activity.created',
    activity: { id: `act_${String(seq)}`, verb: 'task.completed', summary: {}, createdAt: '2026-07-27T00:00:00.000Z' },
    spaceId,
    seq,
    occurredAt: '2026-07-27T00:00:00.000Z',
    schemaVersion: WORKSPACE_EVENT_SCHEMA_VERSION,
  };
}

/** A log stub that serves a fixed set of events, filtered by seq like the real one. */
function fakeLog(events: DurableWorkspaceEvent[]): DurableEventLog & { calls: Array<{ spaceId: string; since: number }> } {
  const calls: Array<{ spaceId: string; since: number }> = [];
  return {
    calls,
    since(spaceId: string, sinceSeq: number, limit: number): Promise<DurableEventPage> {
      calls.push({ spaceId, since: sinceSeq });
      const items = events.filter((e) => e.spaceId === spaceId && e.seq > sinceSeq).slice(0, limit);
      return Promise.resolve({
        items,
        nextCursor: String(items.at(-1)?.seq ?? sinceSeq),
      });
    },
  };
}

interface Harness {
  registry: SubscriptionRegistry;
  publisher: WorkspaceEventPublisher;
  sink: RecordingSink;
  send(frame: unknown): Promise<void>;
  log: ReturnType<typeof fakeLog>;
}

function harness(opts: { authorizer?: SubscriptionAuthorizer; events?: DurableWorkspaceEvent[] } = {}): Harness {
  const registry = new SubscriptionRegistry();
  const publisher = new WorkspaceEventPublisher(new PresenceSeqSource(), registry);
  const sink = new RecordingSink();
  registry.add(sink);
  const log = fakeLog(opts.events ?? []);
  const channel = createControlChannel({
    registry,
    authorizer: opts.authorizer ?? oneSpaceAuthorizer,
    log,
    claimsFor: () => Promise.resolve({ identityId: 'identity_1' }),
  });
  return {
    registry,
    publisher,
    sink,
    log,
    send: (frame) => channel.handle(sink, typeof frame === 'string' ? frame : JSON.stringify(frame)),
  };
}

// ---------------------------------------------------------------------------
// The negative half — written first, on purpose.
// ---------------------------------------------------------------------------

describe('W2.G10 subscription authorization (negative half first)', () => {
  it('does NOT deliver a Space’s events to a connection the authorizer refused', async () => {
    const h = harness();

    await h.send({ type: 'subscribe', spaceIds: [DENIED] });

    // The refusal is structural: the Space never entered the fan-out set, so
    // there is no later `if` that has to remember to exclude it.
    expect(h.registry.spacesFor(h.sink.id)).toEqual([]);

    const { delivered } = h.publisher.publishDurable(durable(DENIED, 1));
    expect(delivered, 'a refused Space must reach zero sinks').toBe(0);
    expect(h.sink.events(), 'no event may reach a refused subscriber').toEqual([]);

    // ...and the refusal is OBSERVABLE. Silence here would be indistinguishable
    // from a Space that is merely quiet, and the client would wait forever.
    expect(h.sink.acks()).toEqual([
      { type: 'control.refused', frame: 'subscribe', spaceId: DENIED, reason: 'forbidden' },
    ]);
  });

  it('refuses the denied Space but still serves the allowed one in the SAME frame', async () => {
    // The half that stops the guard passing by refusing everyone — and the
    // sharper version of it: a single frame naming both must not be all-or-
    // nothing in either direction.
    const h = harness();

    await h.send({ type: 'subscribe', spaceIds: [ALLOWED, DENIED] });

    expect(h.registry.spacesFor(h.sink.id)).toEqual([ALLOWED]);

    expect(h.publisher.publishDurable(durable(DENIED, 1)).delivered).toBe(0);
    expect(h.publisher.publishDurable(durable(ALLOWED, 1)).delivered).toBe(1);

    const received = h.sink.events();
    expect(received).toHaveLength(1);
    expect(received[0]?.['spaceId']).toBe(ALLOWED);

    // Exactly one refusal, naming the Space that was refused — not a blanket
    // "frame rejected" that would leave the client guessing which id was bad.
    expect(h.sink.acks()).toEqual([
      { type: 'control.refused', frame: 'subscribe', spaceId: DENIED, reason: 'forbidden' },
    ]);
  });

  it('a resume for an unauthorized Space replays NOTHING, and does not even read the log', async () => {
    // The shape the coordinator flagged: a shared routine invoked BEFORE the
    // caller's authorization, returning caller-influenced data. Replay is
    // exactly where that hides, so this asserts the log was never consulted —
    // not merely that the result was empty.
    const h = harness({ events: [durable(DENIED, 1), durable(DENIED, 2)] });

    await h.send({ type: 'resume', spaceId: DENIED, since: 0 });

    expect(h.sink.events(), 'no replayed event may leak').toEqual([]);
    expect(h.log.calls, 'the log must not be read before authorization decides').toEqual([]);
    expect(h.sink.acks()).toEqual([
      { type: 'control.refused', frame: 'resume', spaceId: DENIED, reason: 'forbidden' },
    ]);
  });

  it('replays the authorized Space after the cursor — the positive half of resume', async () => {
    const h = harness({ events: [durable(ALLOWED, 1), durable(ALLOWED, 2), durable(ALLOWED, 3)] });

    await h.send({ type: 'subscribe', spaceIds: [ALLOWED] });
    await h.send({ type: 'resume', spaceId: ALLOWED, since: 1 });

    const seqs = h.sink.events().map((e) => e['seq']);
    expect(seqs, 'exactly the events after the cursor, in order').toEqual([2, 3]);
    expect(h.log.calls).toEqual([{ spaceId: ALLOWED, since: 1 }]);
  });
});

// ---------------------------------------------------------------------------
// Frame semantics
// ---------------------------------------------------------------------------

describe('W2.G10 control frames', () => {
  it('unsubscribe stops delivery that was demonstrably flowing first', async () => {
    const h = harness();
    await h.send({ type: 'subscribe', spaceIds: [ALLOWED] });

    // Positive first: prove there was something to stop.
    expect(h.publisher.publishDurable(durable(ALLOWED, 1)).delivered).toBe(1);

    await h.send({ type: 'unsubscribe', spaceIds: [ALLOWED] });

    expect(h.registry.spacesFor(h.sink.id)).toEqual([]);
    expect(h.publisher.publishDurable(durable(ALLOWED, 2)).delivered).toBe(0);
    expect(h.sink.events()).toHaveLength(1);
  });

  it('presence is OFF until toggled, and never rides the durable stream (DEV-4)', async () => {
    const h = harness();
    await h.send({ type: 'subscribe', spaceIds: [ALLOWED] });

    const presenceBody = {
      type: 'typing.changed' as const,
      anchorId: 'ent_1',
      typingActorIds: ['mem_1'],
    };

    // Subscribed, but presence not toggled: the ephemeral channel is silent.
    expect((await h.publisher.publishPresence(ALLOWED, presenceBody)).delivered).toBe(0);

    await h.send({ type: 'presence', on: true });
    expect((await h.publisher.publishPresence(ALLOWED, presenceBody)).delivered).toBe(1);

    // ...and toggling presence did not add a durable subscription, nor did the
    // presence event acquire a durable seq. The two channels stay separate.
    const delivered = h.sink.events();
    expect(delivered.every((e) => e['type'] === 'typing.changed')).toBe(true);

    await h.send({ type: 'presence', on: false });
    expect((await h.publisher.publishPresence(ALLOWED, presenceBody)).delivered).toBe(0);
  });

  it('presence cannot be used to observe a Space the caller never subscribed to', async () => {
    // Presence is a per-connection flag; it must not become a side channel that
    // widens which Spaces a connection can hear from.
    const h = harness();
    await h.send({ type: 'presence', on: true });

    expect((await h.publisher.publishPresence(ALLOWED, {
      type: 'typing.changed', anchorId: 'ent_1', typingActorIds: [],
    })).delivered).toBe(0);
    expect(h.sink.sent).toEqual([]);
  });

  it('rejects a malformed frame instead of partially applying it', async () => {
    const h = harness();

    // Unknown key — the schema is .strict(), so this is not a subscribe with an
    // extra field, it is not a subscribe at all.
    await h.send({ type: 'subscribe', spaceIds: [ALLOWED], sneaky: true });
    expect(h.registry.spacesFor(h.sink.id)).toEqual([]);

    await h.send('not json at all');
    expect(h.registry.spacesFor(h.sink.id)).toEqual([]);

    await h.send({ type: 'subscribe' });
    expect(h.registry.spacesFor(h.sink.id)).toEqual([]);

    // And the connection survives all of it — a bad frame is not fatal.
    expect(h.sink.isOpen).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Live delivery: subscribe means membership, NOT replay
// ---------------------------------------------------------------------------

/**
 * These cover a defect this suite originally missed: nothing seeded the pump's
 * cursor, so a fresh `subscribe` defaulted to seq 0 and the first tick pushed
 * retained history at the client. The contract prose says `subscribe` is
 * membership and `resume` is replay — and they are separate frames precisely so
 * subscribing never implicitly replays — so the implementation was contradicting
 * its own contract. A documented invariant with nothing enforcing it.
 */
describe('W2.G10 live delivery cursors', () => {
  const history = [durable(ALLOWED, 1), durable(ALLOWED, 2), durable(ALLOWED, 3)];

  function pumped(opts: { mark?: number | null } = {}) {
    const registry = new SubscriptionRegistry();
    const publisher = new WorkspaceEventPublisher(new PresenceSeqSource(), registry);
    const sink = new RecordingSink();
    registry.add(sink);
    const log = fakeLog(history);
    const pump = createDurableEventPump({
      registry,
      publisher,
      log,
      claimsFor: () => Promise.resolve({ identityId: 'identity_1' }),
    });
    const channel = createControlChannel({
      registry,
      authorizer: oneSpaceAuthorizer,
      log,
      claimsFor: () => Promise.resolve({ identityId: 'identity_1' }),
      cursors: pump,
      highWaterMark: () => Promise.resolve(opts.mark === undefined ? 3 : opts.mark),
    });
    return {
      sink, pump, log,
      send: (frame: unknown) => channel.handle(sink, JSON.stringify(frame)),
    };
  }

  it('a bare subscribe delivers NO history — it is membership, not replay', async () => {
    const h = pumped();
    await h.send({ type: 'subscribe', spaceIds: [ALLOWED] });

    // The whole retained log exists and is readable; the point is that none of
    // it is pushed at a client that only asked to be subscribed.
    expect(await h.pump.tick()).toBe(0);
    expect(h.sink.events(), 'subscribe must not replay').toEqual([]);
  });

  it('...but delivers events that arrive AFTER the subscribe — the positive half', async () => {
    const h = pumped();
    await h.send({ type: 'subscribe', spaceIds: [ALLOWED] });
    expect(await h.pump.tick()).toBe(0);

    // A new event lands past the mark the subscribe seeded at.
    history.push(durable(ALLOWED, 4));
    try {
      expect(await h.pump.tick()).toBe(1);
      expect(h.sink.events().map((e) => e['seq'])).toEqual([4]);
    } finally {
      history.pop();
    }
  });

  it('leaves the connection UNSEEDED when the mark cannot be established, rather than replaying from zero', async () => {
    // `latest()` returns null for "I cannot establish the mark" — which is NOT
    // "zero". Seeding at zero here would push the entire retained log at a
    // client that asked for none of it.
    const h = pumped({ mark: null });
    await h.send({ type: 'subscribe', spaceIds: [ALLOWED] });

    expect(await h.pump.tick(), 'no cursor means no live delivery').toBe(0);
    expect(h.sink.events()).toEqual([]);
    // It is subscribed — it simply has no start point yet, and `resume` is how
    // the client supplies one.
  });

  it('resume hands over to live delivery with no gap and no duplicate', async () => {
    const h = pumped();
    await h.send({ type: 'subscribe', spaceIds: [ALLOWED] });
    await h.send({ type: 'resume', spaceId: ALLOWED, since: 1 });

    expect(h.sink.events().map((e) => e['seq'])).toEqual([2, 3]);

    // The handover: live delivery continues from where the replay stopped.
    // Without it the client either never goes live, or goes live from the
    // subscribe-time mark and re-receives what it was just replayed.
    expect(await h.pump.tick(), 'nothing left to deliver').toBe(0);

    history.push(durable(ALLOWED, 4));
    try {
      expect(await h.pump.tick()).toBe(1);
      const seqs = h.sink.events().map((e) => e['seq']);
      expect(seqs, 'contiguous across the replay/live handover').toEqual([2, 3, 4]);
      expect(new Set(seqs).size).toBe(seqs.length);
    } finally {
      history.pop();
    }
  });
});

// ---------------------------------------------------------------------------
// The contract schema itself
// ---------------------------------------------------------------------------

describe('W2.G10 WorkspaceControlFrameSchema', () => {
  it('accepts exactly the four adopted frames', () => {
    for (const frame of [
      { type: 'subscribe', spaceIds: ['s1'] },
      { type: 'unsubscribe', spaceIds: ['s1', 's2'] },
      { type: 'presence', on: true },
      { type: 'resume', spaceId: 's1', since: 0 },
    ]) {
      expect(WorkspaceControlFrameSchema.safeParse(frame).success, JSON.stringify(frame)).toBe(true);
    }
  });

  it('refuses an unbounded or empty spaceIds list', () => {
    expect(WorkspaceControlFrameSchema.safeParse({ type: 'subscribe', spaceIds: [] }).success).toBe(false);
    const tooMany = Array.from({ length: 101 }, (_, i) => `s${String(i)}`);
    expect(WorkspaceControlFrameSchema.safeParse({ type: 'subscribe', spaceIds: tooMany }).success).toBe(false);
  });

  it('refuses a since cursor that is not a non-negative integer seq', () => {
    for (const since of [-1, 1.5, Number.NaN, '3']) {
      expect(
        WorkspaceControlFrameSchema.safeParse({ type: 'resume', spaceId: 's1', since }).success,
        `since=${String(since)}`,
      ).toBe(false);
    }
  });
});
