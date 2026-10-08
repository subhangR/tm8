// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import type { ComponentProps } from 'react';
import { buildMapModel } from '../story/game/map-model';
import type { MapScope } from '../story/game/map-model';
import { walkingBounds, walkingEntrance } from '../story/game/map-model/walking-world';
import type { GameMapLoader, GameMapResult } from './types';
import { enterGameMap, freshGameSave, gameSaveKey, mapKey, readGameSave, rememberGameMap, writeGameSave } from './local-save';
import GameMode from './GameMode';
import type { WalkingMapView } from '../story/game/maps/WalkingMapView';
import type { GameNavigationView } from '@tm8/contract';
import type { GamePersistencePort } from './durable-save';
type WalkingMapViewProps = ComponentProps<typeof WalkingMapView>;

const ports = vi.hoisted(() => ({ props: null as WalkingMapViewProps | null, finalPosition: null as { x: number; z: number } | null }));
vi.mock('../story/game/maps/WalkingMapView', () => ({ WalkingMapView: (props: WalkingMapViewProps) => {
  ports.props = props;
  useEffect(() => () => { if (ports.finalPosition) props.onPosition(ports.finalPosition.x, ports.finalPosition.z); }, []);
  return <div data-testid="walking" onKeyDown={event => { if (event.key === 'Escape') props.onBack?.(); }}>
    <span>{props.model.scope.id}:{props.model.type}</span>
    <span data-testid="start">{props.start.x},{props.start.z}:{props.camera?.zoom ?? 'default'}</span>
    {props.model.portals.map(portal => <button key={portal.id} onClick={() => props.onEnterPortal(portal)}>{portal.label}</button>)}
    <button onClick={() => { props.onPosition(7, 9); props.onCamera({ zoom: 3, position: [1, 2, 3], target: [7, 0, 9] }); }}>Walk and zoom</button>
    <button onClick={() => props.onInspect(props.model.places[0]?.entityId ?? 'real-task')}>Inspect entity</button>
  </div>;
} }));
function result(scope: MapScope): GameMapResult {
  return { title: scope.kind === 'space' ? 'My space' : scope.id === 'story-a' ? 'Story A' : 'Story B', input: { scope, edges: [], entities: [
    { id: 'real-task', kind: 'task', title: 'Real task', status: 'working' },
    ...(scope.kind === 'space' ? [{ id: 'story-a', kind: 'story', title: 'Story A' }]
      : scope.id === 'story-a' ? [{ id: 'story-b', kind: 'story', title: 'Story B', parentId: 'story-a' }] : []),
  ] } };
}
const loader = () => vi.fn<GameMapLoader>(async scope => result(scope));
const defaults = { spaceId: 'space', memberId: 'member', onInspect: vi.fn() };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
beforeEach(() => { window.localStorage.clear(); ports.props = null; ports.finalPosition = null; });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('GameMode navigation', () => {
  it('provides all five typed destinations at space and story scope and child-story portals', async () => {
    const loadMap = loader(); const screen = render(<GameMode {...defaults} loadMap={loadMap} />);
    await screen.findByText('space:hub');
    for (const label of ['Taskland', 'Office', 'Library', 'Code Factory', 'Completed Town']) expect(screen.getByRole('button', { name: label })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Story A' }));
    await screen.findByText('story-a:hub');
    for (const label of ['Taskland', 'Office', 'Library', 'Code Factory', 'Completed Town']) expect(screen.getByRole('button', { name: label })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Story B' }));
    await screen.findByText('story-b:hub');
    fireEvent.keyDown(window, { key: 'Escape' });
    await screen.findByText('story-a:hub');
    expect(loadMap).toHaveBeenLastCalledWith({ kind: 'story', id: 'story-a' }, expect.any(AbortSignal), 'hub');
  });
  it('passes the selected type to the loader on portal travel, back and saved-map restore', async () => {
    const loadMap = loader(); const screen = render(<GameMode {...defaults} loadMap={loadMap} />);
    await screen.findByText('space:hub');
    expect(loadMap).toHaveBeenLastCalledWith({ kind: 'space', id: 'space' }, expect.any(AbortSignal), 'hub');
    for (const [label, type] of [['Taskland', 'taskland'], ['Office', 'office'], ['Library', 'library'], ['Code Factory', 'factory'], ['Completed Town', 'town']] as const) {
      fireEvent.click(screen.getByRole('button', { name: label }));
      await screen.findByText(`space:${type}`);
      expect(loadMap).toHaveBeenLastCalledWith({ kind: 'space', id: 'space' }, expect.any(AbortSignal), type);
      fireEvent.click(screen.getByRole('button', { name: 'Back one map' }));
      await screen.findByText('space:hub');
      expect(loadMap).toHaveBeenLastCalledWith({ kind: 'space', id: 'space' }, expect.any(AbortSignal), 'hub');
    }
    fireEvent.click(screen.getByRole('button', { name: 'Story A' }));
    await screen.findByText('story-a:hub');
    expect(loadMap).toHaveBeenLastCalledWith({ kind: 'story', id: 'story-a' }, expect.any(AbortSignal), 'hub');
    fireEvent.click(screen.getByRole('button', { name: 'Taskland' }));
    await screen.findByText('story-a:taskland');
    screen.unmount();
    const reloaded = render(<GameMode {...defaults} loadMap={loadMap} />);
    await reloaded.findByText('story-a:taskland');
    expect(loadMap).toHaveBeenLastCalledWith({ kind: 'story', id: 'story-a' }, expect.any(AbortSignal), 'taskland');
  });
  it('inspects real entities within the map and Esc pops exactly once even when the renderer also handles it', async () => {
    const inspect = vi.fn(); const screen = render(<GameMode {...defaults} onInspect={inspect} loadMap={loader()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Story A' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Taskland' }));
    await screen.findByText('story-a:taskland');
    fireEvent.click(screen.getByText('Inspect entity'));
    expect(inspect).toHaveBeenCalledWith('real-task');
    expect(screen.getByText('story-a:taskland')).toBeTruthy();
    fireEvent.keyDown(screen.getByTestId('walking'), { key: 'Escape' });
    await screen.findByText('story-a:hub');
    expect(readGameSave('space', 'member').stack).toHaveLength(1);
  });
  it('restores map-specific position/camera on back and persists current map and stack across reload', async () => {
    const loadMap = loader(); const screen = render(<GameMode {...defaults} loadMap={loadMap} />);
    await screen.findByText('space:hub');
    fireEvent.click(screen.getByText('Walk and zoom'));
    fireEvent.click(screen.getByRole('button', { name: 'Story A' }));
    await screen.findByText('story-a:hub');
    expect(ports.props!.start).toEqual(walkingEntrance(ports.props!.model));
    expect(ports.props!.camera).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: 'Back one map' }));
    await screen.findByText('space:hub');
    expect(screen.getByTestId('start').textContent).toBe('7,9:3');
    fireEvent.click(screen.getByRole('button', { name: 'Taskland' }));
    await screen.findByText('space:taskland');
    fireEvent.click(screen.getByText('Walk and zoom'));
    screen.unmount();
    const reloaded = render(<GameMode {...defaults} loadMap={loadMap} />);
    await reloaded.findByText('space:taskland');
    expect(reloaded.getByTestId('start').textContent).toBe('7,9:3');
    expect(readGameSave('space', 'member').stack).toHaveLength(1);
  });
  it('flushes before pagehide without resetting renderer mount values on every save', async () => {
    const screen = render(<GameMode {...defaults} loadMap={loader()} />);
    await screen.findByText('space:hub');
    fireEvent.click(screen.getByText('Walk and zoom'));
    fireEvent(window, new Event('pagehide'));
    expect(Object.values(readGameSave('space', 'member').maps)[0]?.position).toEqual({ x: 7, z: 9 });
    expect(ports.props!.start).toEqual(walkingEntrance(ports.props!.model));
    expect(ports.props!.camera).toBeUndefined();
  });
  it('clamps an old saved pose to the current walking area while retaining the entrance area', async () => {
    const save = freshGameSave('space', 'member');
    writeGameSave(rememberGameMap(save, mapKey(save.current), { position: { x: 100_000, z: -100_000 }, camera: { zoom: 21, position: [3, 4, 5], target: [100_000, 0, -100_000] } }));
    const screen = render(<GameMode {...defaults} loadMap={loader()} />);
    await screen.findByText('space:hub');
    const bounds = walkingBounds(ports.props!.model);
    expect(ports.props!.start).toEqual({ x: bounds.maxX, z: bounds.minZ });
    expect(Object.values(readGameSave('space', 'member').maps)[0]?.position).toEqual(ports.props!.start);
    expect(ports.props!.camera).toBeUndefined();
    expect(Object.values(readGameSave('space', 'member').maps)[0]?.camera).toBeUndefined();
  });
  it('reloads an exact in-bounds occupied pose and camera without relocating it', async () => {
    const scope = { kind: 'space' as const, id: 'space' }, map = { type: 'taskland' as const, scope };
    const model = buildMapModel(result(scope).input, map), place = model.places[0]!;
    const position = { x: place.x, z: place.z };
    const camera = { zoom: 21, position: [3, 4, 5] as [number, number, number], target: [place.x, 0, place.z] as [number, number, number] };
    writeGameSave(rememberGameMap(enterGameMap(freshGameSave('space', 'member'), map), mapKey(map), { position, camera }));
    const loadMap = loader(); const screen = render(<GameMode {...defaults} loadMap={loadMap} />);
    await screen.findByText('space:taskland');
    expect(ports.props!.start).toEqual(position);
    expect(ports.props!.camera).toEqual(camera);
    screen.unmount();
    const reloaded = render(<GameMode {...defaults} loadMap={loadMap} />);
    await reloaded.findByText('space:taskland');
    expect(ports.props!.start).toEqual(position);
    expect(ports.props!.camera).toEqual(camera);
  });
  it('persists the renderer final cleanup callback immediately on Game mode unmount', async () => {
    const screen = render(<GameMode {...defaults} loadMap={loader()} />);
    await screen.findByText('space:hub');
    ports.finalPosition = { x: 20, z: 30 };
    screen.unmount();
    expect(Object.values(readGameSave('space', 'member').maps)[0]?.position).toEqual({ x: 20, z: 30 });
  });
  it('cancels a pending load when going back and ignores a late response from the cancelled map', async () => {
    const pending = deferred<GameMapResult>();
    const loadMap = vi.fn<GameMapLoader>((scope) => scope.kind === 'story' ? pending.promise : Promise.resolve(result(scope)));
    const screen = render(<GameMode {...defaults} loadMap={loadMap} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Story A' }));
    await waitFor(() => expect(loadMap).toHaveBeenCalledTimes(2));
    const signal = loadMap.mock.calls[1]![1]!;
    fireEvent.keyDown(window, { key: 'Escape' });
    await screen.findByText('space:hub');
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve(result({ kind: 'story', id: 'story-a' })));
    expect(screen.queryByText('story-a:hub')).toBeNull();
    expect(readGameSave('space', 'member').current.scope.id).toBe('space');
  });
  it('retries loader failures and can recover a failed saved map by returning to space hub', async () => {
    const loadMap = loader().mockRejectedValueOnce(new Error('Network unavailable'));
    const screen = render(<GameMode {...defaults} loadMap={loadMap} />);
    await screen.findByRole('alert');
    expect(screen.getByText('Network unavailable')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry map' }));
    await screen.findByText('space:hub');
    loadMap.mockRejectedValueOnce(new Error('Story access removed'));
    fireEvent.click(screen.getByRole('button', { name: 'Story A' }));
    await screen.findByText('Story access removed');
    fireEvent.click(screen.getByRole('button', { name: 'Return to space hub' }));
    await screen.findByText('space:hub');
    expect(readGameSave('space', 'member').stack).toEqual([]);
  });
  it('rejects explicitly mismatched scoped snapshots', async () => {
    const loadMap = loader().mockResolvedValueOnce(result({ kind: 'story', id: 'wrong' }));
    const screen = render(<GameMode {...defaults} loadMap={loadMap} />);
    await screen.findByText('The map data does not match the selected scope.');
    expect(screen.queryByTestId('walking')).toBeNull();
    fireEvent.click(screen.getByText('Return to space hub'));
    await screen.findByText('space:hub');
  });
  it('shows loader/model warnings to the player', async () => {
    const loadMap = vi.fn<GameMapLoader>(async scope => { const data = result(scope); return { ...data, input: { ...data.input, warnings: ['Story membership is truncated.'] } }; });
    const screen = render(<GameMode {...defaults} loadMap={loadMap} />);
    await screen.findByText('Story membership is truncated.');
    expect(screen.getByText('Map notices')).toBeTruthy();
  });
  it('recovers a forbidden restored story to the deepest available parent and rewrites the saved route', async () => {
    const parent = { type: 'hub' as const, scope: { kind: 'story' as const, id: 'story-a' } };
    const child = { type: 'hub' as const, scope: { kind: 'story' as const, id: 'story-b' } };
    let save = enterGameMap(enterGameMap(freshGameSave('space', 'member'), parent), child);
    save = enterGameMap(save, { type: 'taskland', scope: child.scope });
    writeGameSave(save);
    const loadMap = vi.fn<GameMapLoader>(async scope => {
      if (scope.id === 'story-b') throw Object.assign(new Error('Forbidden'), { code: 'forbidden' });
      return result(scope);
    });
    const screen = render(<GameMode {...defaults} loadMap={loadMap} />);
    await screen.findByText('story-a:hub');
    expect(screen.getByText('That story is no longer available. Returned to an available hub.')).toBeTruthy();
    expect(readGameSave('space', 'member').stack).toHaveLength(1);
    expect(loadMap.mock.calls.map(([scope]) => scope.id)).toEqual(['story-b', 'story-a']);
  });
  it('continues recovery past multiple deleted ancestors to the space hub', async () => {
    const first = { type: 'hub' as const, scope: { kind: 'story' as const, id: 'story-a' } };
    const second = { type: 'hub' as const, scope: { kind: 'story' as const, id: 'story-b' } };
    writeGameSave(enterGameMap(enterGameMap(freshGameSave('space', 'member'), first), second));
    const loadMap = vi.fn<GameMapLoader>(async scope => {
      if (scope.kind === 'story') throw Object.assign(new Error('Deleted'), { status: 404 });
      return result(scope);
    });
    const screen = render(<GameMode {...defaults} loadMap={loadMap} />);
    await screen.findByText('space:hub');
    expect(readGameSave('space', 'member').stack).toEqual([]);
    expect(loadMap.mock.calls.map(([scope]) => scope.id)).toEqual(['story-b', 'story-a', 'space']);
  });
  it('drops stale portal/back/inspection callbacks after leaving and revisiting a map', async () => {
    const inspect = vi.fn(); const screen = render(<GameMode {...defaults} onInspect={inspect} loadMap={loader()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Story A' }));
    await screen.findByText('story-a:hub');
    const outgoing = ports.props!;
    fireEvent.click(screen.getByRole('button', { name: 'Taskland' }));
    await screen.findByText('story-a:taskland');
    fireEvent.click(screen.getByRole('button', { name: 'Back one map' }));
    await screen.findByText('story-a:hub');
    act(() => { outgoing.onBack?.(); outgoing.onInspect('stale-task'); outgoing.onEnterPortal(outgoing.model.portals[0]!); });
    expect(screen.getByText('story-a:hub')).toBeTruthy();
    expect(inspect).not.toHaveBeenCalled();
  });
  it('replaces a pending loader and rejects its late response even for the same map key', async () => {
    const old = deferred<GameMapResult>();
    const previous = vi.fn<GameMapLoader>(() => old.promise);
    const screen = render(<GameMode {...defaults} loadMap={previous} />);
    await waitFor(() => expect(previous).toHaveBeenCalledOnce());
    const next = loader();
    screen.rerender(<GameMode {...defaults} loadMap={next} />);
    await screen.findByText('space:hub');
    expect(previous.mock.calls[0]![1]!.aborted).toBe(true);
    await act(async () => old.resolve({ ...result({ kind: 'space', id: 'space' }), title: 'Old result' }));
    expect(screen.queryByText('Old result · Hub')).toBeNull();
  });
  it('continues walking and navigating when browser storage is unavailable', async () => {
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    const screen = render(<GameMode {...defaults} loadMap={loader()} />);
    await screen.findByText('space:hub');
    await screen.findByText('Browser save is unavailable. Your place is kept for this visit.');
    fireEvent.click(screen.getByRole('button', { name: 'Taskland' }));
    await screen.findByText('space:taskland');
  });
  it('isolates a member/space prop change and aborts outgoing account loads', async () => {
    const loadMap = loader(); const screen = render(<GameMode {...defaults} loadMap={loadMap} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Taskland' }));
    await screen.findByText('space:taskland');
    const oldSignal = loadMap.mock.calls.at(-1)![1]!;
    screen.rerender(<GameMode {...defaults} memberId="other-member" spaceId="other-space" loadMap={loadMap} />);
    await screen.findByText('other-space:hub');
    expect(oldSignal.aborted).toBe(true);
    expect(readGameSave('space', 'member').current.type).toBe('taskland');
    expect(readGameSave('other-space', 'other-member').stack).toEqual([]);
  });
  it('allows final renderer cleanup pose saves for the outgoing map without changing the selected map', async () => {
    const screen = render(<GameMode {...defaults} loadMap={loader()} />);
    await screen.findByText('space:hub');
    const outgoing = ports.props!;
    fireEvent.click(screen.getByRole('button', { name: 'Story A' }));
    await screen.findByText('story-a:hub');
    act(() => { outgoing.onPosition(12, 5); outgoing.onCamera({ zoom: 4, position: [1, 2, 3], target: [12, 0, 5] }); outgoing.onBack?.(); });
    expect(readGameSave('space', 'member').current.scope.id).toBe('story-a');
    fireEvent.click(screen.getByRole('button', { name: 'Back one map' }));
    await screen.findByText('space:hub');
    expect(screen.getByTestId('start').textContent).toBe('12,5:4');
  });
  it('ignores Escape in editors, dialogs and events already consumed by detail panels', async () => {
    const screen = render(<GameMode {...defaults} loadMap={loader()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Story A' }));
    await screen.findByText('story-a:hub');
    const input = document.createElement('input'); document.body.append(input);
    fireEvent.keyDown(input, { key: 'Escape' }); input.remove();
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }); event.preventDefault();
    fireEvent(window, event);
    expect(screen.getByText('story-a:hub')).toBeTruthy();
  });
  it('yields body-focused Escape to a panel capture handler before popping a map', async () => {
    let panelOpen = false;
    const panelEscape = (event: KeyboardEvent) => {
      if (panelOpen && event.key === 'Escape') { event.preventDefault(); panelOpen = false; }
    };
    window.addEventListener('keydown', panelEscape, true);
    try {
      const screen = render(<GameMode {...defaults} onInspect={() => { panelOpen = true; }} loadMap={loader()} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Taskland' }));
      await screen.findByText('space:taskland');
      fireEvent.click(screen.getByText('Inspect entity'));
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(panelOpen).toBe(false);
      expect(screen.getByText('space:taskland')).toBeTruthy();
      fireEvent.keyDown(document.body, { key: 'Escape' });
      await screen.findByText('space:hub');
    } finally { window.removeEventListener('keydown', panelEscape, true); }
  });
  it('opens the space hub from a corrupted local save', async () => {
    window.localStorage.setItem(gameSaveKey('space', 'member'), '{bad');
    const screen = render(<GameMode {...defaults} loadMap={loader()} />);
    await screen.findByText('space:hub');
    expect(screen.getByRole('button', { name: 'Back one map' }).hasAttribute('disabled')).toBe(true);
  });
});

const DURABLE_SPACE = '00000000-0000-4000-8000-000000000001';
const DURABLE_MEMBER = '00000000-0000-4000-8000-000000000002';
const DURABLE_STORY = '00000000-0000-4000-8000-000000000003';
const durableInitial = () => freshGameSave(DURABLE_SPACE, DURABLE_MEMBER);
const durableView = (save: GameNavigationView['save'] = null, revision = 0): GameNavigationView =>
  ({ spaceId: DURABLE_SPACE, memberId: DURABLE_MEMBER, save, revision, repairs: { routeTruncated: false, droppedMemories: 0 } });
function durablePort() {
  return { load: vi.fn<GamePersistencePort['load']>(async () => durableView()),
    save: vi.fn<GamePersistencePort['save']>(async (_space, save, revision) => durableView(save, revision + 1)) };
}
const durableLoader = () => vi.fn<GameMapLoader>(async scope => ({ title: 'Durable map', input: { scope, edges: [], entities: [
  { id: 'real-task', kind: 'task', title: 'Real task', status: 'working' },
  { id: DURABLE_STORY, kind: 'story', title: 'Durable story' },
] } }));
const durableDefaults = { spaceId: DURABLE_SPACE, memberId: DURABLE_MEMBER, onInspect: vi.fn() };

describe('GameMode durable resume integration', () => {
  it('retains poses reported inside the browser debounce when a server ACK repairs an older memory', async () => {
    const persistence = durablePort();
    const screen = render(<GameMode {...durableDefaults} loadMap={durableLoader()} persistence={persistence} />);
    await screen.findByText(`${DURABLE_SPACE}:hub`);
    await waitFor(() => expect(persistence.save).toHaveBeenCalledTimes(1));
    const pending = deferred<GameNavigationView>(); persistence.save.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByText('Walk and zoom')); fireEvent(window, new Event('pagehide'));
    await waitFor(() => expect(persistence.save).toHaveBeenCalledTimes(2));
    act(() => ports.props!.onPosition(44, 55));
    await act(async () => pending.resolve({ ...durableView(durableInitial(), 2), repairs: { routeTruncated: false, droppedMemories: 1 } }));
    fireEvent(window, new Event('pagehide'));
    await waitFor(() => expect(persistence.save.mock.calls.at(-1)?.[1].maps[mapKey(durableInitial().current)]?.position).toEqual({ x: 44, z: 55 }));
  });
  it('treats a first-time healthy member as ready without an unavailable notice and saves revision0', async () => {
    const persistence = durablePort();
    const screen = render(<GameMode {...durableDefaults} loadMap={durableLoader()} persistence={persistence} />);
    await screen.findByText(`${DURABLE_SPACE}:hub`);
    expect(screen.queryByText(/save is unavailable/)).toBeNull();
    expect(persistence.save.mock.calls[0]?.[2]).toBe(0);
    fireEvent.click(screen.getByText('Walk and zoom')); fireEvent(window, new Event('pagehide'));
    await waitFor(() => expect(persistence.save.mock.calls.at(-1)?.[1].maps[mapKey(durableInitial().current)]?.position).toEqual({ x: 7, z: 9 }));
    expect(screen.queryByText(/save is unavailable/)).toBeNull();
  });
  it('gates map reads until hydration and restores a server-only route with an exact pose/camera inside a footprint', async () => {
    const loadMap = durableLoader(), persistence = durablePort();
    const story = { type: 'hub' as const, scope: { kind: 'story' as const, id: DURABLE_STORY } };
    const taskland = { ...story, type: 'taskland' as const };
    const model = buildMapModel((await loadMap(taskland.scope)).input, taskland), place = model.places[0]!;
    const position = { x: place.x, z: place.z };
    const camera = { zoom: 3, position: [1, 40, 2] as [number, number, number], target: [place.x, 0, place.z] as [number, number, number] };
    const saved = rememberGameMap(enterGameMap(enterGameMap(durableInitial(), story), taskland), mapKey(taskland), { position, camera });
    loadMap.mockClear();
    const pending = deferred<GameNavigationView>(); persistence.load.mockReturnValueOnce(pending.promise);
    const screen = render(<GameMode {...durableDefaults} loadMap={loadMap} persistence={persistence} />);
    expect(screen.getByText('Restoring your place…')).toBeTruthy();
    expect(loadMap).not.toHaveBeenCalled(); expect(persistence.save).not.toHaveBeenCalled();
    await act(async () => pending.resolve(durableView(saved, 12)));
    await screen.findByText(`${DURABLE_STORY}:taskland`);
    expect(loadMap).toHaveBeenCalledTimes(1);
    expect(ports.props!.start).toEqual(position); expect(ports.props!.camera).toEqual(camera);
    expect(readGameSave(DURABLE_SPACE, DURABLE_MEMBER).stack).toHaveLength(2);
    fireEvent.keyDown(window, { key: 'Escape' });
    await screen.findByText(`${DURABLE_STORY}:hub`);
    expect(readGameSave(DURABLE_SPACE, DURABLE_MEMBER).stack).toHaveLength(1);
  });

  it('repairs only out-of-bounds server poses, dropping their camera, while fresh maps use the entrance', async () => {
    const persistence = durablePort(), loadMap = durableLoader();
    const taskland = { type: 'taskland' as const, scope: { kind: 'space' as const, id: DURABLE_SPACE } };
    const state = rememberGameMap(enterGameMap(durableInitial(), taskland), mapKey(taskland), {
      position: { x: 999_999, z: -999_999 }, camera: { zoom: 2, position: [1, 2, 3], target: [999_999, 0, -999_999] },
    });
    persistence.load.mockResolvedValue(durableView(state, 3));
    const screen = render(<GameMode {...durableDefaults} loadMap={loadMap} persistence={persistence} />);
    await screen.findByText(`${DURABLE_SPACE}:taskland`);
    const bounds = walkingBounds(ports.props!.model);
    expect(ports.props!.start).toEqual({ x: bounds.maxX, z: bounds.minZ }); expect(ports.props!.camera).toBeUndefined();
    fireEvent.keyDown(window, { key: 'Escape' });
    await screen.findByText(`${DURABLE_SPACE}:hub`);
    expect(ports.props!.start).toEqual(walkingEntrance(ports.props!.model));
  });

  it('keeps failed hydration local and retries only after an explicit successful revision read', async () => {
    const persistence = durablePort(); persistence.load.mockRejectedValueOnce(new Error('Private account payload'));
    const screen = render(<GameMode {...durableDefaults} loadMap={durableLoader()} persistence={persistence} />);
    await screen.findByText(`${DURABLE_SPACE}:hub`);
    fireEvent.click(screen.getByText('Walk and zoom')); fireEvent(window, new Event('pagehide'));
    expect(persistence.save).not.toHaveBeenCalled(); expect(screen.getByText(/Server save is unavailable/)).toBeTruthy();
    expect(screen.queryByText('Private account payload')).toBeNull();
    persistence.load.mockResolvedValue(durableView(null, 11));
    fireEvent.click(screen.getByRole('button', { name: 'Save this visit to server' }));
    await waitFor(() => expect(persistence.save).toHaveBeenCalledTimes(1));
    expect(persistence.save.mock.calls[0]?.[2]).toBe(11);
  });

  it('keeps pagehide and final renderer cleanup snapshots latest and uses best effort keepalive', async () => {
    const persistence = durablePort();
    const screen = render(<GameMode {...durableDefaults} loadMap={durableLoader()} persistence={persistence} />);
    await screen.findByText(`${DURABLE_SPACE}:hub`);
    fireEvent.click(screen.getByText('Walk and zoom')); fireEvent(window, new Event('pagehide'));
    await waitFor(() => expect(persistence.save.mock.calls.at(-1)?.[3]?.keepalive).toBe(true));
    ports.finalPosition = { x: 20, z: 30 }; screen.unmount();
    await waitFor(() => expect(persistence.save.mock.calls.at(-1)?.[1].maps[mapKey(durableInitial().current)]?.position).toEqual({ x: 20, z: 30 }));
    expect(persistence.save.mock.calls.at(-1)?.[3]?.keepalive).toBe(true);
  });

  it('cancels old hydration on member change and ignores its late response', async () => {
    const persistence = durablePort(), pending = deferred<GameNavigationView>(); persistence.load.mockReturnValueOnce(pending.promise);
    const identity = new AbortController();
    const screen = render(<GameMode {...durableDefaults} loadMap={durableLoader()} persistence={persistence} identitySignal={identity.signal} />);
    const oldSignal = persistence.load.mock.calls[0]![1]!;
    const next = durablePort(); next.load.mockResolvedValue({ ...durableView(), memberId: DURABLE_STORY });
    next.save.mockImplementation(async (_space, save, revision) => ({ ...durableView(save, revision + 1), memberId: DURABLE_STORY }));
    identity.abort();
    screen.rerender(<GameMode {...durableDefaults} memberId={DURABLE_STORY} loadMap={durableLoader()} persistence={next} identitySignal={new AbortController().signal} />);
    await screen.findByText(`${DURABLE_SPACE}:hub`); expect(oldSignal.aborted).toBe(true);
    await act(async () => pending.resolve(durableView(enterGameMap(durableInitial(), { type: 'office', scope: { kind: 'space', id: DURABLE_SPACE } }), 10)));
    expect(screen.queryByText(`${DURABLE_SPACE}:office`)).toBeNull(); expect(persistence.save).not.toHaveBeenCalled();
    expect(readGameSave(DURABLE_SPACE, DURABLE_STORY).current.type).toBe('hub');
  });
});
