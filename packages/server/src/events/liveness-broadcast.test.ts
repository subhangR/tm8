/**
 * The push, and the two properties it exists to have: it is BOUNDED by live
 * sessions, and it never leaks across a space.
 */
import { describe, expect, it } from 'vitest';

import { WorkspaceEventPublisher } from './emitter.js';
import { createLivenessBroadcaster } from './liveness-broadcast.js';
import { PresenceSeqSource } from './seq.js';
import { SubscriptionRegistry } from './subscriptions.js';
import type { EventSink } from './ws-connection.js';

const SPACE_A = '11111111-1111-4111-8111-111111111111';
const SPACE_B = '22222222-2222-4222-8222-222222222222';
const S1 = '00000000-0000-4000-8000-000000000001';
const S2 = '00000000-0000-4000-8000-000000000002';
const S3 = '00000000-0000-4000-8000-000000000003';
const BOOT = 'boot-0001';

interface Recorder {
  sink: EventSink;
  sent: Record<string, unknown>[];
}

function recorder(id: string, identityId = 'ident-1'): Recorder {
  const sent: Record<string, unknown>[] = [];
  const sink: EventSink = {
    id,
    identity: { kind: 'bearer', identityId, nodeAdmin: false },
    get isOpen() { return true; },
    send: (text: string) => { sent.push(JSON.parse(text) as Record<string, unknown>); },
    close: () => {},
  } as unknown as EventSink;
  return { sink, sent };
}

function harness(): {
  registry: SubscriptionRegistry;
  publisher: WorkspaceEventPublisher;
  broadcaster: ReturnType<typeof createLivenessBroadcaster>;
  errors: string[];
} {
  const registry = new SubscriptionRegistry();
  const publisher = new WorkspaceEventPublisher(new PresenceSeqSource(), registry);
  const errors: string[] = [];
  const broadcaster = createLivenessBroadcaster({
    publisher,
    nodeBootId: BOOT,
    onError: (m) => errors.push(m),
    now: () => new Date('2026-08-22T12:00:00.000Z'),
  });
  return { registry, publisher, broadcaster, errors };
}

describe('liveness push: what reaches the wire', () => {
  it('publishes the whole live set for the space, with the transition that caused it', () => {
    const { registry, broadcaster } = harness();
    const a = recorder('conn-a');
    registry.add(a.sink);
    registry.subscribe('conn-a', SPACE_A);

    broadcaster.noteAppeared(S1, SPACE_A);
    broadcaster.noteAppeared(S2, SPACE_A);

    expect(a.sent).toHaveLength(2);
    expect(a.sent[0]).toMatchObject({
      type: 'execution.liveness_changed',
      spaceId: SPACE_A,
      nodeBootId: BOOT,
      liveEntityIds: [S1],
      changed: { id: S1, transition: 'appeared' },
      confidence: 'reported',
    });
    // The SECOND event carries BOTH — a client that joined late and applies
    // only this one still ends up with the correct set. That self-healing is
    // the reason the whole set rides rather than a delta.
    expect(a.sent[1]).toMatchObject({ liveEntityIds: [S1, S2], changed: { id: S2 } });
  });

  it('never sends one space\'s live set to a subscriber of another', () => {
    const { registry, broadcaster } = harness();
    const a = recorder('conn-a');
    const b = recorder('conn-b', 'ident-2');
    registry.add(a.sink);
    registry.add(b.sink);
    registry.subscribe('conn-a', SPACE_A);
    registry.subscribe('conn-b', SPACE_B);

    broadcaster.noteAppeared(S1, SPACE_A);
    broadcaster.noteAppeared(S2, SPACE_B);

    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
    expect(a.sent[0]).toMatchObject({ spaceId: SPACE_A, liveEntityIds: [S1] });
    expect(b.sent[0]).toMatchObject({ spaceId: SPACE_B, liveEntityIds: [S2] });
    // The load-bearing negative: B never learns S1 exists.
    expect(JSON.stringify(b.sent)).not.toContain(S1);
  });

  it('does NOT require the presence toggle — a plain space subscriber is served', () => {
    // The distinction between `fanOutLiveness` and `fanOutPresence`. A chat
    // client that never asked for viewer avatars must still be told an agent
    // died; gating this behind `presence` would couple two unrelated features.
    const { registry, broadcaster } = harness();
    const a = recorder('conn-a');
    registry.add(a.sink);
    registry.subscribe('conn-a', SPACE_A);
    registry.subscribePresence('conn-a', false);

    broadcaster.noteAppeared(S1, SPACE_A);
    expect(a.sent).toHaveLength(1);
  });

  it('sends nothing to a connection that never subscribed to the space', () => {
    const { registry, broadcaster } = harness();
    const a = recorder('conn-a');
    registry.add(a.sink);
    // Registered, but subscribed to nothing. `subscribe` is where the
    // membership check happens, so an unsubscribed connection is by
    // construction one the authorizer has not cleared for this space.
    broadcaster.noteAppeared(S1, SPACE_A);
    expect(a.sent).toHaveLength(0);
  });
});

