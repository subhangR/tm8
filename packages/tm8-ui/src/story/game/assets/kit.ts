/**
 * THE FOUNDATIONAL KIT — reusable building blocks every asset is composed of.
 *
 * Blocks write `Part`s (the same record scene-batch instances), so a whole
 * map of mixed assets stays one draw call per solid. Every block takes a `Kit`
 * already translated to where the block stands; blocks never rotate the whole
 * asset (doors face +Z, the map's entrance side). Colours come only from the
 * runtime palette through `materialsOf` — no literals.
 *
 * Motion codes are the batch shader's: 0 still, 1 sway, 2 bob, 3 glow, 4 rise
 * (smoke). Reduced motion damps all of them in the shader.
 */
import type { Palette } from '../palette';
import type { Part } from '../scenery';
import { tint, landscapeColors } from '../scenery';
import type { KitSolid } from './geometry';
import type { AssetState, SocketName } from './registry';

export const MOTION = { still: 0, sway: 1, bob: 2, glow: 3, rise: 4 } as const;
export type Motion = (typeof MOTION)[keyof typeof MOTION];

export interface PartOptions { ry?: number; rx?: number; rz?: number; motion?: Motion }
export interface Point3 { x: number; y: number; z: number }

/** A translated, uniformly scaled view onto one shared part list. */
export class Kit {
  constructor(
    readonly parts: Part[] = [],
    readonly ox = 0, readonly oy = 0, readonly oz = 0,
    readonly s = 1,
    readonly placeId: string | null = null,
    /** When set, every part takes this colour (silhouette audits). */
    readonly flat: string | null = null,
  ) {}
  part(geo: KitSolid, x: number, y: number, z: number, sx: number, sy: number, sz: number, color: string, o: PartOptions = {}): this {
    const s = this.s;
    this.parts.push({
      geo, x: this.ox + x * s, y: this.oy + y * s, z: this.oz + z * s, sx: sx * s, sy: sy * s, sz: sz * s,
      color: this.flat ?? color, ry: o.ry ?? 0, rx: o.rx ?? 0, rz: o.rz ?? 0, motion: o.motion ?? 0, placeId: this.placeId,
    });
    return this;
  }
  /** A child kit at a local offset (and optional extra scale) writing into the same list. */
  at(x: number, y: number, z: number, scale = 1): Kit {
    return new Kit(this.parts, this.ox + x * this.s, this.oy + y * this.s, this.oz + z * this.s, this.s * scale, this.placeId, this.flat);
  }
  /** World position of a local point — for sockets. */
  point(x: number, y: number, z: number): Point3 {
    return { x: this.ox + x * this.s, y: this.oy + y * this.s, z: this.oz + z * this.s };
  }
}

/* ---- the material vocabulary: twelve swatches, all palette-derived ---- */
export interface Materials {
  stone: string; stoneDark: string; plaster: string; timber: string; wood: string;
  roof: string; slate: string; metal: string; metalDark: string; glass: string; paper: string;
  gold: string; brick: string; leaf: string; ink: string; card: string;
  /** Status tones, for lamps, gems, flags. */
  run: string; wait: string; block: string; info: string; merged: string; brand: string; muted: string;
}

export function materialsOf(p: Palette): Materials {
  const c = landscapeColors(p);
  return {
    stone: c.stone, stoneDark: tint(c.stone, p.ink, .32), plaster: c.cream, timber: tint(c.wood, p.ink, .25), wood: c.wood,
    roof: c.roof, slate: tint(p.info, p.ink, .45), metal: tint(p.ink3, p.card, .35), metalDark: tint(p.ink3, p.ink, .45),
    glass: tint(p.info, p.card, .55), paper: tint(p.card, p.wait, .06), gold: c.gold, brick: tint(p.brand, p.block, .35),
    leaf: c.leaf, ink: p.ink, card: p.card,
    run: p.run, wait: p.wait, block: p.block, info: p.info, merged: p.merged, brand: p.brand, muted: tint(p.ink3, p.card, .15),
  };
}

/** The one status → tone rule every lamp, flag and gem uses. */
export function toneOfState(m: Materials, state: AssetState): string {
  switch (state) {
    case 'working': return m.run;
    case 'waiting': return m.wait;
    case 'blocked': return m.block;
    case 'done': return m.gold;
    case 'cancelled': return m.muted;
    case 'planned': return m.info;
  }
}

