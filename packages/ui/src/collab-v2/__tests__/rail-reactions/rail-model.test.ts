// @vitest-environment node
/**
 * Rail model — the pure rules: resolution badges, rollups, group ordering,
 * reorder math and edge direction. No DOM, no facade.
 */
import { describe, expect, it } from 'vitest';
import {
  edgeEndpoints, groupKey, orderedGroups, otherEnd, planReorder, positionBetween,
  railEdgeLabel, resolutionBadge, unresolvedCount, waitingOn,
} from '../../subsystems/rail/model';
import type {
  Connections, EdgeGroup, EdgeView, EntitySummary,
} from '../../types/contract';

const actor = {
  id: 'ent_mem_a', kind: 'member' as const, displayName: 'A', isAgent: false,
};

function summary(id: string, title = id): EntitySummary {
  return {
    id, spaceId: 's', kind: 'task', title, parentId: null, position: 0,
    visibility: 'space', version: 1, activityAt: '', createdAt: '', updatedAt: '',
    deletedAt: null, createdBy: actor,
    counters: { likes: 0, dislikes: 0, stars: 0, points: 0, messages: 0, viewerReaction: null },
    state: { kind: 'task', workStatus: 'open', priority: 'low', axes: {}, assignees: [], acceptance: { total: 0, completed: 0 } },
    badges: {},
  };
}

function edge(id: string, target: string, extra: Partial<EdgeView> = {}): EdgeView {
  return {
    id, type: 'depends_on', source: summary('self'), target: summary(target),
    props: {}, createdBy: actor, createdAt: '', ...extra,
  };
}

function group(edges: EdgeView[], over: Partial<EdgeGroup> = {}): EdgeGroup {
  return { type: 'depends_on', direction: 'outgoing', label: 'Depends on', edges, ...over };
}

describe('resolution badges', () => {
  it('renders nothing for edge types that carry no dependency semantics', () => {
    expect(resolutionBadge(edge('e1', 't1', { type: 'relates_to' }))).toBeNull();
  });

  it('marks an unresolved hard dependency as blocking', () => {
    const badge = resolutionBadge(edge('e1', 't1', { hard: true, resolved: false }));
    expect(badge).toEqual({ strength: 'HARD', resolved: false, label: 'HARD ⚠', blocking: true });
  });

  it('marks a resolved hard dependency as done, not blocking', () => {
    const badge = resolutionBadge(edge('e1', 't1', { hard: true, resolved: true }));
    expect(badge).toMatchObject({ label: 'HARD ✓', blocking: false });
  });

  it('never treats a soft dependency as blocking, resolved or not', () => {
    expect(resolutionBadge(edge('e1', 't1', { hard: false, resolved: false })))
      .toMatchObject({ strength: 'SOFT', label: 'SOFT ⚠', blocking: false });
  });
});

describe('group rollups', () => {
  const blocked = group([
    edge('e1', 't1', { hard: true, resolved: false }),
    edge('e2', 't2', { hard: true, resolved: true }),
    edge('e3', 't3', { hard: false, resolved: false }),
  ]);

  it('counts only unresolved hard items', () => {
    expect(unresolvedCount(blocked)).toBe(1);
  });

  it('derives waiting-on chips when the badge is empty (nested summaries)', () => {
    const connections: Connections = { outgoing: [blocked], incoming: [], unresolvedHardDependencyCount: 1 };
    expect(waitingOn(connections).map((s) => s.id)).toEqual(['t1']);
  });

  it('prefers the server-computed waitingOn badge', () => {
    const connections: Connections = { outgoing: [blocked], incoming: [], unresolvedHardDependencyCount: 1 };
    expect(waitingOn(connections, [summary('server')]).map((s) => s.id)).toEqual(['server']);
  });

  it('orders groups blocked-first, then by size, and drops empty ones', () => {
    const connections: Connections = {
      outgoing: [
        group([edge('a', 'x', { type: 'relates_to' })], { type: 'relates_to', label: 'Related' }),
        blocked,
        group([], { type: 'tracks', label: 'Tracks' }),
      ],
      incoming: [group([edge('b', 'y')], { direction: 'incoming', type: 'attached_to', label: 'Attached' })],
      unresolvedHardDependencyCount: 1,
    };
    expect(orderedGroups(connections).map(groupKey)).toEqual([
      'outgoing:depends_on', 'outgoing:relates_to', 'incoming:attached_to',
    ]);
  });
});

describe('direction', () => {
  it('reads the far end from the group direction', () => {
    const e = edge('e1', 'far');
    expect(otherEnd(e, 'outgoing').id).toBe('far');
    expect(otherEnd(e, 'incoming').id).toBe('self');
  });

  it('flips source/target when linking on an incoming group', () => {
    expect(edgeEndpoints('me', 'them', 'outgoing')).toEqual({ srcId: 'me', dstId: 'them' });
    expect(edgeEndpoints('me', 'them', 'incoming')).toEqual({ srcId: 'them', dstId: 'me' });
  });

  it('prettifies unregistered x:* types without special-casing them', () => {
    expect(railEdgeLabel('x:inspired_by')).toBe('Inspired by');
    expect(railEdgeLabel('depends_on')).toBe('Depends on');
  });
});

describe('hierarchy reorder math', () => {
  const kids = [summary('a'), summary('b'), summary('c')].map((s, i) => ({ ...s, position: i * 10 }));

  it('is a no-op at both ends', () => {
    expect(planReorder(kids, 0, 'up')).toBeNull();
    expect(planReorder(kids, 2, 'down')).toBeNull();
  });

  it('moves down between the right neighbours', () => {
    const plan = planReorder(kids, 0, 'down');
    expect(plan).toMatchObject({ childId: 'a', fromIndex: 0, toIndex: 1, beforeId: 'c' });
    // between b (10) and c (20)
    expect(plan!.position).toBe(15);
  });

  it('moves up above the previous sibling', () => {
    const plan = planReorder(kids, 2, 'up');
    expect(plan).toMatchObject({ childId: 'c', toIndex: 1, beforeId: 'b' });
    expect(plan!.position).toBeLessThan(10);
    expect(plan!.position).toBeGreaterThan(0);
  });

  it('keeps positions strictly ordered for repeated moves', () => {
    expect(positionBetween(null, 10)).toBeLessThan(10);
    expect(positionBetween(10, null)).toBeGreaterThan(10);
    expect(positionBetween(1, 2)).toBe(1.5);
    expect(positionBetween(null, null)).toBe(0);
  });
});
