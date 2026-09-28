/**
 * P7 — the socket liveness sweep, in isolation (the real-socket cells per
 * revoke path are db/revoke-closes-sockets.pg.test.ts and the P7 block of
 * db/space-link-provenance.pg.test.ts).
 *
 * The cost rule (coordinator, L2a (b)): ONE reader call per tick, keyed by the
 * distinct session ids of the open sockets — never a call per socket, and no
 * call at all when no socket carries a session.
 */
import { describe, expect, it } from 'vitest';

import { WS_CLOSE_SESSION_ENDED } from '@tm8/contract';

import { WorkspaceEventPublisher } from '../src/events/emitter.js';
import type { DurableEventLog } from '../src/events/poll.js';
import { createDurableEventPump } from '../src/events/pump.js';
import { PresenceSeqSource } from '../src/events/seq.js';
import { SubscriptionRegistry } from '../src/events/subscriptions.js';
import type { EventSink } from '../src/events/ws-connection.js';
import type { RequestIdentity } from '../src/http/types.js';
import {
  closeSessionSockets,
  createSessionLivenessSweep,
  SESSION_ENDED_CLOSE_REASON,
} from '../src/identity/session-sockets.js';

class Sink implements EventSink {
  closedWith: { code?: number; reason?: string } | null = null;
  constructor(readonly id: string, readonly identity: RequestIdentity) {}
  get isOpen(): boolean { return this.closedWith === null; }
  send(): void {}
  close(code?: number, reason?: string): void { this.closedWith = { code, reason }; }
  onMessage(): void {}
  onClose(): void {}
}

const bearer = (sessionId: string): RequestIdentity =>
  ({ kind: 'bearer', identityId: `identity-${sessionId}`, sessionId });

function registryOf(...sinks: Sink[]): SubscriptionRegistry {
  const registry = new SubscriptionRegistry();
  for (const sink of sinks) registry.add(sink);
  return registry;
}

describe('createSessionLivenessSweep', () => {
  it('asks ONCE per sweep, with each open session id once; closes exactly the ended ones with 4401', async () => {
    const tab = new Sink('c1', bearer('s-tab'));
    const tabAgain = new Sink('c2', bearer('s-tab'));
    const phone = new Sink('c3', bearer('s-phone'));
    const owner = new Sink('c4', { kind: 'auto-owner', identityId: 'owner' });
    const gone = new Sink('c5', bearer('s-gone'));
    gone.close(1000, 'client left');
    const calls: string[][] = [];
    const sweep = createSessionLivenessSweep({
      sockets: registryOf(tab, tabAgain, phone, owner, gone),
      ended: async (ids) => { calls.push([...ids].sort()); return ['s-tab']; },
    });

    expect(await sweep.sweep()).toBe(2);

    expect(calls).toEqual([['s-phone', 's-tab']]);
    expect(tab.closedWith).toEqual({ code: WS_CLOSE_SESSION_ENDED, reason: SESSION_ENDED_CLOSE_REASON });
    expect(tabAgain.closedWith).toEqual({ code: 4401, reason: 'session ended' });
    // Paired: the live session and the session-less auto-owner stay open.
    expect(phone.isOpen).toBe(true);
    expect(owner.isOpen).toBe(true);
  });

  it('no socket with a session: no query at all', async () => {
    let asked = 0;
    const sweep = createSessionLivenessSweep({
      sockets: registryOf(new Sink('c1', { kind: 'auto-owner', identityId: 'owner' })),
      ended: async () => { asked += 1; return []; },
    });
    expect(await sweep.sweep()).toBe(0);
    expect(asked).toBe(0);
  });

  it('a failing close is logged and the rest still close', async () => {
    const bad = new Sink('c1', bearer('s-1'));
    bad.close = () => { throw new Error('socket gone'); };
    const good = new Sink('c2', bearer('s-1'));
    const logged: string[] = [];
    const closed = closeSessionSockets(registryOf(bad, good), new Set(['s-1']), (message) => logged.push(message));
    expect(closed).toBe(1);
    expect(good.closedWith).toEqual({ code: 4401, reason: 'session revoked' });
    expect(logged).toHaveLength(1);
  });
});

describe('the event pump re-verifies liveness before it delivers', () => {
  function pumpWith(liveness: { sweep(): Promise<number> }, sinks: Sink[]) {
    const registry = registryOf(...sinks);
    const read: string[] = [];
    const log: DurableEventLog = {
      since: async (spaceId: string) => { read.push(spaceId); return { items: [], nextCursor: null, hasMore: false } as never; },
    } as unknown as DurableEventLog;
    const errors: string[] = [];
    const pump = createDurableEventPump({
      registry,
      publisher: new WorkspaceEventPublisher(new PresenceSeqSource(), registry),
      log,
      claimsFor: async () => ({ identityId: 'x' }),
      liveness,
      onError: (message) => errors.push(message),
    });
    for (const sink of sinks) {
      registry.subscribe(sink.id, `space-${sink.id}`);
      pump.seed(sink.id, `space-${sink.id}`, 0);
    }
    return { pump, read, errors };
  }

  it('a socket whose session ended is closed first and never read for, in the same tick', async () => {
    const ended = new Sink('dead', bearer('s-dead'));
    const live = new Sink('live', bearer('s-live'));
    const registry = registryOf(ended, live);
    const h = pumpWith(createSessionLivenessSweep({ sockets: registry, ended: async () => ['s-dead'] }), [ended, live]);

    await h.pump.tick();

    expect(ended.closedWith).toEqual({ code: 4401, reason: 'session ended' });
    expect(h.read).toEqual(['space-live']);
  });

  it('a failed liveness read is reported and does not stop delivery', async () => {
    const live = new Sink('live', bearer('s-live'));
    const h = pumpWith({ sweep: async () => { throw new Error('db down'); } }, [live]);

    await h.pump.tick();

    expect(h.errors).toEqual(['session liveness: db down']);
    expect(h.read).toEqual(['space-live']);
    expect(live.isOpen).toBe(true);
  });
});
