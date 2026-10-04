/** Procedural toy architecture. Deterministic parts, instanced by geometry in scene-batch. */
import { Color } from 'three';
import type { Palette } from './palette';
import type { KitSolid } from './assets/geometry';
import { doorstep, type Place, type World } from './world';
import { ROAD_WIDTH, ROAD_SHOULDER, segmentDistance, distance } from './roads';

/** The geometry vocabulary lives with the asset kit (assets/geometry.ts). */
export type Solid = KitSolid;
export interface Part {
  geo: Solid; x: number; y: number; z: number; sx: number; sy: number; sz: number;
  color: string; ry: number; rz: number; rx: number; motion: number; placeId: string | null;
}
export function seedOf(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}
export const tint = (a: string, b: string, amount: number): string => new Color(a).lerp(new Color(b), amount).getStyle();
export const daylightColor = (p: Palette): string => new Color(p.card).getHSL({ h: 0, s: 0, l: 0 }).l > .5 ? p.card : p.ink;
export function landscapeColors(p: Palette) {
  const light = daylightColor(p);
  return {
    grass: tint(p.run, p.wait, .27), leaf: tint(p.run, p.info, .28), leafLight: tint(p.run, light, .23),
    sea: tint(p.info, p.run, .22), shallows: tint(p.info, p.card, .4),
    sand: tint(p.wait, light, .62), stone: tint(p.brand, light, .64),
    wood: tint(p.brand, p.ink, .35), cream: tint(light, p.wait, .12),
    roof: tint(p.info, p.run, .35), gold: tint(p.wait, p.card, .13),
  };
}
export function placeColor(place: Place, p: Palette): string {
  if (place.tone === 'blocked' || place.encounters.some((e) => e.phase === 'fainted')) return p.block;
  if (place.tone === 'done') return p.wait;
  if (place.live || place.tone === 'working') return p.run;
  return place.shape === 'library' || place.shape === 'crystal' ? p.merged : p.info;
}

