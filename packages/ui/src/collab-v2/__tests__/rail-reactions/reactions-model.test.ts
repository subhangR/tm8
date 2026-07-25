// @vitest-environment node
/**
 * Reaction model — the exclusivity/independence rules the optimistic flip
 * must mirror exactly, plus the granter aggregation behind the pool hover.
 */
import { describe, expect, it } from 'vitest';
import {
  activeReactions, flipReaction, grantPointsLocally, projectViewerReaction,
  reconcileLocal, topGranters, type Reaction,
} from '../../subsystems/reactions/model';
import type { ActivityItem, ActorSummary, EntityCounters } from '../../types/contract';

const base: EntityCounters = {
  likes: 4, dislikes: 2, stars: 1, points: 20, messages: 3, viewerReaction: null,
};

const actor = (id: string, name: string): ActorSummary => ({
  id, kind: 'member', displayName: name, isAgent: false,
});

describe('flipReaction', () => {
  it('likes: increments and records the viewer reaction', () => {
    const flip = flipReaction(base, 'like');
    expect(flip.enabled).toBe(true);
    expect(flip.counters).toMatchObject({ likes: 5, dislikes: 2, viewerReaction: 'like' });
  });

  it('un-likes on a second tap', () => {
    const on = flipReaction(base, 'like');
    const off = flipReaction(on.counters, 'like', on.active);
    expect(off.enabled).toBe(false);
    expect(off.counters).toMatchObject({ likes: 4, viewerReaction: null });
  });

  it('like and dislike are mutually exclusive — the toggle swaps both counters', () => {
    const liked = flipReaction(base, 'like');
    const flipped = flipReaction(liked.counters, 'dislike', liked.active);
    expect(flipped.counters).toMatchObject({ likes: 4, dislikes: 3, viewerReaction: 'dislike' });
    expect([...flipped.active]).toEqual(['dislike']);
  });

  it('star is independent of like/dislike', () => {
    const liked = flipReaction(base, 'like');
    const starred = flipReaction(liked.counters, 'star', liked.active);
    expect(starred.counters).toMatchObject({ likes: 5, stars: 2 });
    expect(starred.active.has('like')).toBe(true);
    expect(starred.active.has('star')).toBe(true);
    // the single contract field reports the priority winner
    expect(starred.counters.viewerReaction).toBe('like');
  });

  it('never drives a counter below zero', () => {
    const zero: EntityCounters = { ...base, likes: 0, viewerReaction: 'like' };
    expect(flipReaction(zero, 'like').counters.likes).toBe(0);
  });
});

describe('viewerReaction projection', () => {
  it('reports like › dislike › star', () => {
    expect(projectViewerReaction(new Set<Reaction>(['star', 'like']))).toBe('like');
    expect(projectViewerReaction(new Set<Reaction>(['star', 'dislike']))).toBe('dislike');
    expect(projectViewerReaction(new Set<Reaction>(['star']))).toBe('star');
    expect(projectViewerReaction(new Set<Reaction>())).toBeNull();
  });

  it('seeds the active set from the server field when nothing is local', () => {
    expect([...activeReactions({ ...base, viewerReaction: 'star' })]).toEqual(['star']);
    expect([...activeReactions({ ...base, viewerReaction: 'star' }, new Set<Reaction>())]).toEqual([]);
  });

  it('drops local knowledge the server contradicts', () => {
    const local = new Set<Reaction>(['like', 'star']);
    expect(reconcileLocal(local, { ...base, viewerReaction: 'like' })).toBe(local);
    expect(reconcileLocal(local, { ...base, viewerReaction: null })).toBeUndefined();
    expect(reconcileLocal(local, { ...base, viewerReaction: 'star' })).toBeUndefined();
  });
});

describe('points', () => {
  it('adds to the pool optimistically', () => {
    expect(grantPointsLocally(base, 5).points).toBe(25);
  });

  it('aggregates top granters across grants and awards', () => {
    const item = (id: string, verb: string, who: ActorSummary, amount: number): ActivityItem => ({
      id, entityId: 'e', actor: who, verb, summary: { amount }, createdAt: '2026-07-25T00:00:00.000Z',
    });
    const mira = actor('m', 'Mira');
    const subhang = actor('s', 'Subhang');
    const granters = topGranters([
      item('1', 'granted_points', subhang, 20),
      item('2', 'awarded', mira, 15),
      item('3', 'granted_points', mira, 10),
      item('4', 'message_posted', subhang, 99),
      item('5', 'granted_points', subhang, 0),
    ]);
    expect(granters.map((g) => [g.actor.displayName, g.amount])).toEqual([
      ['Mira', 25], ['Subhang', 20],
    ]);
  });
});
