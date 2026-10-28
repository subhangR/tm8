// @vitest-environment jsdom
/**
 * THE PANEL'S SCENE (task 01a18396). Subhang: a nice background theme on the
 * top part only — space, mountains, forest — painted ones and photos both,
 * and a click anywhere on the scene moves to the next one.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./context')>()),
  useShellFrame: () => ({ spaceId: 'sp-1', gate: { switcherSlot: <button className="shell-switcher__trigger">tm8</button>, openPalette: vi.fn() } }),
}));

import { PanelTop } from './Browser';
import {
  PANEL_SCENE_CATALOG,
  PANEL_SCENE_KEY,
  nextScene,
  readPanelScene,
  setPanelScene,
} from './panelSceneStore';

beforeEach(() => {
  act(() => setPanelScene(null));
});
afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const head = () => screen.getByTestId('tws-paneltop').parentElement!;

describe('the scene catalog', () => {
  it('offers painted scenes and photos, each with a unique id', () => {
    const ids = PANEL_SCENE_CATALOG.map((scene) => scene.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(PANEL_SCENE_CATALOG.filter((scene) => scene.set === 'painted').length).toBeGreaterThan(0);
    for (const photo of PANEL_SCENE_CATALOG.filter((scene) => scene.set === 'photo')) {
      expect(photo.src).toMatch(/^\/scenes\/[a-z-]+\.jpg$/);
    }
  });

  it('next wraps from the last scene to the first, and none starts at the first', () => {
    const first = PANEL_SCENE_CATALOG[0]!;
    const last = PANEL_SCENE_CATALOG[PANEL_SCENE_CATALOG.length - 1]!;
    expect(nextScene(null).id).toBe(first.id);
    expect(nextScene(last.id).id).toBe(first.id);
    expect(nextScene(first.id).id).toBe(PANEL_SCENE_CATALOG[1]!.id);
  });

  it('remembers the choice, and reads a scene that no longer exists as none', () => {
    setPanelScene('mountains');
    expect(window.localStorage.getItem(PANEL_SCENE_KEY)).toBe('mountains');
    expect(readPanelScene()).toBe('mountains');
    window.localStorage.setItem(PANEL_SCENE_KEY, 'volcano');
    expect(readPanelScene()).toBeNull();
    setPanelScene(null);
    expect(window.localStorage.getItem(PANEL_SCENE_KEY)).toBeNull();
  });
});

describe('the panel head', () => {
  it('draws no scene until one is chosen', () => {
    render(<PanelTop searchable />);
    expect(screen.queryByTestId('tws-panel-scene')).toBeNull();
    expect(head().getAttribute('data-scene')).toBeNull();
  });

  it('⛰ opens the menu: None, then Painted and Photos; a pick paints the head', () => {
    render(<PanelTop searchable />);
    fireEvent.click(screen.getByTestId('tws-paneltop-scene'));
    const menu = screen.getByTestId('tws-scenemenu');
    expect([...menu.querySelectorAll('[role="group"]')].map((g) => g.getAttribute('aria-label'))).toEqual(['Painted', 'Photos']);
    expect(screen.getByTestId('tws-scenemenu-none').getAttribute('aria-checked')).toBe('true');

    fireEvent.click(screen.getByTestId('tws-scenemenu-forest'));
    expect(screen.queryByTestId('tws-scenemenu')).toBeNull();
    expect(screen.getByTestId('tws-panel-scene').getAttribute('data-scene-id')).toBe('forest');
    expect(readPanelScene()).toBe('forest');
  });

  it('resting on a swatch previews it; leaving the menu puts the choice back', () => {
    act(() => setPanelScene('space'));
    render(<PanelTop searchable />);
    fireEvent.click(screen.getByTestId('tws-paneltop-scene'));
    fireEvent.pointerEnter(screen.getByTestId('tws-scenemenu-photo-ocean'));
    expect(screen.getByTestId('tws-panel-scene').getAttribute('data-scene-id')).toBe('photo-ocean');
    fireEvent.pointerLeave(screen.getByTestId('tws-scenemenu'));
    expect(screen.getByTestId('tws-panel-scene').getAttribute('data-scene-id')).toBe('space');
    expect(readPanelScene()).toBe('space');
  });

  it('a click on the scene moves to the next one; a click on a control does not', () => {
    act(() => setPanelScene('space'));
    render(<PanelTop searchable />);
    fireEvent.click(head());
    expect(readPanelScene()).toBe(nextScene('space').id);

    fireEvent.click(screen.getByTestId('tws-paneltop-space'));
    fireEvent.click(screen.getByTestId('tws-paneltop-search'));
    expect(readPanelScene()).toBe(nextScene('space').id);
  });

  it('a night scene turns the row light; a themed one leaves the theme its ink', () => {
    act(() => setPanelScene('aurora'));
    render(<PanelTop searchable />);
    expect(head().getAttribute('data-scene-tone')).toBe('night');
    act(() => setPanelScene('mountains'));
    expect(head().getAttribute('data-scene-tone')).toBeNull();
  });
});