describe('liveness push: the transitions and their evidence tiers', () => {
  it('labels lifecycle reported and activity guessed (#507)', () => {
    const { registry, broadcaster } = harness();
    const a = recorder('conn-a');
    registry.add(a.sink);
    registry.subscribe('conn-a', SPACE_A);

    broadcaster.noteAppeared(S1, SPACE_A);
    broadcaster.noteActivity(S1, 'idle');
    broadcaster.noteActivity(S1, 'busy');
    broadcaster.noteVanished(S1);

    expect(a.sent.map((e) => [
      (e.changed as { transition: string }).transition,
      e.confidence,
    ])).toEqual([
      // The node spawned it and the node reaped it: observed, not inferred.
      ['appeared', 'reported'],
      // A silence timer fired. It cannot tell thinking from blocked from dead.
      ['quiet', 'guessed'],
      ['woke', 'guessed'],
      ['vanished', 'reported'],
    ]);
  });

  it('going quiet does not remove the session from the live set', () => {
    // Quiet is not dead. Dropping it here would make the client render `stale`
    // for a session holding a perfectly live terminal.
    const { registry, broadcaster } = harness();
    const a = recorder('conn-a');
    registry.add(a.sink);
    registry.subscribe('conn-a', SPACE_A);

    broadcaster.noteAppeared(S1, SPACE_A);
    broadcaster.noteActivity(S1, 'idle');

    expect(a.sent[1]).toMatchObject({ liveEntityIds: [S1], changed: { transition: 'quiet' } });
  });

  it('the vanish event carries the set AFTER the removal', () => {
    const { registry, broadcaster } = harness();
    const a = recorder('conn-a');
    registry.add(a.sink);
    registry.subscribe('conn-a', SPACE_A);

    broadcaster.noteAppeared(S1, SPACE_A);
    broadcaster.noteAppeared(S2, SPACE_A);
    broadcaster.noteVanished(S1);

    // Not `[S1, S2]`. A client that trusts the payload over its own bookkeeping
    // would otherwise re-add the session it was just told had died.
    expect(a.sent[2]).toMatchObject({ liveEntityIds: [S2], changed: { id: S1, transition: 'vanished' } });
  });

  it('says nothing about a session it never saw appear', () => {
    const { registry, broadcaster } = harness();
    const a = recorder('conn-a');
    registry.add(a.sink);
    registry.subscribe('conn-a', SPACE_A);

    broadcaster.noteVanished(S3);
    broadcaster.noteActivity(S3, 'idle');

    // Silence, not a guess. Publishing here would assert a live set this
    // broadcaster does not hold — and would be missing that session's peers.
    expect(a.sent).toHaveLength(0);
  });
});