export function makeScenery(world: World, p: Palette): Part[] {
  const parts: Part[] = [], c = landscapeColors(p);
  let ox = 0, oz = 0, size = 1, placeId: string | null = null;
  const part = (geo: Solid, x: number, y: number, z: number, sx: number, sy: number, sz: number, color: string, ry = 0, motion = 0, rz = 0, rx = 0) => {
    parts.push({ geo, x: ox + x * size, y: y * size, z: oz + z * size, sx: sx * size, sy: sy * size, sz: sz * size, color, ry, rz, rx, motion, placeId });
  };
  const lantern = (x: number, z: number, color = c.gold) => {
    part('cylinder', x, .58, z, .065, 1.16, .065, c.wood);
    part('box', x, 1.17, z, .24, .29, .24, color, 0, 3);
    part('cone', x, 1.39, z, .24, .16, .24, c.wood);
  };
  // Continuous pale lanes with stone shoulders; dependency edges become timber
  // bridges. Geometry follows the same clear route that the player walks.
  let lamps = 0, cobbles = 0;
  const shoulder = tint(c.sand, c.wood, .36), lane = tint(c.sand, c.wood, .12);
  for (const road of world.roads) {
    const a = world.byId.get(road.fromId)!, b = world.byId.get(road.toId)!;
    const bridge = road.family === 'blocks';
    const status = a.tone === 'blocked' || b.tone === 'blocked' ? p.block : c.wood;
    let travelled = 0;
    for (let j = 1; j < road.points.length; j++) {
      const from = road.points[j - 1]!, to = road.points[j]!;
      const len = distance(from, to), yaw = Math.atan2(to.x - from.x, to.z - from.z);
      const steps = bridge ? Math.max(1, Math.ceil(len / Math.max(.8, road.length / 28))) : 1;
      for (let i = 0; i < steps; i++) {
        const t = (i + .5) / steps, x = from.x + (to.x - from.x) * t, z = from.z + (to.z - from.z) * t;
        const height = bridge ? .1 + Math.sin((travelled + t * len) / road.length * Math.PI) * .32 : .045;
        const span = len / steps + .045;
        part(bridge ? 'box' : 'paving', x, height, z, ROAD_WIDTH + ROAD_SHOULDER * 2, .085, span, bridge ? c.wood : shoulder, yaw);
        part(bridge ? 'box' : 'paving', x, height + .049, z, ROAD_WIDTH, .035, span, bridge ? tint(c.wood, c.sand, .28 + (i % 2) * .08) : lane, yaw);
        if (bridge) for (const side of [-1, 1]) {
          const px = x + Math.cos(yaw) * .83 * side, pz = z - Math.sin(yaw) * .83 * side;
          part('box', px, height + .55, pz, .065, .065, span, status, yaw);
          if (i % 3 === 0) part('cylinder', px, height + .28, pz, .055, .76, .055, status);
        }
      }
      if (!bridge && j < road.points.length - 1) for (const point of [to]) {
        part('disc', point.x, .045, point.z, ROAD_WIDTH / 2 + ROAD_SHOULDER, .085, ROAD_WIDTH / 2 + ROAD_SHOULDER, shoulder);
        part('disc', point.x, .094, point.z, ROAD_WIDTH / 2, .035, ROAD_WIDTH / 2, lane);
      }
      // Sparse inset stones and lanterns have a world-wide decoration budget.
      const stones = Math.min(18, Math.floor(len / 1.8));
      for (let i = 1; i <= stones && cobbles < 1800; i++, cobbles++) {
        const t = i / (stones + 1), x = from.x + (to.x - from.x) * t, z = from.z + (to.z - from.z) * t;
        if (!bridge) part('box', x, .118, z, .39, .018, .27, tint(lane, c.cream, .15 + i % 3 * .08), yaw + .12 * Math.sin(i));
        const lx = x + Math.cos(yaw) * 1.14, lz = z - Math.sin(yaw) * 1.14;
        if (i % 8 === 0 && lamps < 120 && world.places.every((q) => Math.hypot(q.x - lx, q.z - lz) > q.footprint + .4)) { lantern(lx, lz); lamps++; }
      }
      travelled += len;
    }
  }
  // Shared entrance aprons make branching graph edges meet visibly at each place.
  for (const place of world.places) {
    const end = doorstep(place);
    part('cylinder', end.x, .06, end.z, 1.05, .1, 1.05, shoulder);
    part('cylinder', end.x, .12, end.z, .88, .04, .88, lane);
    part('box', place.x, .065, place.z + place.footprint, .85, .1, 1.8, lane);
  }
  for (const place of world.places) {
    ox = place.x; oz = place.z; size = place.root ? 1.18 : 1; placeId = place.id;
    const accent = placeColor(place, p);
    const roof = place.tone === 'blocked' ? tint(p.block, p.ink, .45) : place.tone === 'done' ? c.gold : c.roof;
    const wall = place.tone === 'blocked' ? tint(c.stone, p.ink, .45) : c.cream;
    part('cylinder', 0, .1, 0, 1.08, .2, 1.08, c.stone);
    part('cylinder', 0, .23, 0, .95, .13, .95, c.sand);
    const door = (z = .61) => {
      part('box', 0, .65, z, .34, .65, .09, c.wood);
      part('orb', .09, .6, z + .065, .035, .035, .025, c.gold);
      part('box', 0, .29, z + .18, .57, .13, .35, c.stone);
    };
    const flag = (x: number, y: number, z: number) => {
      part('cylinder', x, y, z, .035, 1.02, .035, c.wood);
      part('box', x + .2, y + .29, z, .4, .25, .045, accent, 0, 1);
    };
    switch (place.shape) {
      case 'hub':
        part('cylinder', 0, .22, 0, 1.85, .36, 1.85, c.stone);
        part('cylinder', 0, .43, 0, 1.56, .12, 1.56, c.gold);
        part('cylinder', 0, 1.1, 0, .9, 1.4, .9, wall);
        for (let i = 0; i < 6; i++) {
          const a = i * Math.PI / 3;
          part('cylinder', Math.sin(a) * 1.05, 1.2, Math.cos(a) * 1.05, .12, 1.6, .12, c.stone);
          part('orb', Math.sin(a) * 1.05, 2.05, Math.cos(a) * 1.05, .16, .16, .16, c.gold);
        }
        part('cone', 0, 2.04, 0, 1.35, .8, 1.35, c.roof);
        part('cylinder', 0, 2.57, 0, .4, .48, .4, c.cream);
        part('cone', 0, 3.02, 0, .62, .48, .62, c.roof);
        part('gem', 0, 3.65, 0, .37, .61, .37, c.gold, 0, 2);
        part('ring', 0, 3.65, 0, .75, .75, .75, c.gold, 0, 2, .4);
        door(.93);
        lantern(-1.35, 1.05); lantern(1.35, 1.05);
        break;
      case 'building': {
        const height = 1.1 + (place.progress ?? .3) * .55;
        part('box', 0, .35 + height / 2, 0, 1.17, height, 1.05, wall);
        part('box', 0, .48, 0, 1.26, .15, 1.14, c.stone);
        part('cone', 0, .65 + height, 0, 1.03, .8, .96, roof, Math.PI / 4);
        part('box', -.33, .98, .535, .22, .3, .07, accent, 0, place.live ? 3 : 0);
        part('box', .34, .98, .535, .22, .3, .07, accent, 0, place.live ? 3 : 0);
        part('box', -.38, height + .79, -.15, .21, .5, .23, c.wood);
        if (place.live || place.tone === 'working') for (let i = 0; i < 3; i++) part('orb', -.38 + i * .08, height + 1.08 + i * .23, -.15, .16 + i * .04, .15, .16, p.card, 0, 4);
        door(.56); flag(.73, 1.4, -.4);
        if (place.tone === 'blocked') for (const r of [-.6, .6]) part('box', 0, .64, .66, .68, .07, .08, p.block, 0, 0, r);
        break;
      }
      case 'tent':
        part('cylinder', 0, .45, 0, .84, .36, .84, wall);
        part('cone', 0, 1.15, 0, 1.08, 1.25, 1.08, roof, Math.PI / 4);
        part('box', 0, .63, .67, .5, .7, .07, c.wood);
        part('cone', 0, .82, .78, .39, .8, .15, accent, 0);
        flag(0, 2.02, 0); lantern(.88, .54, accent);
        break;
      case 'library':
        part('box', 0, .9, 0, 1.4, 1.14, .9, wall);
        part('cone', 0, 1.79, 0, 1.2, .64, .92, p.merged, Math.PI / 4);
        for (const x of [-.52, .52]) {
          part('cylinder', x, .88, .61, .1, 1.18, .1, c.stone);
          part('box', x * .65, 1.09, .48, .25, .38, .035, c.gold);
        }
        part('box', 0, 1.46, .66, 1.45, .15, .3, c.gold);
        door(.53); part('box', -.33, 1.82, .56, .37, .48, .12, c.cream, 0, 0, -.25);
        part('box', .03, 1.82, .56, .37, .48, .12, c.cream, 0, 0, .25);
        break;
      case 'portal':
        for (const x of [-.83, .83]) {
          part('box', x, 1.32, 0, .39, 2.1, .47, c.stone);
          part('cone', x, 2.56, 0, .45, .55, .45, roof, Math.PI / 4);
        }
        part('ring', 0, 1.47, 0, .9, 1.12, .4, p.merged);
        part('gem', 0, 1.48, 0, .42, .65, .15, p.brand, 0, 2);
        part('box', 0, 2.25, 0, 1.6, .26, .42, c.gold);
        break;
      case 'crystal':
        for (let i = 0; i < 5; i++) {
          const a = i * 2.4;
          part('gem', Math.cos(a) * .46, .72 + (i % 2) * .25, Math.sin(a) * .46, .25, .64, .25, i % 2 ? p.merged : p.info, a, 2);
        }
        part('ring', 0, .37, 0, .8, .8, .8, c.gold, 0, 0, 0, Math.PI / 2);
        break;
      case 'camp':
        part('cone', -.3, .88, 0, .8, 1.25, .8, p.wait, Math.PI / 4);
        part('box', -.3, .55, .53, .36, .45, .07, c.wood);
        part('cylinder', .6, .4, .4, .28, .13, .28, c.wood);
        part('gem', .6, .65, .4, .17, .34, .17, c.gold, 0, 3);
        flag(.55, 1.2, -.5);
        break;
      case 'factory': // PLACEHOLDER (story map W1): the Code Factory wears the signpost until the asset lane registers its look.
      case 'signpost':
        part('cylinder', 0, 1.12, 0, .09, 1.65, .09, c.wood);
        part('box', .12, 1.68, 0, 1.1, .32, .14, p.info, 0, 0, -.1);
        part('box', -.13, 1.19, 0, .88, .25, .14, c.gold, 0, 0, .1);
        part('box', 0, .42, 0, .5, .18, .5, c.stone);
        break;
      case 'stone':
        part('orb', 0, .67, 0, .62, .49, .55, c.stone);
        part('gem', 0, 1.16, 0, .18, .24, .18, accent, 0, 2);
    }
    if (place.progress !== null) {
      for (let i = 0; i < 12; i++) {
        const a = i * Math.PI / 6, completed = i / 12 < place.progress;
        part('box', Math.sin(a) * 1.22, .13, Math.cos(a) * 1.22, .25, completed ? .18 : .07, .17, completed ? c.gold : c.stone, a);
      }
    }
    if (place.shape !== 'hub') lantern(-.95, .6, accent);
  }
  // Scatter derives from IDs, never runtime/status; roads and doorways stay clear.
  placeId = null; size = 1; ox = 0; oz = 0;
  const clear = (x: number, z: number): boolean => {
    if (world.places.some((q) => Math.hypot(x - q.x, z - q.z) < q.footprint + 1.6 || Math.hypot(x - doorstep(q).x, z - doorstep(q).z) < 2)) return false;
    return !world.roads.some((road) => road.points.slice(1).some((b, i) => segmentDistance({ x, z }, road.points[i]!, b) < ROAD_WIDTH / 2 + 1.4));
  };
  // At most 900 scatter candidates, spread over all entities (never per square metre).
  for (let candidate = 0; candidate < Math.min(900, world.places.length * 10); candidate++) {
    const place = world.places[candidate % world.places.length]!, i = Math.floor(candidate / world.places.length);
    const seed = seedOf(`${place.id}/${i}`), a = seed * Math.PI * 2;
    const d = 3.5 + seedOf(`${i}/${place.id}`) * 3.5;
    const x = place.x + Math.cos(a) * d, z = place.z + Math.sin(a) * d;
    if (Math.hypot(x, z) > world.extent - 1 || !clear(x, z)) continue;
    if (i < 3) {
      const s = .75 + seed * .5;
      part('cylinder', x, .7 * s, z, .14 * s, 1.4 * s, .14 * s, c.wood);
      if (i === 0) {
        part('cone', x, 1.2 * s, z, .85 * s, 1.6 * s, .85 * s, c.leaf, a, 1);
        part('cone', x, 1.95 * s, z, .6 * s, 1.3 * s, .6 * s, c.leafLight, a, 1);
      } else {
        part('orb', x, 1.75 * s, z, .95 * s, .96 * s, .85 * s, c.leaf, a, 1);
        part('orb', x - .35, 2.12 * s, z + .13, .66 * s, .67 * s, .63 * s, c.leafLight, a, 1);
      }
    } else if (i < 5) part('orb', x, .14, z, .36, .28, .28, c.stone, a);
    else for (let j = 0; j < 3; j++) {
      part('cone', x + j * .13, .16, z + Math.sin(j) * .15, .09, .38 + seed * .2, .08, c.leafLight, a, 1);
      if (i % 2 === 0) part('orb', x + j * .13, .42, z + Math.sin(j) * .15, .075, .07, .075, i % 3 ? c.cream : p.brand, 0, 1);
    }
  }
  // A broken rocky coastline and satellite islets give the toy world a horizon.
  for (let i = 0; i < 72; i++) {
    const a = i * Math.PI * 2 / 72, r = world.extent * (1 + .023 * Math.sin(a * 5) + .018 * Math.cos(a * 9));
    const s = .35 + seedOf(`${world.storyId}/coast/${i}`) * .7;
    part('orb', Math.cos(a) * r, -.5, Math.sin(a) * r, s, .46, s * .8, i % 3 ? c.stone : c.sand, a);
  }
  for (let i = 0; i < 5; i++) {
    const a = i * 1.7 + .5, r = world.extent + 5 + i % 2 * 2;
    const x = Math.cos(a) * r, z = Math.sin(a) * r;
    part('orb', x, -1, z, 2.2, 1.1, 1.7, c.stone, a);
    part('orb', x, -.3, z, 1.95, .44, 1.5, c.grass, a);
    part('cylinder', x, .56, z, .15, 1.3, .15, c.wood);
    part('cone', x, 1.25, z, 1, 1.75, 1, c.leaf, a, 1);
    part('cone', x, 2, z, .7, 1.3, .7, c.leafLight, a, 1);
  }
  return parts;
}
