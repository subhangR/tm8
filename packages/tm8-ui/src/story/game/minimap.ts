/**
 * THE MINIMAP'S MATH (task 01a1090f): the world seen from straight above, in
 * a square canvas. Pure — no DOM, no three.js — so the HUD can draw it with a
 * 2D context and tests can check it. The map is turned to match the fixed
 * isometric camera: W walks toward the top of the map, D toward its right,
 * exactly as on screen. Only REVEALED land is drawn; the rest is fog.
 */
import type { StoryTone } from '../model';
import type { Palette } from './palette';
import type { PlaceShape, World } from './world';

/** How far from a place the walk reveals it (mirrors scene.tsx REVEAL_RADIUS; scene.tsx is not imported to keep three.js out of the HUD). */
export const REVEAL_RADIUS = 12;
/** CSS pixel side of the minimap canvas. */
export const MINIMAP_SIZE = 180;
/** CSS pixels kept clear inside the canvas edge. */
export const MINIMAP_PAD = 6;
/** A click within this many CSS pixels of a revealed place walks to the place, not the ground. */
export const PICK_RADIUS = 8;
/** At most this many redraws per second. */
export const MINIMAP_HZ = 10;

export type Pixel = [px: number, py: number];
export type Ground = [x: number, z: number];

const SQRT1_2 = Math.SQRT1_2;
const scaleOf = (extent: number, size: number, pad: number): number => (size / 2 - pad) / Math.max(extent, 1e-6);

/**
 * World ground point → canvas pixel. The island (radius `extent` round the
 * hub) fits the square with `pad` to spare at any rotation. Screen-right is
 * world (1, -1), screen-down is world (1, 1) — the camera's view.
 */
export function project(extent: number, size: number, pad: number = MINIMAP_PAD): (x: number, z: number) => Pixel {
  const s = scaleOf(extent, size, pad), c = size / 2;
  return (x, z) => [c + (x - z) * SQRT1_2 * s, c + (x + z) * SQRT1_2 * s];
}

/** Canvas pixel → world ground point; the inverse of `project`. */
export function unproject(extent: number, size: number, pad: number = MINIMAP_PAD): (px: number, py: number) => Ground {
  const s = scaleOf(extent, size, pad), c = size / 2;
  return (px, py) => {
    const u = (px - c) / s, v = (py - c) / s;
    return [(u + v) * SQRT1_2, (v - u) * SQRT1_2];
  };
}

/** A walk heading (scene convention: atan2(dx, dz), 0 faces +z) as a canvas angle for `ctx.rotate`, 0 = pointing right. */
export function headingAngle(heading: number): number {
  const dx = Math.sin(heading), dz = Math.cos(heading);
  return Math.atan2((dx + dz) * SQRT1_2, (dx - dz) * SQRT1_2);
}

/** The heading of a step from (x0, z0) to (x1, z1), in the scene's convention; null when it did not move. */
export function headingOf(x0: number, z0: number, x1: number, z1: number): number | null {
  const dx = x1 - x0, dz = z1 - z0;
  return Math.hypot(dx, dz) < 1e-3 ? null : Math.atan2(dx, dz);
}

/** Which palette colour a place's dot takes. Mirrors scenery.ts `placeColor` (that one pulls in three.js). */
export function dotColor(place: { tone: StoryTone | null; live: boolean; shape: PlaceShape; encounters: ReadonlyArray<{ phase: string }> }): keyof Palette {
  if (place.tone === 'blocked' || place.encounters.some((e) => e.phase === 'fainted')) return 'block';
  if (place.tone === 'done') return 'wait';
  if (place.live || place.tone === 'working') return 'run';
  return place.shape === 'library' || place.shape === 'crystal' ? 'merged' : 'info';
}

