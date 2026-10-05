/**
 * The one mutable object the DOM layer (keyboard, HUD) and the scene share.
 * The scene reads it every frame; nothing here is React state, so a keypress
 * never re-renders the page. `order` is a walk request — a point, and the
 * place to arrive at (and maybe open) — stamped with a version so the scene
 * notices a new one.
 */
export interface WalkOrder {
  x: number;
  z: number;
  placeId: string | null;
  open: boolean;
  version: number;
}

/** Places within this walking distance of the player are revealed. Shared by the scene and the minimap. */
export const REVEAL_RADIUS = 12;

/** The player's live pose, written by the scene every frame; samplers (the minimap) read it at their own rate. */
export interface PlayerPose { x: number; z: number; heading: number }

export interface GameControl {
  keys: Set<string>;
  overview: boolean;
  order: WalkOrder | null;
  /** Null until the scene has drawn a frame. */
  player: PlayerPose | null;
}

export function createControl(): GameControl {
  return { keys: new Set(), order: null, overview: false, player: null };
}

let orderVersion = 0;
export function walkTo(control: GameControl, x: number, z: number, placeId: string | null, open = false): void {
  control.overview = false;
  control.order = { x, z, placeId, open, version: ++orderVersion };
}

/** Screen-relative walk directions on the ground plane for the fixed isometric camera. */
const KEY_DIR: Readonly<Record<string, [x: number, z: number]>> = {
  w: [-1, -1], arrowup: [-1, -1],
  s: [1, 1], arrowdown: [1, 1],
  a: [-1, 1], arrowleft: [-1, 1],
  d: [1, -1], arrowright: [1, -1],
};

export const WALK_KEYS: ReadonlySet<string> = new Set(Object.keys(KEY_DIR));

/** Summed, normalised walk direction from the keys down; null when none. */
export function keyDirection(keys: ReadonlySet<string>, out: [number, number] = [0, 0]): [x: number, z: number] | null {
  let x = 0;
  let z = 0;
  for (const k of keys) {
    const d = KEY_DIR[k];
    if (d) { x += d[0]; z += d[1]; }
  }
  const len = Math.hypot(x, z);
  if (len < 1e-6) return null;
  out[0] = x / len; out[1] = z / len;
  return out;
}
