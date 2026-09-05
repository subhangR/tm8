import { describe, expect, it } from 'vitest';
import type { DurableWorkspaceEvent, EntitySummary, WorkSessionStatus } from '@tm8/contract';

import {
  advanceSessionEventState,
  appendBoundedPulse,
  createSessionEventState,
  deriveSessionTransition,
  pulseFromEvent,
  routeMessagePulse,
  routePulsePath,
  type PulseTreeIndex,
  type SessionPulse,
} from './message-pulse';

function session(
  id: string,
  status: WorkSessionStatus,
  parentId: string | null,
): EntitySummary {
  const at = '2026-09-04T12:00:00.000Z';
  return {
    id,
    spaceId: 'space-1',
    kind: 'work_session',
    title: id,
    parentId,
    position: 0,
    visibility: 'space',
    version: status === 'spawning' ? 1 : 2,
    activityAt: at,
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
    createdBy: { kind: 'member', id: 'member-1', displayName: 'Member' },
    counters: {},
    state: {
      kind: 'work_session',
      status,
      agentTool: 'codex',
      model: 'gpt-5',
      shareMode: 'space',
      startedAt: status === 'spawning' ? null : at,
      exitedAt: status === 'exited' || status === 'failed' ? at : null,
    },
    badges: {},
  } as EntitySummary;
}

function upsert(entity: EntitySummary, seq: number): DurableWorkspaceEvent {
  return {
    type: 'entity.upsert',
    spaceId: 'space-1',
    seq,
    occurredAt: '2026-09-04T12:00:00.000Z',
    schemaVersion: 1,
    entity,
  };
}

/**
 *      root
 *      ├── a
 *      │   ├── a1
 *      │   └── a2
 *      └── b
 *          └── b1
 *  other (separate root)
 */
const PARENTS: Record<string, string | null> = {
  root: null,
  a: 'root',
  a1: 'a',
  a2: 'a',
  b: 'root',
  b1: 'b',
  other: null,
};

function index(hidden: readonly string[] = []): PulseTreeIndex {
  const hiddenSet = new Set(hidden);
  return {
    parentOf: (id) => (id in PARENTS ? PARENTS[id] : undefined),
    isVisible: (id) => id in PARENTS && !hiddenSet.has(id),
  };
}

describe('deriveSessionTransition', () => {
  it('derives a delegation from the birth of a child work session', () => {
    const event = upsert(session('child', 'spawning', 'parent'), 10);
    expect(deriveSessionTransition(event, createSessionEventState())).toEqual({
      key: 'delegation:child',
      kind: 'delegation',
      fromId: 'parent',
      toId: 'child',
      evidence: 'entity',
      // Stamped on the same clock as the retention timer; the tile-flight
      // layer refuses to start a glyph that cannot land before eviction, and
      // this is the only field that survives a list unmount to tell it so.
      at: expect.any(Number),
    });
  });

  it('derives a completion only on a non-terminal to terminal status change', () => {
    const prior = createSessionEventState([session('child', 'running', 'parent')]);
    expect(deriveSessionTransition(upsert(session('child', 'exited', 'parent'), 11), prior)).toEqual({
      key: 'completion:child:11',
      kind: 'completion',
      fromId: 'child',
      toId: 'parent',
      outcome: 'exited',
      at: expect.any(Number),
    });
  });

  /**
   * `expect.any(Number)` above proves the field exists, not that it means
   * anything. Presentation decides whether a flight can finish before the
   * pulse is evicted by subtracting this from the current time, so a stamp
   * that is merely PRESENT — zero, or a parsed event time on another clock —
   * would refuse every flight or none.
   *
   * ALL THREE PATHS, because they are three separate literals and stamping one
   * proves nothing about the others.
   *
   * An earlier version of this comment claimed the authored-message path was
   * covered by the flight layer's own age tests. It was not — those hand-build
   * their pulses and never call `pulseFromEvent` — and review demonstrated it
   * by deleting that literal and watching all 35 tests stay green. Authored
   * messages are the PRIMARY flight path, so that was the one stamp with no
   * coverage at all. (PR #591 review, GPT 5.6 Sol.)
   */
  it('stamps every pulse kind with a current-clock arrival time', () => {
    const before = Date.now();
    const authored = {
      type: 'message.created',
      spaceId: 'space-1',
      seq: 12,
      occurredAt: '2026-09-04T12:00:00.000Z',
      schemaVersion: 1,
      anchorId: 'receiver',
      sourceWorkSessionId: 'sender',
      message: { id: 'message-12' },
    } as unknown as DurableWorkspaceEvent;

    const pulses = [
      deriveSessionTransition(upsert(session('child', 'spawning', 'parent'), 10), createSessionEventState()),
      deriveSessionTransition(
        upsert(session('child', 'exited', 'parent'), 11),
        createSessionEventState([session('child', 'running', 'parent')]),
      ),
      pulseFromEvent(authored, createSessionEventState()),
    ];
    const after = Date.now();
    for (const pulse of pulses) {
      expect(pulse).not.toBeNull();
      expect(pulse?.at).toBeGreaterThanOrEqual(before);
      expect(pulse?.at).toBeLessThanOrEqual(after);
    }
  });

  it('returns null for an unrelated upsert', () => {
    const unrelated = {
      ...session('not-a-session', 'running', null),
      kind: 'doc',
      state: { kind: 'doc', format: 'markdown', childCount: 0 },
    } as unknown as EntitySummary;
    expect(deriveSessionTransition(upsert(unrelated, 12), createSessionEventState())).toBeNull();
  });

  it('returns null when the per-space sequence was already consumed', () => {
    const event = upsert(session('child', 'spawning', 'parent'), 13);
    const first = deriveSessionTransition(event, createSessionEventState());
    const advanced = advanceSessionEventState(createSessionEventState(), event, first);
    expect(deriveSessionTransition(event, advanced)).toBeNull();
  });
});

