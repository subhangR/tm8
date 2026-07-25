/**
 * Event-stream tests.
 *
 * These drive a REAL WebSocket client (node's global `WebSocket`) against the
 * real upgrade handler, rather than poking the codec directly. That is
 * deliberate: the hand-rolled RFC 6455 implementation exists precisely so we
 * do not depend on `ws`, and the only honest way to claim it works is to make
 * a standards-compliant client talk to it — handshake, client-side masking,
 * server-side unmasked frames, close handshake, the lot.
 *
 * What is NOT tested, because it does not exist: subscribing from the wire.
 * The contract defines the server→client `WorkspaceEvent` but no client→server
 * control message, so subscriptions are driven server-side here. See the
 * TODO(contract) in events/ws-server.ts — this is a real contract gap, not a
 * test shortcut.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { WORKSPACE_EVENT_SCHEMA_VERSION, WorkspaceEventSchema, type DurableWorkspaceEvent } from '@tm8/contract';
import {
  assertWorkspaceEvent,
  PresenceSeqSource,
  SubscriptionRegistry,
  WorkspaceEventPublisher,
  OffContractEventError,
} from '../src/events/index.js';
import { bootstrap, type BootstrappedServer } from '../src/main.js';

const TEST_CONFIG = { host: '127.0.0.1', port: 0, uiDir: undefined, maxBodyBytes: 1024 * 1024 };

const ACTIVITY = {
  type: 'activity.created',
  activity: { id: 'act_1', verb: 'task.completed', summary: {}, createdAt: '2026-07-25T00:00:00.000Z' },
} as const;

/**
 * A durable event as it comes OFF THE LOG — envelope already stamped.
 *
 * The publisher no longer mints a seq (see events/emitter.ts): durable events
 * are captured by the Postgres trigger and projected, so a test that wants one
 * supplies the envelope the database would have supplied. Deliberately NOT
 * seq 1: these tests assert the publisher forwards the log's number verbatim,
 * which a hardcoded 1 could not distinguish from a counter that happens to
 * start there.
 */
function durable(over: { spaceId?: string; seq?: number; clientMutationId?: string } = {}): DurableWorkspaceEvent {
  const { clientMutationId, ...envelope } = over;
  return {
    ...ACTIVITY,
    spaceId: 'space_1',
    seq: 7,
    occurredAt: '2026-07-25T00:00:00.000Z',
    schemaVersion: WORKSPACE_EVENT_SCHEMA_VERSION,
    ...envelope,
    ...(clientMutationId === undefined ? {} : { clientMutationId }),
  };
}

let running: BootstrappedServer | undefined;

afterEach(async () => {
  await running?.server.close();
  running = undefined;
});

async function startServer(): Promise<BootstrappedServer> {
  running = await bootstrap({ config: TEST_CONFIG });
  return running;
}

