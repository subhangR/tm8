// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { storyGameStore } from './store';

describe('storyGameStore', () => {
  beforeEach(() => storyGameStore.getState().resetAll());

  it('defaults to the story view and remembers the switch per story', () => {
    expect(storyGameStore.getState().mode.a).toBeUndefined();
    storyGameStore.getState().setMode('a', 'game');
    expect(storyGameStore.getState().mode.a).toBe('game');
    expect(storyGameStore.getState().mode.b).toBeUndefined();
    expect(JSON.parse(window.localStorage.getItem('tm8.story-game.v1')!).mode.a).toBe('game');
  });

  it('reveals once, visits once, and a visit reveals', () => {
    const s = storyGameStore.getState();
    s.reveal('a', ['x', 'y']);
    s.reveal('a', ['y']);
    s.visit('a', 'z');
    s.visit('a', 'z');
    const save = storyGameStore.getState().saves.a!;
    expect(save.revealed).toEqual(['x', 'y', 'z']);
    expect(save.visited).toEqual(['z']);
  });

  it('keeps the player position and resets a story alone', () => {
    const s = storyGameStore.getState();
    s.savePosition('a', 3, -4);
    s.savePosition('b', 1, 1);
    expect(storyGameStore.getState().saves.a).toMatchObject({ x: 3, z: -4 });
    s.reset('a');
    expect(storyGameStore.getState().saves.a).toBeUndefined();
    expect(storyGameStore.getState().saves.b).toMatchObject({ x: 1, z: 1 });
  });
});
