/**
 * BridgeRuntimeHub.disconnect (B1b-7): each send stands alone. A socket that
 * closes mid-loop costs only itself, and the answer is true exactly when at
 * least one runtime received the frame.
 */
import { describe, expect, it } from 'vitest';
import type { ServerFrame } from '@tm8/contract';
import { BridgeRuntimeHub } from '../../src/bridges/runtime/hub.js';
import type { Db } from '../../src/db/types.js';
import type { EventSink } from '../../src/events/ws-connection.js';

function sink(id: string, behaviour: 'ok' | 'throws' | 'closed', got: ServerFrame[]): EventSink {
  return {
    id, identity: { kind: 'bearer' }, isOpen: behaviour !== 'closed',
    send: (text: string) => {
      if (behaviour === 'throws') throw new Error('socket closed mid-write');
      got.push(JSON.parse(text) as ServerFrame);
    },
    close: () => undefined, onMessage: () => undefined, onClose: () => undefined,
  };
}

function hubWith(links: Array<[string, EventSink]>): BridgeRuntimeHub {
  // No allowlists or sends are due: the kick() after a disconnect finds nothing.
  const db = { rpc: async () => [] } as unknown as Db;
  const hub = new BridgeRuntimeHub({ db, nodeKey: async () => Buffer.alloc(32), authorize: async () => ({ kind: 'anonymous' }), log: () => undefined });
  const runtimes = (hub as unknown as { runtimes: Map<string, { runtimeId: string; sink: EventSink; provider: string | null }> }).runtimes;
  for (const [runtimeId, s] of links) runtimes.set(runtimeId, { runtimeId, sink: s, provider: 'whatsapp' });
  return hub;
}

describe('BridgeRuntimeHub.disconnect', () => {
  it('a socket closing mid-loop does not reject the call; the runtimes that got the frame count', async () => {
    const got: ServerFrame[] = [];
    const hub = hubWith([['rt-a', sink('a', 'throws', got)], ['rt-b', sink('b', 'ok', got)]]);
    await expect(hub.disconnect('c1', { logout: true })).resolves.toBe(true);
    expect(got).toEqual([{ type: 'disconnect', connectionId: 'c1', logout: true }]);
  });

  it('answers false when every send fails, and when no runtime is open', async () => {
    expect(await hubWith([['rt-a', sink('a', 'throws', [])]]).disconnect('c1', { logout: true })).toBe(false);
    expect(await hubWith([['rt-a', sink('a', 'closed', [])]]).disconnect('c1', { logout: true })).toBe(false);
    expect(await hubWith([]).disconnect('c1', { logout: false })).toBe(false);
  });

  it('sends only to the holding runtime when it is open', async () => {
    const a: ServerFrame[] = [], b: ServerFrame[] = [];
    const hub = hubWith([['rt-a', sink('a', 'ok', a)], ['rt-b', sink('b', 'ok', b)]]);
    expect(await hub.disconnect('c1', { logout: false, runtimeId: 'rt-b' })).toBe(true);
    expect([a, b]).toEqual([[], [{ type: 'disconnect', connectionId: 'c1' }]]);
  });
});