describe('liveness push: the bound', () => {
  it('tracks LIVE sessions only — history costs nothing', () => {
    const { registry, broadcaster } = harness();
    const a = recorder('conn-a');
    registry.add(a.sink);
    registry.subscribe('conn-a', SPACE_A);

    // 519 sessions over the node's life, ten alive at any moment.
    for (let i = 0; i < 519; i += 1) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      broadcaster.noteAppeared(id, SPACE_A);
      if (i >= 10) {
        const gone = `00000000-0000-4000-8000-${String(i - 10).padStart(12, '0')}`;
        broadcaster.noteVanished(gone);
      }
    }

    // THE CLAIM IN THE TASK, asserted rather than argued: bounded by live
    // sessions, not by all of them.
    expect(broadcaster.size()).toBe(10);
    expect(broadcaster.liveIn(SPACE_A)).toHaveLength(10);

    // And the payload is bounded with it — the last frame is not 519 ids.
    const last = a.sent[a.sent.length - 1] as Record<string, unknown>;
    expect((last.liveEntityIds as string[]).length).toBe(10);
  });

  it('at ten concurrent sessions the frame stays small', () => {
    const { registry, broadcaster } = harness();
    const a = recorder('conn-a');
    registry.add(a.sink);
    registry.subscribe('conn-a', SPACE_A);
    for (let i = 0; i < 10; i += 1) {
      broadcaster.noteAppeared(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, SPACE_A);
    }
    const bytes = JSON.stringify(a.sent[a.sent.length - 1]).length;
    // A number rather than an adjective. ~570 bytes; the ceiling is generous
    // so the test reports a regression rather than a rounding change.
    expect(bytes).toBeLessThan(800);
  });

  it('a re-appear in a different space leaves no orphan in the old one', () => {
    const { registry, broadcaster } = harness();
    const a = recorder('conn-a');
    registry.add(a.sink);
    registry.subscribe('conn-a', SPACE_A);
    registry.subscribe('conn-a', SPACE_B);

    broadcaster.noteAppeared(S1, SPACE_A);
    broadcaster.noteAppeared(S1, SPACE_B);

    expect(broadcaster.liveIn(SPACE_A)).toEqual([]);
    expect(broadcaster.liveIn(SPACE_B)).toEqual([S1]);
    // And the old space is TOLD, rather than left holding a set that quietly
    // stopped being true.
    expect(a.sent[1]).toMatchObject({ spaceId: SPACE_A, changed: { transition: 'vanished' } });
  });
});

describe('liveness push: it cannot break the thing it reports on', () => {
  it('swallows a publish failure instead of throwing into the PTY host', () => {
    const registry = new SubscriptionRegistry();
    const errors: string[] = [];
    const exploding = {
      publishLiveness: () => { throw new Error('socket exploded'); },
    } as unknown as WorkspaceEventPublisher;
    const broadcaster = createLivenessBroadcaster({
      publisher: exploding,
      nodeBootId: BOOT,
      onError: (m) => errors.push(m),
    });
    void registry;

    // This is called synchronously from `SpawnService.handlePtyExit`. A throw
    // would travel back into the terminal's own lifecycle handling.
    expect(() => broadcaster.noteAppeared(S1, SPACE_A)).not.toThrow();
    expect(errors).toEqual(['socket exploded']);
    // The bookkeeping still happened — the failure was the delivery, not the
    // fact, and the next successful publish must carry a correct set.
    expect(broadcaster.liveIn(SPACE_A)).toEqual([S1]);
  });

  it('the seq is channel-local and never a durable one', () => {
    const { registry, broadcaster } = harness();
    const a = recorder('conn-a');
    registry.add(a.sink);
    registry.subscribe('conn-a', SPACE_A);

    broadcaster.noteAppeared(S1, SPACE_A);
    broadcaster.noteAppeared(S2, SPACE_A);

    // 1, 2 — a fresh in-memory counter, not the database's high-water mark
    // (which on a real space is in the tens of thousands). This is exactly why
    // the client routes these away from its durable cursor.
    expect(a.sent.map((e) => e.seq)).toEqual([1, 2]);
  });
});