/* ------------------------------------------------------------------------- */
/* FOUNDATIONS                                                               */
/* ------------------------------------------------------------------------- */
/** Two-tier round plinth: towers, monuments, the hub. */
export function roundPlinth(k: Kit, m: Materials, r = 1.05): void {
  k.part('cylinder', 0, .1, 0, r, .2, r, m.stone).part('cylinder', 0, .23, 0, r * .88, .1, r * .88, m.stoneDark);
}
/** Square stone footing with a front step: houses and halls. */
export function squareFooting(k: Kit, m: Materials, w = 1.5, d = 1.4): void {
  k.part('box', 0, .11, 0, w, .22, d, m.stone).part('box', 0, .06, d / 2 + .14, .6, .12, .3, m.stoneDark);
}
/** Low flat slab: works yards, booths. */
export function slab(k: Kit, m: Materials, w: number, d: number, color = m.stoneDark): void {
  k.part('box', 0, .06, 0, w, .12, d, color);
}

/* ------------------------------------------------------------------------- */
/* WALLS, ROOFS, OPENINGS                                                     */
/* ------------------------------------------------------------------------- */
/** Plaster box with timber corner posts and a mid beam — the half-timber look. */
export function timberWalls(k: Kit, m: Materials, w: number, h: number, d: number, plaster = m.plaster, fullHeight = h): void {
  k.part('box', 0, h / 2, 0, w, h, d, plaster);
  for (const x of [-1, 1]) for (const z of [-1, 1]) k.part('box', x * (w / 2 - .02), fullHeight / 2, z * (d / 2 - .02), .1, fullHeight, .1, m.timber);
  if (h >= fullHeight * .9) k.part('box', 0, h * .62, 0, w + .05, .07, d + .05, m.timber);
}
/** Gable roof whose triangular end faces the door (+Z). */
export function gableRoof(k: Kit, color: string, w: number, h: number, d: number): void {
  k.part('prism', 0, h / 2, 0, d, h, w, color, { ry: Math.PI / 2 });
}
/** Gable roof whose ridge runs left–right (a pediment or side-on hall). */
export function ridgeRoof(k: Kit, color: string, w: number, h: number, d: number): void {
  k.part('prism', 0, h / 2, 0, w, h, d, color);
}
/** Single-slope roof for lean-tos and sheds. */
export function shedRoof(k: Kit, color: string, w: number, d: number, tilt = .3): void {
  k.part('box', 0, 0, 0, w, .07, d, color, { rx: tilt });
}
/** Door with knob and a small arch over it. `z` is the wall face. */
export function door(k: Kit, m: Materials, z: number, w = .32, h = .56, color = m.wood): void {
  k.part('box', 0, h / 2, z + .02, w, h, .06, color)
    .part('orb', w * .28, h * .48, z + .06, .03, .03, .02, m.gold)
    .part('arch', 0, h, z + .02, w * .56, w * .5, .5, m.timber);
}
/** Window pane; glows when lit. */
export function windowPane(k: Kit, m: Materials, x: number, y: number, z: number, lit: boolean, w = .22, h = .24): void {
  k.part('box', x, y, z, w + .06, h + .06, .04, m.timber).part('box', x, y, z + .02, w, h, .04, lit ? m.wait : m.glass, { motion: lit ? MOTION.glow : MOTION.still });
}
/** Closed shutters over a window. */
export function shutters(k: Kit, color: string, x: number, y: number, z: number, w = .22, h = .24): void {
  k.part('box', x - w / 4, y, z + .05, w / 2, h + .04, .04, color).part('box', x + w / 4, y, z + .05, w / 2, h + .04, .04, color);
}
/** Ring of merlons around a round top. */
export function crenellations(k: Kit, color: string, r: number, count = 8, size = .2): void {
  for (let i = 0; i < count; i++) {
    const a = i * Math.PI * 2 / count;
    k.part('box', Math.sin(a) * r, size / 2, Math.cos(a) * r, size, size, size * .8, color, { ry: a });
  }
}
/** Round tower with a spire roof. */
export function turret(k: Kit, m: Materials, r: number, h: number, roof: string): void {
  k.part('cylinder', 0, h / 2, 0, r, h, r, m.plaster)
    .part('cylinder', 0, h + .04, 0, r * 1.12, .08, r * 1.12, m.stone)
    .part('spire', 0, h + .08 + r * .9, 0, r * 1.2, r * 1.8, r * 1.2, roof);
}
export function chimney(k: Kit, m: Materials, h: number, smoking: boolean): void {
  k.part('box', 0, h / 2, 0, .2, h, .2, m.brick).part('box', 0, h, 0, .26, .06, .26, m.stoneDark);
  if (smoking) for (let i = 0; i < 3; i++) k.part('orb', .02 * i, h + .25 + i * .22, 0, .12 + i * .04, .11 + i * .03, .12 + i * .04, m.card, { motion: MOTION.rise });
}

