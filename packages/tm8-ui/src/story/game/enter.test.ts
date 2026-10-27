// @vitest-environment jsdom
/**
 * Drilling into a child story and climbing back out (task 01a1090f): the
 * route keeps the surface's shape, the child is saved in game mode, and Esc
 * is a history step only when the last move WAS that drill-in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntityId } from '@tm8/contract';
import { navStore, resetNav } from '../../stores/navStore';
import { enterStory, isRoutedStory, leaveStory, resetEntry, storyRoute } from './enter';
import { storyGameStore } from './store';

const P = 'parent-story' as EntityId;
const C = 'child-story' as EntityId;

describe('storyRoute', () => {
  it('swaps the routed story in place, keeping origin and full and dropping the filter', () => {
    expect(storyRoute({ view: 'entity', entityId: P, origin: { slug: 'stories', mode: null }, hops: 2, kinds: ['task'] }, P, C))
      .toEqual({ view: 'entity', entityId: C, origin: { slug: 'stories', mode: null } });
    expect(storyRoute({ view: 'entity', entityId: P, origin: null, full: true }, P, C))
      .toEqual({ view: 'entity', entityId: C, origin: null, full: true });
  });
  it('opens the full view when the story is not the routed entity', () => {
    expect(storyRoute({ view: 'home' }, P, C)).toEqual({ view: 'entity', entityId: C, origin: null, full: true });
    expect(storyRoute({ view: 'entity', entityId: 'other' as EntityId, origin: null }, P, C)).toEqual({ view: 'entity', entityId: C, origin: null, full: true });
  });
});

describe('enterStory / leaveStory', () => {
  beforeEach(() => {
    storyGameStore.getState().resetAll();
    resetEntry();
    resetNav('', { view: 'entity', entityId: P, origin: null, full: true });
  });
  afterEach(() => vi.restoreAllMocks());

  it('enter saves the child in game mode and pushes it onto the navStore', () => {
    enterStory(P, C);
    expect(storyGameStore.getState().mode[C]).toBe('game');
    expect(navStore.getState().view).toEqual({ view: 'entity', entityId: C, origin: null, full: true });
    expect(navStore.getState().history).toBe('push');
    expect(isRoutedStory(C)).toBe(true);
  });

  it('leaving straight after entering is one history step back', () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    enterStory(P, C);
    const navigate = vi.spyOn(navStore.getState(), 'navigate');
    leaveStory(C, P);
    expect(back).toHaveBeenCalledTimes(1);
    expect(navigate).not.toHaveBeenCalled();
    expect(storyGameStore.getState().mode[P]).toBe('game');
  });

  it('a cold arrival (or anything moved since) navigates up to the parent instead', () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
    resetNav('', { view: 'entity', entityId: C, origin: { slug: 'stories', mode: null } });
    leaveStory(C, P);
    expect(back).not.toHaveBeenCalled();
    expect(navStore.getState().view).toEqual({ view: 'entity', entityId: P, origin: { slug: 'stories', mode: null } });
    expect(storyGameStore.getState().mode[P]).toBe('game');

    enterStory(P, C);
    navStore.getState().navigate({ view: 'entity', entityId: C, origin: null, full: true, hops: 2 });
    leaveStory(C, P);
    expect(back).not.toHaveBeenCalled();
    expect(navStore.getState().view).toEqual({ view: 'entity', entityId: P, origin: null, full: true });
  });
});
