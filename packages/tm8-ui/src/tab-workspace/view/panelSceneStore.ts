/**
 * THE PANEL'S SCENE (task 01a18396): an optional landscape behind the top of
 * the left panel — the "Space: <name>" row and the new-item tile — faded into
 * the panel's own surface below them. Two sets: PAINTED scenes, drawn as
 * vector layers (`PanelScene.tsx`), and PHOTOS, bundled under
 * `public/scenes/` (credits beside them). Or none: the panel as it was.
 *
 * A VIEWER'S CHOICE ON THIS DEVICE, like the rail's other preferences: one
 * localStorage key, every space, and other tabs follow by the `storage` event.
 */
import { useSyncExternalStore } from 'react';

export const PAINTED_SCENES = ['space', 'mountains', 'forest', 'ocean', 'aurora', 'dunes'] as const;
export type PaintedSceneId = (typeof PAINTED_SCENES)[number];

/**
 * How the row's ink sits on a scene. `night`: the scene is dark, the ink turns
 * light in either theme. `day`: the scene is light, the ink stays dark in
 * either theme. `theme`: the scene has a day and a night palette and follows
 * the theme, so the theme's own ink is already right.
 */
export type SceneTone = 'night' | 'day' | 'theme';

export interface PanelScene {
  id: string;
  label: string;
  set: 'painted' | 'photo';
  tone: SceneTone;
  /** Painted: which drawing. */
  art?: PaintedSceneId;
  /** Photo: its file, and which part of it the band shows. */
  src?: string;
  position?: string;
}

export const PANEL_SCENE_CATALOG: readonly PanelScene[] = [
  { id: 'space', label: 'Night sky', set: 'painted', tone: 'night', art: 'space' },
  { id: 'mountains', label: 'Mountains', set: 'painted', tone: 'theme', art: 'mountains' },
  { id: 'forest', label: 'Forest', set: 'painted', tone: 'theme', art: 'forest' },
  { id: 'ocean', label: 'Ocean', set: 'painted', tone: 'theme', art: 'ocean' },
  { id: 'aurora', label: 'Aurora', set: 'painted', tone: 'night', art: 'aurora' },
  { id: 'dunes', label: 'Dunes', set: 'painted', tone: 'theme', art: 'dunes' },
  { id: 'photo-space', label: 'Milky Way', set: 'photo', tone: 'night', src: '/scenes/space.jpg', position: 'center 60%' },
  { id: 'photo-mountains', label: 'Mountains', set: 'photo', tone: 'day', src: '/scenes/mountains.jpg', position: 'center 40%' },
  { id: 'photo-forest', label: 'Forest', set: 'photo', tone: 'day', src: '/scenes/forest.jpg', position: 'center 35%' },
  { id: 'photo-ocean', label: 'Ocean', set: 'photo', tone: 'day', src: '/scenes/ocean.jpg', position: 'center 45%' },
  { id: 'photo-aurora', label: 'Aurora', set: 'photo', tone: 'night', src: '/scenes/aurora.jpg', position: 'center 60%' },
  { id: 'photo-dunes', label: 'Dunes', set: 'photo', tone: 'day', src: '/scenes/dunes.jpg', position: 'center 50%' },
];

const BY_ID = new Map(PANEL_SCENE_CATALOG.map((scene) => [scene.id, scene]));

export function sceneById(id: string | null): PanelScene | null {
  return id === null ? null : BY_ID.get(id) ?? null;
}

/** The scene after `id` in the catalog, wrapping; from none, the first. */
export function nextScene(id: string | null): PanelScene {
  const at = id === null ? -1 : PANEL_SCENE_CATALOG.findIndex((scene) => scene.id === id);
  return PANEL_SCENE_CATALOG[(at + 1) % PANEL_SCENE_CATALOG.length]!;
}

export const PANEL_SCENE_KEY = 'tm8.workspace.panel-scene';

/** The stored scene id, or `null` for none (or a scene that no longer exists). */
export function readPanelScene(): string | null {
  try {
    const raw = window.localStorage.getItem(PANEL_SCENE_KEY);
    return raw !== null && BY_ID.has(raw) ? raw : null;
  } catch {
    return null;
  }
}

const listeners = new Set<() => void>();
let current: string | null | undefined;

export function setPanelScene(id: string | null): void {
  const next = id !== null && BY_ID.has(id) ? id : null;
  try {
    if (next === null) window.localStorage.removeItem(PANEL_SCENE_KEY);
    else window.localStorage.setItem(PANEL_SCENE_KEY, next);
  } catch {
    /* Storage refused (private mode, quota): the choice lasts this page only. */
  }
  current = next;
  for (const fn of listeners) fn();
}

function snapshot(): string | null {
  if (current === undefined) current = readPanelScene();
  return current;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== PANEL_SCENE_KEY && event.key !== null) return;
    current = readPanelScene();
    fn();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener('storage', onStorage);
  };
}

/** The chosen scene's id, or `null` for none. */
export function usePanelScene(): string | null {
  return useSyncExternalStore(subscribe, snapshot, () => null);
}