/* ------------------------------------------------------------------------- */
/* SIGNS, FLAGS, BADGES                                                       */
/* ------------------------------------------------------------------------- */
/** A plank on two posts — where the in-game nameplate hangs. */
export function nameplate(k: Kit, m: Materials, w = .9): void {
  for (const x of [-1, 1]) k.part('cylinder', x * w * .42, .3, 0, .035, .6, .035, m.timber);
  k.part('box', 0, .5, 0, w, .24, .05, m.wood).part('box', 0, .5, .03, w * .86, .16, .02, m.paper);
}
/** Swinging shop sign on a bracket with a checkbox glyph (the task's own mark). */
export function checkboxSign(k: Kit, m: Materials, tone: string, checked: boolean): void {
  k.part('box', 0, .22, 0, .05, .05, .32, m.timber)
    .part('box', 0, 0, .14, .34, .28, .04, m.wood, { motion: MOTION.sway })
    .part('box', 0, 0, .165, .17, .17, .02, m.paper, { motion: MOTION.sway });
  if (checked) k.part('box', -.03, -.02, .18, .045, .08, .02, tone, { rz: .7 }).part('box', .03, .01, .18, .045, .14, .02, tone, { rz: -.6 });
}
/** Pole with a rectangular flag (or a long swallowtail pennant). */
export function flag(k: Kit, m: Materials, color: string, h = 1, swallow = false, furled = false): void {
  k.part('cylinder', 0, h / 2, 0, .03, h, .03, m.timber).part('orb', 0, h + .03, 0, .05, .05, .05, m.gold);
  if (furled) { k.part('cylinder', .03, h - .3, 0, .05, .4, .05, color); return; }
  if (!swallow) { k.part('box', .2, h - .17, 0, .38, .24, .03, color, { motion: MOTION.sway }); return; }
  k.part('box', .3, h - .12, 0, .58, .13, .03, color, { motion: MOTION.sway })
    .part('box', .28, h - .26, 0, .52, .1, .03, color, { motion: MOTION.sway, rz: -.12 });
}
/**
 * Count badge — a medallion with up to five pips; six or more adds a star.
 * The exact number is an HTML label at the `badge` socket; the pips make
 * "none / a few / many" readable at overview scale without text.
 */
export function countBadge(k: Kit, m: Materials, count: number, tone: string): void {
  if (count <= 0) return;
  k.part('cylinder', 0, 0, 0, .19, .05, .19, m.paper, { rx: Math.PI / 2 }).part('ring', 0, 0, .03, .19, .19, .5, tone);
  const pips = Math.min(5, count);
  for (let i = 0; i < pips; i++) {
    const a = (i - (pips - 1) / 2) * .55;
    k.part('orb', Math.sin(a) * .09, Math.cos(a) * .09 - .04, .04, .035, .035, .02, tone);
  }
  if (count > 5) k.part('gem', 0, .27, 0, .09, .11, .05, m.gold, { motion: MOTION.bob });
}
export function lantern(k: Kit, m: Materials, color = m.gold): void {
  k.part('cylinder', 0, .5, 0, .05, 1, .05, m.timber).part('box', 0, 1.02, 0, .2, .24, .2, color, { motion: MOTION.glow }).part('cone', 0, 1.2, 0, .2, .14, .2, m.timber, { ry: Math.PI / 4 });
}
/** Progress ring of twelve stones (hubs and containers). */
export function progressRing(k: Kit, m: Materials, progress: number, r = 1.25): void {
  for (let i = 0; i < 12; i++) {
    const a = i * Math.PI / 6, done = i / 12 < progress;
    k.part('box', Math.sin(a) * r, .1, Math.cos(a) * r, .24, done ? .18 : .07, .16, done ? m.gold : m.stone, { ry: a });
  }
}