/** How each place shape reads at dot size. Portals are the only hollow ring, so other worlds stand apart. */
export type Glyph = 'hub' | 'square' | 'triangle' | 'diamond' | 'ring' | 'circle';
export const GLYPH_OF_SHAPE: Readonly<Record<PlaceShape, Glyph>> = {
  hub: 'hub', building: 'square', library: 'square', tent: 'triangle', camp: 'triangle',
  signpost: 'diamond', crystal: 'diamond', portal: 'ring', stone: 'circle',
};

export interface MinimapDot {
  id: string;
  title: string;
  px: number;
  py: number;
  shape: PlaceShape;
  glyph: Glyph;
  tone: StoryTone | null;
  color: keyof Palette;
  portal: boolean;
  root: boolean;
  hub: boolean;
  revealed: boolean;
}

export interface MinimapRoad {
  id: string;
  cross: boolean;
  points: Pixel[];
}

/** A district as an annular sector round the hub, in canvas terms (angles already turned for the canvas). */
export interface MinimapDistrict {
  id: string;
  color: keyof Palette;
  cx: number;
  cy: number;
  inner: number;
  outer: number;
  start: number;
  end: number;
}

export interface MinimapFog {
  px: number;
  py: number;
  r: number;
}

export interface MinimapPlayer {
  px: number;
  py: number;
  angle: number;
}

export interface MinimapModel {
  size: number;
  /** World radius the canvas frames (see `mapExtent`). */
  extent: number;
  /** The island's coast circle, usually larger than the canvas. */
  island: MinimapFog;
  dots: MinimapDot[];
  roads: MinimapRoad[];
  districts: MinimapDistrict[];
  /** Circles of clear land; everything outside them is fog. */
  fog: MinimapFog[];
  player: MinimapPlayer;
}

export interface MinimapPlayerInput {
  x: number;
  z: number;
  heading: number;
}

/* ---- districts: a sibling unit (W1) adds `world.districts`; read it without assuming its shape ---- */
const DISTRICT_COLOR: Readonly<Record<string, keyof Palette>> = {
  to_do: 'info', todo: 'info', in_progress: 'run', working: 'run', blocked: 'block', done: 'wait',
};
const num = (o: Record<string, unknown>, ...keys: string[]): number | null => {
  for (const k of keys) if (typeof o[k] === 'number' && Number.isFinite(o[k])) return o[k] as number;
  return null;
};
const str = (o: Record<string, unknown>, ...keys: string[]): string | null => {
  for (const k of keys) if (typeof o[k] === 'string') return o[k] as string;
  return null;
};

/** The minimap turns the world by an eighth: a world angle (atan2(z, x), as layoutWorld lays the ring) plus this is its canvas angle. */
const TURN = Math.PI / 4;

/**
 * The world's districts, if it carries any: each an angular sector from the
 * hub with a status category. Unknown fields are skipped, never guessed.
 */
export function readDistricts(world: World, extent: number, size: number, pad: number = MINIMAP_PAD): MinimapDistrict[] {
  const raw = (world as World & { districts?: unknown }).districts;
  const list = Array.isArray(raw) ? raw : raw instanceof Map ? [...raw.values()] : [];
  const s = scaleOf(extent, size, pad);
  const out: MinimapDistrict[] = [];
  list.forEach((d, i) => {
    if (!d || typeof d !== 'object') return;
    const o = d as Record<string, unknown>;
    const start = num(o, 'startAngle', 'from', 'start', 'a0');
    const end = num(o, 'endAngle', 'to', 'end', 'a1');
    if (start === null || end === null) return;
    const key = str(o, 'statusCategory', 'category', 'status', 'key') ?? '';
    out.push({
      id: str(o, 'id', 'key') ?? `district-${i}`,
      color: DISTRICT_COLOR[key] ?? 'ink3',
      cx: size / 2,
      cy: size / 2,
      inner: Math.max(0, (num(o, 'innerRadius', 'inner', 'r0') ?? 0) * s),
      outer: Math.max(0, (num(o, 'outerRadius', 'outer', 'r1') ?? extent) * s),
      start: start + TURN,
      end: end + TURN,
    });
  });
  return out;
}

