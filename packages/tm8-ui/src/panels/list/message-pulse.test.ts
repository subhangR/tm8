import { describe, expect, it } from 'vitest';
import type { DurableWorkspaceEvent, EntitySummary, WorkSessionStatus } from '@tm8/contract';

import {
  advanceSessionEventState,
  createSessionEventState,
  deriveSessionTransition,
  routeMessagePulse,
  routePulsePath,
  type PulseTreeIndex,
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
   * BOTH TRANSITION PATHS, because they are separate literals and stamping one
   * proves nothing about the other. The third path — an authored message via
   * `pulseFromEvent` — is a third literal again, and its stamp is covered by
   * the flight layer's own age tests rather than duplicated here.
   */
  it('stamps every pulse kind with a current-clock arrival time', () => {
    const before = Date.now();
    const pulses = [
      deriveSessionTransition(upsert(session('child', 'spawning', 'parent'), 10), createSessionEventState()),
      deriveSessionTransition(
        upsert(session('child', 'exited', 'parent'), 11),
        createSessionEventState([session('child', 'running', 'parent')]),
      ),
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