/* ------------------------------------------------------------------------- */
/* STATE MODIFIERS — reusable on any type                                     */
/* ------------------------------------------------------------------------- */
/** Scaffold poles and planks around a w×d footprint up to height h. */
export function scaffold(k: Kit, m: Materials, w: number, h: number, d: number): void {
  for (const x of [-1, 1]) for (const z of [-1, 1]) k.part('cylinder', x * (w / 2 + .12), h / 2, z * (d / 2 + .12), .03, h, .03, m.wood);
  for (const y of [h * .45, h * .9]) {
    k.part('box', 0, y, d / 2 + .12, w + .3, .04, .14, m.wood).part('box', w / 2 + .12, y, 0, .14, .04, d + .3, m.wood);
  }
}
/** Two boards crossed over an opening. */
export function boards(k: Kit, color: string, w = .5, y = .3): void {
  k.part('box', 0, y, 0, w, .07, .05, color, { rz: .6 }).part('box', 0, y, .01, w, .07, .05, color, { rz: -.6 });
}
/** Saw-horse barrier. */
export function barrier(k: Kit, m: Materials, tone: string, w = .7): void {
  for (const x of [-1, 1]) k.part('box', x * w * .42, .18, 0, .05, .36, .22, m.wood);
  k.part('box', 0, .32, 0, w, .1, .05, tone).part('box', 0, .32, .03, w * .25, .1, .02, m.card);
}
/** Hourglass on a short post. */
export function hourglass(k: Kit, m: Materials, tone: string): void {
  k.part('cylinder', 0, .25, 0, .03, .5, .03, m.timber).part('box', 0, .52, 0, .2, .03, .12, m.wood)
    .part('cone', 0, .62, 0, .08, .16, .08, tone, { rx: Math.PI }).part('cone', 0, .78, 0, .08, .16, .08, tone)
    .part('box', 0, .87, 0, .2, .03, .12, m.wood);
}
/** Gold star finial — the universal "done" crown. */
export function finial(k: Kit, m: Materials, size = 1): void {
  k.part('cylinder', 0, .1 * size, 0, .03 * size, .2 * size, .03 * size, m.gold).part('gem', 0, .3 * size, 0, .12 * size, .18 * size, .12 * size, m.gold, { motion: MOTION.bob });
}
export function crate(k: Kit, m: Materials, s = .4, color = m.wood): void {
  k.part('box', 0, s / 2, 0, s, s, s, color)
    .part('box', 0, s / 2, s / 2 + .005, s * 1.02, s * .14, .02, m.timber)
    .part('box', 0, s / 2, 0, s * 1.02, s * 1.02, s * .14, m.timber);
}
export function flowerBox(k: Kit, m: Materials, w = .3): void {
  k.part('box', 0, 0, 0, w, .08, .1, m.wood);
  for (let i = 0; i < 3; i++) k.part('orb', (i - 1) * w * .3, .07, 0, .05, .05, .05, i % 2 ? m.brand : m.wait);
}

