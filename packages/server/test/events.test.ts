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
import { WORKSPACE_EVENT_SCHEMA_VERSION, WorkspaceEventSchema } from '@tm8/contract';
import { InMemorySeqSource, SubscriptionRegistry, WorkspaceEventPublisher, OffContractEventError } from '../src/events/index.js';
import { bootstrap, type BootstrappedServer } from '../src/main.js';

const TEST_CONFIG = { host: '127.0.0.1', port: 0, uiDir: undefined, maxBodyBytes: 1024 * 1024 };

const ACTIVITY = {
  type: 'activity.created',
  activity: { id: 'act_1', verb: 'task.completed', summary: {}, createdAt: '2026-07-25T00:00:00.000Z' },
} as const;

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
    const { delivered } = await events.publish('space_1', ACTIVITY);
    expect(delivered).toBe(1);

    const parsed = WorkspaceEventSchema.safeParse(JSON.parse(await received));
    expect(parsed.success, 'client received an off-contract event').toBe(true);
    if (parsed.success) {
      expect(parsed.data.spaceId).toBe('space_1');
      expect(parsed.data.seq).toBe(1);
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
    await events.publish('space_1', ACTIVITY, { clientMutationId: 'cmid_abc' });
    expect((JSON.parse(await received) as { clientMutationId?: string }).clientMutationId).toBe('cmid_abc');
    ws.close();
  });

  it('does not deliver events for spaces the client did not subscribe to', async () => {
    const { url, subscriptions, events } = await startServer();
    const ws = await connect(url);
    await waitFor(() => subscriptions.size() === 1);
    subscriptions.subscribe(subscriptions.sinks()[0]!.id, 'space_1');

    const { delivered } = await events.publish('space_2', ACTIVITY);
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
  it('is monotonic per space and independent across spaces', () => {
    const seq = new InMemorySeqSource();
    expect(seq.next('a')).toBe(1);
    expect(seq.next('a')).toBe(2);
    expect(seq.next('b')).toBe(1);
    expect(seq.next('a')).toBe(3);
  });

  it('REFUSES to emit an event that is not on the contract', async () => {
    const publisher = new WorkspaceEventPublisher(new InMemorySeqSource(), new SubscriptionRegistry());
    await expect(
      // A plausible-looking invention: no such event type exists.
      publisher.publish('space_1', { type: 'entity.exploded', boom: true } as never),
    ).rejects.toBeInstanceOf(OffContractEventError);
  });

  it('refuses a real event type carrying an extra field (schemas are strict)', async () => {
    const publisher = new WorkspaceEventPublisher(new InMemorySeqSource(), new SubscriptionRegistry());
    await expect(
      publisher.publish('space_1', { ...ACTIVITY, sneaky: 'extra' } as never),
    ).rejects.toBeInstanceOf(OffContractEventError);
  });
});