describe('routeMessagePulse', () => {
  it('routes up to the common ancestor and back down, arriving last', () => {
    const route = routeMessagePulse('a1', 'b1', index());
    // a1 -> a -> root, then root -> b -> b1. The wires belong to the PARENTS:
    // a's wrapper, root's wrapper, then b's wrapper.
    expect(route.segments).toEqual([
      { ownerId: 'a', direction: 'up' },
      { ownerId: 'root', direction: 'up' },
      { ownerId: 'b', direction: 'down' },
    ]);
    expect(route.fromRowId).toBe('a1');
    expect(route.toRowId).toBe('b1');
    expect(route.absorbed).toBe(false);
    expect(routePulsePath('a1', 'b1', index()).steps).toEqual([
      { fromId: 'a1', toId: 'a' },
      { fromId: 'a', toId: 'root' },
      { fromId: 'root', toId: 'b' },
      { fromId: 'b', toId: 'b1' },
    ]);
  });

  it('lights a shared wire once between siblings rather than stuttering', () => {
    const route = routeMessagePulse('a1', 'a2', index());
    expect(route.segments).toEqual([{ ownerId: 'a', direction: 'up' }]);
  });

  it('absorbs a collapsed endpoint into its nearest visible ancestor', () => {
    // b1 is inside a collapsed subtree: the pulse must stop at b, not chase it.
    const route = routeMessagePulse('a1', 'b1', index(['b1']));
    expect(route.toRowId).toBe('b');
    expect(route.absorbed).toBe(true);
    expect(route.segments).toEqual([
      { ownerId: 'a', direction: 'up' },
      { ownerId: 'root', direction: 'up' },
    ]);
  });

  it('glows a single row when both ends collapse into the same ancestor', () => {
    const route = routeMessagePulse('a1', 'a2', index(['a1', 'a2']));
    expect(route.segments).toEqual([]);
    expect(route.fromRowId).toBe('a');
    expect(route.toRowId).toBe('a');
    expect(route.absorbed).toBe(true);
  });

  it('still marks the arrival when the sender is not in this tree', () => {
    const route = routeMessagePulse('elsewhere', 'b1', index());
    expect(route.segments).toEqual([]);
    expect(route.fromRowId).toBeNull();
    expect(route.toRowId).toBe('b1');
  });

  it('draws nothing when neither end is in this tree', () => {
    const route = routeMessagePulse('elsewhere', 'nowhere', index());
    expect(route.toRowId).toBeNull();
    expect(route.segments).toEqual([]);
  });

  it('refuses to draw a self-message', () => {
    expect(routeMessagePulse('a1', 'a1', index()).segments).toEqual([]);
    expect(routeMessagePulse('a1', 'a1', index()).toRowId).toBeNull();
  });

  it('routes between separate roots without inventing a shared wire', () => {
    const route = routeMessagePulse('a1', 'other', index());
    // No common ancestor: ascend a1's chain, and `other` is itself a root with
    // no parent wrapper, so the descent contributes nothing.
    expect(route.segments).toEqual([
      { ownerId: 'a', direction: 'up' },
      { ownerId: 'root', direction: 'up' },
    ]);
    expect(route.toRowId).toBe('other');
  });

  it('does not spin on a malformed parent cycle', () => {
    const cyclic: PulseTreeIndex = {
      parentOf: (id) => (id === 'x' ? 'y' : id === 'y' ? 'x' : undefined),
      isVisible: () => false,
    };
    expect(routeMessagePulse('x', 'y', cyclic)).toEqual({
      segments: [],
      fromRowId: null,
      toRowId: null,
      absorbed: false,
    });
  });
});

/**
 * THE STAMP AND THE EVICTION TIMER MUST REFRESH TOGETHER.
 *
 * A key is deliberately stable across CORROBORATING events — an entity upsert
 * and the activity that confirms it are one semantic arrival — and
 * `useMessagePulses` clears and restarts that key's eviction timeout every
 * time one lands. The retained pulse must therefore be the NEW one, carrying
 * the NEW `at`. If this kept the first, the stamp would age while the timer
 * kept resetting under it, and the flight layer would refuse flights that
 * genuinely had budget: an arrival could go unanimated purely because it was
 * corroborated twice.
 *
 * Not a hypothetical invariant — it is the one thing outside the layer that
 * the age rule depends on, and nothing asserted it.
 */
describe('appendBoundedPulse', () => {
  const at = (key: string, stamp: number): SessionPulse =>
    ({ key, kind: 'message', fromId: 'a', toId: 'b', at: stamp });

  it('keeps the newest stamp when a corroborating event reuses a key', () => {
    const retained = appendBoundedPulse([at('m1', 1_000)], at('m1', 1_800), 12);
    expect(retained).toHaveLength(1);
    expect(retained[0].at).toBe(1_800);
  });

  it('drops the oldest when the cap is reached, never the newest', () => {
    const full = [at('a', 1), at('b', 2), at('c', 3)];
    const retained = appendBoundedPulse(full, at('d', 4), 3);
    expect(retained.map((item) => item.key)).toEqual(['b', 'c', 'd']);
  });
});