/**
 * The radius the minimap frames: the occupied land (every place and road
 * point) plus one reveal radius, never more than the island. The island's
 * own margin is sea and meadow; at 180 px it is better spent on places.
 */
export function mapExtent(world: World): number {
  let far = 0;
  for (const p of world.places) far = Math.max(far, Math.hypot(p.x, p.z));
  for (const r of world.roads) for (const q of r.points) far = Math.max(far, Math.hypot(q.x, q.z));
  return Math.min(world.extent, far + REVEAL_RADIUS);
}

/** Everything the canvas draws, in canvas pixels. */
export function minimapModel(world: World, revealed: ReadonlySet<string>, player: MinimapPlayerInput, size: number = MINIMAP_SIZE, pad: number = MINIMAP_PAD): MinimapModel {
  const extent = mapExtent(world);
  const at = project(extent, size, pad);
  const s = scaleOf(extent, size, pad);
  const dots = world.places.map((p): MinimapDot => {
    const [px, py] = at(p.x, p.z);
    return {
      id: p.id, title: p.title, px, py, shape: p.shape, glyph: GLYPH_OF_SHAPE[p.shape], tone: p.tone, color: dotColor(p),
      portal: p.portal, root: p.root, hub: p.id === world.hubId, revealed: p.id === world.hubId || revealed.has(p.id),
    };
  });
  const roads = world.roads.map((r): MinimapRoad => ({ id: r.id, cross: r.cross, points: r.points.map((q) => at(q.x, q.z)) }));
  const fog = dots.filter((d) => d.revealed).map((d) => ({ px: d.px, py: d.py, r: REVEAL_RADIUS * s }));
  const [ppx, ppy] = at(player.x, player.z);
  fog.push({ px: ppx, py: ppy, r: REVEAL_RADIUS * s });
  return {
    size, extent, dots, roads, fog,
    island: { px: size / 2, py: size / 2, r: world.extent * s },
    districts: readDistricts(world, extent, size, pad),
    player: { px: ppx, py: ppy, angle: headingAngle(player.heading) },
  };
}

/** Is a canvas pixel on clear (revealed) land? */
export function inClearing(model: Pick<MinimapModel, 'fog'>, px: number, py: number): boolean {
  return model.fog.some((f) => Math.hypot(px - f.px, py - f.py) <= f.r);
}

export interface MinimapTarget {
  x: number;
  z: number;
  placeId: string | null;
}

/**
 * Where a click on the minimap sends the player: the revealed place under
 * the pointer, else the ground there if it is revealed land, else nowhere —
 * fog is not a destination.
 */
export function pickTarget(world: World, model: MinimapModel, px: number, py: number, pad: number = MINIMAP_PAD): MinimapTarget | null {
  let best: MinimapDot | null = null, bestD = PICK_RADIUS;
  for (const d of model.dots) {
    if (!d.revealed) continue;
    const dist = Math.hypot(d.px - px, d.py - py);
    if (dist <= bestD) { best = d; bestD = dist; }
  }
  if (best) {
    const p = world.byId.get(best.id);
    if (p) return { x: p.x, z: p.z, placeId: p.id };
  }
  if (!inClearing(model, px, py)) return null;
  const [x, z] = unproject(model.extent, model.size, pad)(px, py);
  return { x, z, placeId: null };
}

/**
 * The cheap part of the redraw check: the player rounded to what a pixel can
 * show, and the canvas resolution. The world, the revealed set and the palette
 * are compared by reference beside it (each is memoised upstream).
 */
export function minimapSignature(player: MinimapPlayerInput, size: number, dpr: number): string {
  return `${player.x.toFixed(1)}|${player.z.toFixed(1)}|${player.heading.toFixed(2)}|${size}|${dpr}`;
}
