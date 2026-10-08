// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildMapModel } from '../story/game/map-model';
import type { MapScope } from '../story/game/map-model';
import { enterGameMap, freshGameSave, mapKey, readGameSave, rememberGameMap, writeGameSave } from './local-save';
import type { GameMapLoader, GameMapResult } from './types';
import GameMode from './GameMode';

// Exercise the real walking renderer's accessible fallback and callbacks.
vi.mock('../story/game/palette', async original => ({ ...await original<typeof import('../story/game/palette')>(), hasWebGL: () => false }));
function result(scope: MapScope): GameMapResult {
  return { title: scope.kind === 'space' ? 'Space' : 'Child story', input: { scope, edges: [], entities: [
    { id: 'task', kind: 'task', title: 'Task', status: 'working' },
    ...(scope.kind === 'space' ? [{ id: 'child', kind: 'story', title: 'Child story' }] : []),
  ] } };
}
const loader: GameMapLoader = async scope => result(scope);
const props = { spaceId: 'space', memberId: 'member', loadMap: loader, onInspect: vi.fn() };
beforeEach(() => window.localStorage.clear());
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('GameMode with the real walking DOM renderer', () => {
  it('traverses typed/story portals, inspects entity identity, and pops only once with renderer Escape', async () => {
    const screen = render(<GameMode {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Enter Child story' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Enter Taskland' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Inspect Task' }));
    expect(props.onInspect).toHaveBeenCalledWith('task');
    expect(readGameSave('space', 'member').current).toMatchObject({ type: 'taskland', scope: { kind: 'story', id: 'child' } });
    fireEvent.keyDown(screen.getByRole('application'), { key: 'Escape' });
    await screen.findByRole('button', { name: 'Enter Taskland' });
    expect(readGameSave('space', 'member').current).toMatchObject({ type: 'hub', scope: { kind: 'story', id: 'child' } });
    expect(readGameSave('space', 'member').stack).toHaveLength(1);
  });
  it('lets a panel capture Escape before the focused real renderer pops its map', async () => {
    let panelOpen = false;
    const panelEscape = (event: KeyboardEvent) => {
      if (panelOpen && event.key === 'Escape') { event.preventDefault(); panelOpen = false; }
    };
    window.addEventListener('keydown', panelEscape, true);
    try {
      const screen = render(<GameMode {...props} onInspect={() => { panelOpen = true; }} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Enter Taskland' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Inspect Task' }));
      const host = screen.getByRole('application'); host.focus();
      expect(document.activeElement).toBe(host);
      fireEvent.keyDown(host, { key: 'Escape' });
      expect(panelOpen).toBe(false);
      expect(readGameSave('space', 'member').current.type).toBe('taskland');
      fireEvent.keyDown(host, { key: 'Escape' });
      await screen.findByRole('button', { name: 'Enter Taskland' });
      expect(readGameSave('space', 'member').current.type).toBe('hub');
    } finally { window.removeEventListener('keydown', panelEscape, true); }
  });
  it('preserves an in-bounds occupied saved pose and camera, then lets keyboard movement escape it', async () => {
    const scope = { kind: 'space' as const, id: 'space' };
    const map = { type: 'taskland' as const, scope };
    const model = buildMapModel(result(scope).input, map);
    const place = model.places[0]!;
    const initial = { x: place.x, z: place.z };
    const save = enterGameMap(freshGameSave('space', 'member'), map);
    writeGameSave(rememberGameMap(save, mapKey(map), { position: initial, camera: { zoom: 21, position: [3, 4, 5], target: [initial.x, 0, initial.z] } }));
    const screen = render(<GameMode {...props} />);
    await screen.findByRole('button', { name: 'Inspect Task' });
    expect(readGameSave('space', 'member').maps[mapKey(map)]!.position).toEqual(initial);
    expect(readGameSave('space', 'member').maps[mapKey(map)]!.camera?.zoom).toBe(21);
    fireEvent.keyDown(screen.getByRole('application'), { key: 'd' });
    fireEvent.keyUp(screen.getByRole('application'), { key: 'd' });
    fireEvent(window, new Event('pagehide'));
    const moved = readGameSave('space', 'member').maps[mapKey(map)]!.position!;
    expect(moved.x).toBeGreaterThan(initial.x);
    expect(Math.hypot(moved.x - initial.x, moved.z - initial.z)).toBeCloseTo(1);
  });
  it('keeps the final real-renderer pose across Game unmount and a reload', async () => {
    const screen = render(<GameMode {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Enter Taskland' }));
    await screen.findByRole('button', { name: 'Inspect Task' });
    const host = screen.getByRole('application');
    fireEvent.keyDown(host, { key: 'd' }); fireEvent.keyUp(host, { key: 'd' });
    screen.unmount();
    const before = readGameSave('space', 'member');
    const key = mapKey(before.current), position = before.maps[key]!.position!;
    const reloaded = render(<GameMode {...props} />);
    await reloaded.findByRole('button', { name: 'Inspect Task' });
    fireEvent.keyDown(reloaded.getByRole('application'), { key: 'd' });
    fireEvent.keyUp(reloaded.getByRole('application'), { key: 'd' });
    fireEvent(window, new Event('pagehide'));
    await waitFor(() => {
      const moved = readGameSave('space', 'member').maps[key]!.position!;
      expect(moved.x).toBeGreaterThan(position.x);
      expect(Math.hypot(moved.x - position.x, moved.z - position.z)).toBeCloseTo(1);
    });
  });
});
