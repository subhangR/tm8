/**
 * DEF-17 — the connection seam behind W7's offline banner + queued composer.
 * While disconnected: commands reject `upstream_unavailable` (retryable), the
 * durable stream buffers and replays in order on reconnect (no event loss),
 * presence pulses are dropped (ephemeral), reads keep serving the local world.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { hasConnectionControl } from '../../facade/CollabFacade';
import { connectStores, useConnectionStore } from '../../stores';
import { isCollabError } from '../../types/contract';
import { createRig } from './helpers';

afterEach(() => { useConnectionStore.getState().setConnected(true); });

describe('offline commands', () => {
  it('reject with retryable upstream_unavailable and never touch the world', async () => {
    const { facade, ids } = createRig();
    facade.setConnected(false);
    try {
      await facade.postMessage({ anchorId: ids.chGeneral, body: 'sent offline', actorId: ids.subhang });
      expect.unreachable('should have rejected');
    } catch (e) {
      expect(isCollabError(e)).toBe(true);
      if (isCollabError(e)) {
        expect(e.code).toBe('upstream_unavailable');
        expect(e.retryable).toBe(true);
        expect(e.status).toBe(503);
      }
    }
    // Reads still serve the local world offline (screens keep rendering)…
    const msgs = await facade.getMessages(ids.chGeneral);
    // …and the rejected command left no trace.
    expect(msgs.items.some((m) => m.content.body === 'sent offline')).toBe(false);
  });
});

describe('durable stream pause + replay', () => {
  it('buffers world events while offline and replays them in order on reconnect', async () => {
    const { facade, ids, events } = createRig();
    facade.setConnected(false);
    facade.withWorld((w) => w.postMessage({ anchorId: ids.chGeneral, body: 'first while offline', actorId: ids.mira }));
    facade.withWorld((w) => w.postMessage({ anchorId: ids.chGeneral, body: 'second while offline', actorId: ids.mira }));
    expect(events).toHaveLength(0); // paused — nothing delivered
    facade.setConnected(true);
    const created = events.filter((e) => e.type === 'message.created');
    expect(created).toHaveLength(2); // no event loss
    const bodies = created.map((e) => (e.type === 'message.created' ? e.message.content.body : ''));
    expect(bodies).toEqual(['first while offline', 'second while offline']); // original order
    // Reconnected: subsequent events flow live again.
    const before = events.length;
    await facade.setReaction(ids.docSpec, { reaction: 'star', enabled: true, actorId: ids.subhang });
    expect(events.length).toBeGreaterThan(before);
  });

  it('drops ephemeral presence pulses while offline (never buffered)', () => {
    const { facade, ids, presenceEvents } = createRig();
    facade.setConnected(false);
    facade.withWorld((w) => w.setPresence(ids.docSpec, [ids.mira], [ids.mira]));
    expect(presenceEvents).toHaveLength(0);
    facade.setConnected(true);
    expect(presenceEvents).toHaveLength(0); // dropped, not replayed
    facade.withWorld((w) => w.setPresence(ids.docSpec, [ids.mira]));
    expect(presenceEvents.length).toBeGreaterThan(0); // live again
  });
});

describe('connection status observable', () => {
  it('exposes ConnectionControl and fires once per flip', () => {
    const { facade } = createRig();
    expect(hasConnectionControl(facade)).toBe(true);
    expect(facade.isConnected()).toBe(true);
    const flips: boolean[] = [];
    const unsub = facade.subscribeConnection((c) => flips.push(c));
    facade.setConnected(false);
    facade.setConnected(false); // no-op, no duplicate
    facade.setConnected(true);
    expect(flips).toEqual([false, true]);
    unsub();
    facade.setConnected(false);
    expect(flips).toEqual([false, true]);
  });

  it('connectStores feeds the connection store for the UI to read', () => {
    const { facade, ids } = createRig();
    const disconnect = connectStores(facade, ids.space);
    expect(useConnectionStore.getState().connected).toBe(true);
    facade.setConnected(false);
    expect(useConnectionStore.getState().connected).toBe(false);
    facade.setConnected(true);
    expect(useConnectionStore.getState().connected).toBe(true);
    disconnect();
    facade.setConnected(false);
    expect(useConnectionStore.getState().connected).toBe(true); // detached after unsubscribe
  });
});
