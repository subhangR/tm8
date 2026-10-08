// @vitest-environment jsdom
import { act, fireEvent, render, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildMapModel, smallFixture, type MapType } from '../map-model';
import { WalkingMapView, type WalkingMapViewProps } from './WalkingMapView';
const scene = vi.hoisted(() => ({ webgl: false, last: null as any, failed: false }));
vi.mock('../palette', async original => ({ ...await original<typeof import('../palette')>(), hasWebGL: () => scene.webgl }));
vi.mock('../Minimap', () => ({ WorldMinimap: () => <div data-testid="controlled-minimap"/> }));
vi.mock('./WalkingSceneAdapter', () => ({ default: (props: any) => { scene.last = props; if (scene.failed) throw new Error('WebGL unavailable'); return <div data-testid="mock-scene"/>; } }));
const model = (type: MapType = 'taskland') => buildMapModel(smallFixture(), { type, scope: smallFixture().scope! });
function props(type: MapType = 'taskland'): WalkingMapViewProps {
  return { model: model(type), start: { x: 2, z: 4 }, onPosition: vi.fn(), onCamera: vi.fn(), onInspect: vi.fn(), onEnterPortal: vi.fn(), onBack: vi.fn() };
}
beforeEach(() => { scene.webgl = false; scene.last = null; scene.failed = false; });
afterEach(() => vi.restoreAllMocks());
describe('walking map boundary', () => {
  it.each(['taskland', 'office', 'library', 'factory', 'town'] as const)('inspects original %s entity IDs without navigation', type => {
    const input = props(type), view = render(<WalkingMapView {...input}/>);
    const place = input.model.places[0]!;
    fireEvent.click(view.getByRole('button', { name: `Inspect ${place.title}` }));
    expect(input.onInspect).toHaveBeenCalledWith(place.entityId);
    expect(input.onEnterPortal).not.toHaveBeenCalled();
  });
  it('walks to a portal before an explicit Enter/E action and passes the exact typed portal', () => {
    const input = props('hub'), view = render(<WalkingMapView {...input}/>);
    const portal = input.model.portals[0]!;
    fireEvent.click(view.getByRole('button', { name: `Walk to ${portal.label}` }));
    expect(input.onEnterPortal).not.toHaveBeenCalled();
    expect(input.onPosition).toHaveBeenCalledWith(portal.x, portal.z + portal.radius + 1.1);
    fireEvent.keyDown(view.getByTestId('walking-map'), { key: 'e' });
    expect(input.onEnterPortal).toHaveBeenCalledWith(portal);
    expect(input.onInspect).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole('button', { name: 'Enter The mountain trail' }));
    expect(input.onEnterPortal).toHaveBeenLastCalledWith(input.model.portals.find(p => p.entityId === 'child-story'));
  });
  it('moves with keyboard, clears keys when focus leaves, and flushes the last position on map exit', () => {
    const input = props();
    input.start = { x: (input.model.bounds.minX + input.model.bounds.maxX) / 2, z: (input.model.bounds.minZ + input.model.bounds.maxZ) / 2 };
    const view = render(<WalkingMapView {...input}/>), host = view.getByTestId('walking-map');
    fireEvent.keyDown(host, { key: 'd' });
    const saved = vi.mocked(input.onPosition).mock.calls.at(-1)!;
    expect(saved[0]).toBeGreaterThan(input.start.x);
    fireEvent.blur(host, { relatedTarget: document.body });
    fireEvent.keyDown(host, { key: 'a' });
    expect(vi.mocked(input.onPosition).mock.calls.at(-1)).toEqual([input.start.x, input.start.z]);
    view.unmount();
    expect(input.onPosition).toHaveBeenLastCalledWith(input.start.x, input.start.z);
  });
  it('backs once and yields Escape to editable/dialog content', () => {
    const input = props(), view = render(<WalkingMapView {...input}/>), host = view.getByTestId('walking-map');
    const bubbled = vi.fn(); window.addEventListener('keydown', bubbled);
    fireEvent.keyDown(host, { key: 'Escape' });
    expect(input.onBack).toHaveBeenCalledTimes(1);
    expect(bubbled).not.toHaveBeenCalled();
    const field = document.createElement('input'); host.append(field);
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(input.onBack).toHaveBeenCalledTimes(1);
    const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog'); host.append(dialog);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(input.onBack).toHaveBeenCalledTimes(1);
    window.removeEventListener('keydown', bubbled);
  });
  it('captures resume only at map mount, keeps controls through saves, and resets them for a different map', async () => {
    scene.webgl = true;
    const input = props(); input.camera = { zoom: 21, position: [35, 30, 28], target: [2, 0, 4] };
    const view = render(<WalkingMapView {...input}/>);
    await view.findByTestId('mock-scene');
    const first = scene.last.walking, start = scene.last.initial;
    act(() => { first.onPosition(8, 9); first.onCamera({ zoom: 27, position: [34, 30, 32], target: [8, 0, 9] }); });
    view.rerender(<WalkingMapView {...input} start={{ x: 8, z: 9 }} camera={{ zoom: 27, position: [34, 30, 32], target: [8, 0, 9] }}/>);
    expect(scene.last.initial).toEqual(start);
    expect(scene.last.walking.cameraState).toEqual(input.camera);
    expect(scene.last.walking.control).toBe(first.control);
    view.rerender(<WalkingMapView {...props('hub')} start={{ x: 17, z: 18 }}/>);
    await view.findByTestId('mock-scene');
    expect(scene.last.initial).toEqual({ x: 17, z: 18 });
    expect(scene.last.walking.control).not.toBe(first.control);
    expect(input.onPosition).toHaveBeenLastCalledWith(8, 9);
  });
  it('replaces an occupied/outside resume with a free entrance and drops its stale camera', async () => {
    scene.webgl = true;
    const input = props(), occupied = input.model.places[0]!;
    input.start = { x: occupied.x, z: occupied.z };
    input.camera = { zoom: 20, position: [80, 30, 40], target: [occupied.x, 0, occupied.z] };
    const view = render(<WalkingMapView {...input}/>);
    await view.findByTestId('mock-scene');
    expect(scene.last.initial.x).toBeLessThan(input.model.bounds.minX);
    expect(scene.last.walking.cameraState).toBeUndefined();
  });
  it('WebGL click issues a walk order; arrival alone never enters a map', async () => {
    scene.webgl = true;
    const input = props('hub'), view = render(<WalkingMapView {...input}/>);
    await view.findByTestId('mock-scene');
    const portal = input.model.portals[0]!;
    act(() => scene.last.onEnterPortal(portal));
    expect(scene.last.walking.control.order).toMatchObject({ placeId: portal.id, open: false });
    act(() => scene.last.walking.onArrive(portal.id, false));
    expect(input.onEnterPortal).not.toHaveBeenCalled();
    fireEvent.click(within(view.getByRole('region', { name: 'Nearby place' })).getByRole('button', { name: /Enter/ }));
    expect(input.onEnterPortal).toHaveBeenCalledWith(portal);
  });
  it('labels an empty map and recovers a rejected WebGL scene to accessible places', async () => {
    const input = props(); input.model = { ...input.model, places: [], portals: [] };
    const view = render(<WalkingMapView {...input}/>);
    expect(view.getByRole('status').textContent).toContain('No entities');
    scene.webgl = true; scene.failed = true;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    view.rerender(<WalkingMapView {...props('library')}/>);
    expect(await view.findByRole('region', { name: 'Map places' })).toBeTruthy();
    expect(view.getByTestId('walking-map').getAttribute('data-renderer')).toBe('dom');
  });
});