/* ------------------------------------------------------------------------- */
/* KNOWLEDGE PROPS                                                            */
/* ------------------------------------------------------------------------- */
/** Open book (two pages + spine), standing tilted towards the viewer. */
export function openBook(k: Kit, m: Materials, scale = 1, written = true, ribbon = m.gold): void {
  const b = k.at(0, 0, 0, scale);
  b.part('box', 0, 0, -.02, .08, .62, .06, m.timber, { rx: -.35 });
  for (const x of [-1, 1]) {
    b.part('box', x * .23, 0, 0, .44, .6, .05, m.paper, { rx: -.35, ry: x * .22 });
    if (written) for (let i = 0; i < 3; i++) b.part('box', x * .23, .15 - i * .12, .04 - (.15 - i * .12) * .36, .3, .03, .02, m.metalDark, { rx: -.35, ry: x * .22 });
  }
  b.part('box', 0, -.32, .13, .05, .2, .02, ribbon, { rx: -.35 });
}
/** Row of book spines on a shelf — the contained form of documents. */
export function bookRow(k: Kit, m: Materials, count: number, width: number, seed = 0): void {
  const tones = [m.brand, m.info, m.merged, m.run, m.wait, m.slate];
  const n = Math.min(count, Math.floor(width / .07));
  for (let i = 0; i < n; i++) {
    const h = .17 + ((i * 7 + seed) % 5) * .018;
    k.part('box', -width / 2 + .04 + i * .07, h / 2, 0, .055, h, .16, tones[(i + seed) % tones.length]!, { rz: i === n - 1 && n > 3 ? -.25 : 0 });
  }
}
/** Glass case on a column with an exhibit. */
export function displayCase(k: Kit, m: Materials, exhibit: string | null, scale = 1): void {
  const c = k.at(0, 0, 0, scale);
  c.part('cylinder', 0, .4, 0, .2, .8, .2, m.stone).part('box', 0, .83, 0, .55, .06, .55, m.gold)
    .part('box', 0, 1.15, 0, .5, .6, .5, m.glass).part('box', 0, 1.48, 0, .58, .06, .58, m.gold)
    .part('spire', 0, 1.6, 0, .12, .18, .12, m.gold);
  if (exhibit) c.part('gem', 0, 1.15, .27, .13, .2, .02, exhibit, { motion: MOTION.bob });
}
/** Tripod easel with a canvas. */
export function easel(k: Kit, m: Materials, painted: boolean, scale = 1): void {
  const e = k.at(0, 0, 0, scale);
  e.part('box', -.25, .6, 0, .05, 1.3, .05, m.wood, { rz: -.16 }).part('box', .25, .6, 0, .05, 1.3, .05, m.wood, { rz: .16 })
    .part('box', 0, .55, -.25, .05, 1.2, .05, m.wood, { rx: -.35 })
    .part('box', 0, .62, .05, .7, .05, .08, m.wood)
    .part('box', 0, 1.0, .06, .72, .62, .05, m.card, { rx: -.12 });
  if (painted) {
    e.part('box', -.1, 1.08, .1, .36, .07, .02, m.info, { rx: -.12, rz: .3 })
      .part('box', .12, .94, .095, .28, .07, .02, m.brand, { rx: -.12, rz: -.4 })
      .part('orb', .16, 1.14, .1, .07, .07, .02, m.wait);
  }
}

/* ------------------------------------------------------------------------- */
/* CODE PROPS                                                                 */
/* ------------------------------------------------------------------------- */
export function gear(k: Kit, m: Materials, r = .35, color = m.metal): void {
  k.part('cylinder', 0, 0, 0, r * .78, .08, r * .78, color, { rx: Math.PI / 2 }).part('orb', 0, 0, .05, r * .25, r * .25, .05, m.metalDark);
  for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4;
    k.part('box', Math.sin(a) * r * .86, Math.cos(a) * r * .86, 0, r * .3, r * .3, .08, color, { rz: -a });
  }
}
/** Commit = a node on a line. */
export function commitStone(k: Kit, m: Materials, tone = m.info, scale = 1): void {
  const c = k.at(0, 0, 0, scale);
  c.part('box', 0, .2, 0, .36, .4, .22, m.stone).part('cylinder', 0, .4, 0, .18, .22, .18, m.stone, { rx: Math.PI / 2 })
    .part('box', 0, .28, .12, .5, .04, .02, m.metalDark)
    .part('ring', 0, .28, .125, .08, .08, 1, tone);
}
/** Branch post: a pole forking into two arms — worktrees and branches. */
export function branchPost(k: Kit, m: Materials, lit: boolean, scale = 1): void {
  const b = k.at(0, 0, 0, scale);
  b.part('cylinder', 0, .45, 0, .06, .9, .06, m.metal)
    .part('cylinder', -.15, 1.05, 0, .05, .45, .05, m.metal, { rz: .5 })
    .part('cylinder', .15, 1.05, 0, .05, .45, .05, m.metal, { rz: -.5 })
    .part('orb', -.27, 1.25, 0, .08, .08, .08, lit ? m.run : m.metalDark, { motion: lit ? MOTION.glow : MOTION.still })
    .part('orb', .27, 1.25, 0, .08, .08, .08, lit ? m.info : m.metalDark, { motion: lit ? MOTION.glow : MOTION.still });
}
/** Merge sign: two arms converging into one. */
export function mergeSign(k: Kit, m: Materials, tone: string): void {
  k.part('cylinder', 0, .45, 0, .04, .9, .04, m.timber)
    .part('box', -.11, 1.05, 0, .06, .34, .05, tone, { rz: -.55 })
    .part('box', .11, 1.05, 0, .06, .34, .05, tone, { rz: .55 })
    .part('box', 0, 1.32, 0, .06, .26, .05, tone);
}
/** Envelope with a seal. */
export function envelope(k: Kit, m: Materials, seal = m.block, scale = 1): void {
  const e = k.at(0, 0, 0, scale);
  e.part('box', 0, 0, 0, .34, .22, .03, m.paper).part('box', 0, .03, .018, .25, .03, .01, m.stone, { rz: .45 })
    .part('box', 0, .03, .018, .25, .03, .01, m.stone, { rz: -.45 }).part('cylinder', 0, -.02, .025, .04, .02, .04, seal, { rx: Math.PI / 2 });
}