/** Open a client socket and resolve once the handshake completed. */
function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${url.replace('http', 'ws')}/v2/ws`);
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', () => reject(new Error('ws connection failed')), { once: true });
  });
}

/** Next text message, or reject after `ms`. */
function nextMessage(ws: WebSocket, ms = 2000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for a ws message')), ms);
    ws.addEventListener(
      'message',
      (ev) => {
        clearTimeout(timer);
        resolve(String((ev as MessageEvent).data));
      },
      { once: true },
    );
  });
}

async function waitFor(predicate: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition never became true');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('websocket scaffold (/v2/ws)', () => {
  it('completes a standards-compliant handshake with a real client', async () => {
    const { url, server } = await startServer();
    const ws = await connect(url);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    await waitFor(() => server.registry !== undefined);
    ws.close();
  });

  it('delivers a durable event, envelope and all, to a subscribed client', async () => {
    const { url, subscriptions, events } = await startServer();
    const ws = await connect(url);

    await waitFor(() => subscriptions.size() === 1);
    const sink = subscriptions.sinks()[0];
    expect(sink).toBeDefined();
    subscriptions.subscribe(sink!.id, 'space_1');

    const received = nextMessage(ws);
    const { delivered } = events.publishDurable(durable({ seq: 7 }));
    expect(delivered).toBe(1);

    const parsed = WorkspaceEventSchema.safeParse(JSON.parse(await received));
    expect(parsed.success, 'client received an off-contract event').toBe(true);
    if (parsed.success) {
      expect(parsed.data.spaceId).toBe('space_1');
      // The log's seq, forwarded verbatim — the server does not renumber events
      // on their way to the socket, or the poll cursor and the socket would
      // disagree about what a client has already seen.
      expect(parsed.data.seq).toBe(7);
      expect(parsed.data.schemaVersion).toBe(WORKSPACE_EVENT_SCHEMA_VERSION);
      expect(typeof parsed.data.occurredAt).toBe('string');
    }
    ws.close();
  });

  it('threads clientMutationId through for optimistic reconciliation (DEV-9)', async () => {
    const { url, subscriptions, events } = await startServer();
    const ws = await connect(url);
    await waitFor(() => subscriptions.size() === 1);
    subscriptions.subscribe(subscriptions.sinks()[0]!.id, 'space_1');

    const received = nextMessage(ws);
    events.publishDurable(durable({ clientMutationId: 'cmid_abc' }));
    expect((JSON.parse(await received) as { clientMutationId?: string }).clientMutationId).toBe('cmid_abc');
    ws.close();
  });

  it('does not deliver events for spaces the client did not subscribe to', async () => {
    const { url, subscriptions, events } = await startServer();
    const ws = await connect(url);
    await waitFor(() => subscriptions.size() === 1);
    subscriptions.subscribe(subscriptions.sinks()[0]!.id, 'space_1');

    const { delivered } = events.publishDurable(durable({ spaceId: 'space_2' }));
    expect(delivered).toBe(0);
    ws.close();
  });

  it('drops the connection from the registry when the client disconnects', async () => {
    const { url, subscriptions } = await startServer();
    const ws = await connect(url);
    await waitFor(() => subscriptions.size() === 1);
    ws.close();
    await waitFor(() => subscriptions.size() === 0);
  });

  it('refuses an upgrade on a path the catalog does not bind', async () => {
    const { url } = await startServer();
    await expect(connect(`${url}/nope`.replace('/nope', ''))).resolves.toBeDefined();
    // A non-/v2/ws upgrade must not become a WebSocket.
    await expect(
      new Promise((resolve, reject) => {
        const bad = new WebSocket(`${url.replace('http', 'ws')}/v2/not-a-socket`);
        bad.addEventListener('open', () => resolve('opened'), { once: true });
        bad.addEventListener('error', () => reject(new Error('refused')), { once: true });
      }),
    ).rejects.toThrow();
  });
});

describe('DEV-4 — presence never rides the durable stream', () => {
  it('a durable subscriber receives no presence events', async () => {
    const { url, subscriptions, events } = await startServer();
    const ws = await connect(url);
    await waitFor(() => subscriptions.size() === 1);
    subscriptions.subscribe(subscriptions.sinks()[0]!.id, 'space_1');

    const { delivered } = await events.publishPresence('space_1', {
      type: 'presence.changed',
      entityId: 'ent_1',
      presence: { viewers: [], typingActorIds: [], updatedAt: '2026-07-25T00:00:00.000Z' },
    });
    // Subscribed to the space, but NOT to the presence channel.
    expect(delivered).toBe(0);
    ws.close();
  });

  it('a presence-channel subscriber receives them', async () => {
    const { url, subscriptions, events } = await startServer();
    const ws = await connect(url);
    await waitFor(() => subscriptions.size() === 1);
    const id = subscriptions.sinks()[0]!.id;
    subscriptions.subscribe(id, 'space_1');
    subscriptions.subscribePresence(id, true);

    const { delivered } = await events.publishPresence('space_1', {
      type: 'typing.changed',
      anchorId: 'ent_1',
      typingActorIds: [],
    });
    expect(delivered).toBe(1);
    ws.close();
  });
});

describe('seq + envelope construction', () => {
  it('the presence counter is monotonic per space and independent across spaces', () => {
    const seq = new PresenceSeqSource();
    expect(seq.next('a')).toBe(1);
    expect(seq.next('a')).toBe(2);
    expect(seq.next('b')).toBe(1);
    expect(seq.next('a')).toBe(3);
  });

  /**
   * S8 regression. Before the split, presence and durable shared one counter, so
   * an ephemeral presence event consumed a durable sequence number. This asserts
   * the two are now unrelated: a durable event carrying seq 7 must not move the
   * presence counter, and presence numbering must not depend on durable traffic.
   */
  it('presence numbering is independent of the durable log (S8)', async () => {
    const presenceSeq = new PresenceSeqSource();
    const publisher = new WorkspaceEventPublisher(presenceSeq, new SubscriptionRegistry());

    publisher.publishDurable(durable({ seq: 7 }));
    expect(presenceSeq.peek('space_1'), 'a durable event must not burn a presence number').toBe(0);

    const { event } = await publisher.publishPresence('space_1', {
      type: 'typing.changed',
      anchorId: 'ent_1',
      typingActorIds: [],
    });
    // 1, not 8: the presence channel starts where it starts regardless of how
    // far the durable log has advanced.
    expect(event.seq).toBe(1);
  });

  it('REFUSES to emit an event that is not on the contract', () => {
    const publisher = new WorkspaceEventPublisher(new PresenceSeqSource(), new SubscriptionRegistry());
    expect(() =>
      // A plausible-looking invention: no such event type exists.
      publisher.publishDurable({ ...durable(), type: 'entity.exploded', boom: true } as never),
    ).toThrow(OffContractEventError);
  });

  it('refuses a real event type carrying an extra field (schemas are strict)', () => {
    const publisher = new WorkspaceEventPublisher(new PresenceSeqSource(), new SubscriptionRegistry());
    expect(() =>
      publisher.publishDurable({ ...durable(), sneaky: 'extra' } as never),
    ).toThrow(OffContractEventError);
  });

  /**
   * The tripwire must guard the POLL path too, not just the socket. `events.poll`
   * never touches the publisher, so a check that lived only in `publishDurable`
   * would leave every polled event unvalidated — which is the majority of
   * delivery for G1A.
   */
  it('the tripwire is reusable outside the publisher (guards the poll path)', () => {
    expect(() => assertWorkspaceEvent({ type: 'nope' }, 'test')).toThrow(OffContractEventError);
    expect(assertWorkspaceEvent(durable(), 'test').type).toBe('activity.created');
  });
});
