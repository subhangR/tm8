// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { backGameMap, enterGameMap, freshGameSave, gameSaveKey, mapKey, readGameSave, rememberGameMap, validCamera, writeGameSave } from './local-save';
import type { GameMapSelection } from './types';

const story: GameMapSelection = { type: 'hub', scope: { kind: 'story', id: 'story' }, title: 'Story' };
const land: GameMapSelection = { type: 'taskland', scope: story.scope };
beforeEach(() => window.localStorage.clear());

describe('browser game save', () => {
  it('round trips the full route and separate per-map position/camera', () => {
    let save = freshGameSave('space', 'member');
    save = rememberGameMap(save, mapKey(save.current), { position: { x: 1, z: 2 } });
    save = enterGameMap(enterGameMap(save, story), land);
    save = rememberGameMap(save, mapKey(land), { position: { x: 7, z: 9 }, camera: { zoom: 3, position: [1, 2, 3], target: [7, 0, 9] } });
    expect(writeGameSave(save)).toBe(true);
    const restored = readGameSave('space', 'member');
    expect(restored).toEqual({ ...save, stack: save.stack.map(({ type, scope }) => ({ type, scope })) });
    expect(backGameMap(restored).current).toEqual({ type: story.type, scope: story.scope });
    expect(window.localStorage.getItem(gameSaveKey('space', 'member'))).not.toContain('title');
    expect(backGameMap(restored, 0).maps[mapKey(restored.stack[0]!)]?.position).toEqual({ x: 1, z: 2 });
    expect(backGameMap(backGameMap(backGameMap(restored)))).toEqual(backGameMap(restored, 0));
  });
  it('isolates both member and space, including separator-like IDs', () => {
    const save = enterGameMap(freshGameSave('a:b', 'c'), story);
    writeGameSave(save);
    expect(gameSaveKey('a:b', 'c')).not.toBe(gameSaveKey('a', 'b:c'));
    expect(readGameSave('a', 'b:c').current.type).toBe('hub');
    expect(readGameSave('a:b', 'other').stack).toEqual([]);
    const raw = JSON.stringify(save);
    window.localStorage.setItem(gameSaveKey('other', 'c'), raw);
    expect(readGameSave('other', 'c').current.scope).toEqual({ kind: 'space', id: 'other' });
  });
  it.each(['{broken', '{}', JSON.stringify({ version: 99 }), 'null'])('falls back safely for invalid or future saves: %s', raw => {
    window.localStorage.setItem(gameSaveKey('space', 'member'), raw);
    expect(readGameSave('space', 'member')).toEqual(freshGameSave('space', 'member'));
  });
  it('rejects malformed route entries and cross-space navigation', () => {
    const save = enterGameMap(freshGameSave('space', 'member'), story);
    for (const current of [{ ...land, type: 'unknown' }, { ...land, scope: { kind: 'space', id: 'other' } }, { ...land, scope: { kind: 'other', id: 'story' } }]) {
      window.localStorage.setItem(gameSaveKey('space', 'member'), JSON.stringify({ ...save, current }));
      expect(readGameSave('space', 'member').stack).toEqual([]);
    }
    window.localStorage.setItem(gameSaveKey('space', 'member'), JSON.stringify({ ...save, stack: [] }));
    expect(readGameSave('space', 'member').current.scope.id).toBe('space');
  });
  it('salvages valid route and memory while dropping invalid numbers, keys and foreign maps', () => {
    const save = enterGameMap(freshGameSave('space', 'member'), story);
    const key = mapKey(story);
    window.localStorage.setItem(gameSaveKey('space', 'member'), JSON.stringify({ ...save, maps: {
      [key]: { position: { x: 5, z: 6 }, camera: { zoom: -2, position: [0, 0, 0], target: [0, 0, 0] } },
      [mapKey(land)]: { position: { x: 1e20, z: 0 } },
      [mapKey({ type: 'hub', scope: { kind: 'space', id: 'other' } })]: { position: { x: 1, z: 2 } },
      constructor: { position: { x: 1, z: 2 } },
    } }));
    const restored = readGameSave('space', 'member');
    expect(restored.current).toEqual({ type: story.type, scope: story.scope });
    expect(restored.maps[key]).toEqual({ position: { x: 5, z: 6 } });
    expect(restored.maps[mapKey(land)]).toEqual({});
    expect(Object.keys(restored.maps)).toHaveLength(2);
    expect(validCamera({ zoom: 1, position: [0, NaN, 0], target: [0, 0, 0] })).toBe(false);
  });
  it('handles denied storage reads and quota writes without breaking navigation', () => {
    const storage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('quota'); } };
    const save = readGameSave('space', 'member', storage);
    expect(save.current.type).toBe('hub');
    expect(writeGameSave(save, storage)).toBe(false);
    expect(backGameMap(enterGameMap(save, story)).current.scope.id).toBe('space');
  });
  it('bounds memory and stack growth without discarding the space return route', () => {
    let save = freshGameSave('space', 'member');
    for (let i = 0; i < 140; i++) {
      const next: GameMapSelection = { type: 'hub', scope: { kind: 'story', id: `story-${i}` } };
      save = rememberGameMap(enterGameMap(save, next), mapKey(next), { position: { x: i, z: 0 } });
    }
    expect(save.stack).toHaveLength(64);
    expect(Object.keys(save.maps)).toHaveLength(128);
    expect(save.maps[mapKey({ type: 'hub', scope: { kind: 'story', id: 'story-139' } })]?.position?.x).toBe(139);
    expect(backGameMap(save, 0).current.scope.id).toBe('space');
  });
});