/* ------------------------------------------------------------------------- */
/* ROBOT PARTS                                                                */
/* ------------------------------------------------------------------------- */
export interface RobotPose { visor: string; armUp: boolean; tilt: number }
/** Robot body: treads, body, head, antenna (instanced parts, never a component). */
export function robotBody(k: Kit, m: Materials, pose: RobotPose): void {
  // Treads and hips.
  for (const x of [-1, 1]) k.part('box', x * .19, .12, 0, .16, .22, .48, m.metalDark).part('cylinder', x * .19, .12, .2, .1, .17, .1, m.metal, { rz: Math.PI / 2 });
  k.part('box', 0, .28, 0, .48, .1, .32, m.metalDark);
  // Body with chest screen.
  k.part('box', 0, .58, 0, .58, .52, .4, m.metal).part('box', 0, .62, .205, .32, .2, .02, pose.visor, { motion: MOTION.glow });
  k.part('box', 0, .87, 0, .2, .08, .2, m.metalDark);
  // Head: tilted when waiting.
  const h = k.at(0, 1.1, 0);
  h.part('orb', 0, 0, 0, .29, .25, .27, m.metal, { rz: pose.tilt })
    .part('box', 0, .01, .22, .38, .1, .06, pose.visor, { motion: MOTION.glow, rz: pose.tilt });
  for (const x of [-1, 1]) h.part('cylinder', x * .29, 0, 0, .06, .06, .06, m.metalDark, { rz: Math.PI / 2 });
  h.part('cylinder', 0, .35, 0, .018, .26, .018, m.metalDark).part('orb', 0, .5, 0, .055, .055, .055, pose.visor, { motion: MOTION.glow });
}
/** Arms; the right one raised with a wrench when working. Separate so poses never change the body. */
export function robotArms(k: Kit, m: Materials, armUp: boolean): void {
  k.part('cylinder', -.37, .56, 0, .055, .42, .055, m.metal, { rz: -.2 }).part('orb', -.41, .33, 0, .07, .07, .07, m.metalDark);
  if (armUp) {
    k.part('cylinder', .4, .78, 0, .055, .42, .055, m.metal, { rz: .6 }).part('orb', .52, .97, 0, .07, .07, .07, m.metalDark)
      .part('box', .56, 1.12, 0, .05, .26, .05, m.gold).part('ring', .56, 1.26, 0, .06, .06, .5, m.gold);
  } else {
    k.part('cylinder', .37, .56, 0, .055, .42, .055, m.metal, { rz: .2 }).part('orb', .41, .33, 0, .07, .07, .07, m.metalDark);
  }
}

/** Every socket a builder reports, in world coordinates of its kit. */
export type Sockets = Partial<Record<SocketName, Point3>>;
/** Whole robot in one call. */
export function robot(k: Kit, m: Materials, pose: RobotPose): void {
  robotBody(k, m, pose); robotArms(k, m, pose.armUp);
}
