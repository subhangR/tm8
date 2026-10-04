/**
 * ASSET PROTOTYPES — one builder per asset type, composed only from kit blocks.
 *
 * `buildAsset(type, opts)` is the whole interface: it returns instanced parts
 * centred on the origin (door to +Z), the named sockets other assets attach
 * to, and the occupied footprint/height. The `ASSET_BUILDERS` record is keyed
 * by every `AssetType`, so adding a type without a builder fails typecheck.
 *
 * The rule each builder follows: draw the type's CORE first, identical in
 * every state, then let the state add or remove props. Tests hold builders to
 * that (the core parts of a type are shared by all of its states).
 */
import type { Palette } from '../palette';
import type { Part } from '../scenery';
import { tint } from '../scenery';
import { ASSET_SPECS, stateFor, type AssetState, type AssetType } from './registry';
import {
  Kit, MOTION, materialsOf, toneOfState, type Materials, type Sockets,
  roundPlinth, squareFooting, slab, timberWalls, gableRoof, ridgeRoof, shedRoof, door, windowPane, shutters,
  crenellations, turret, chimney, nameplate, checkboxSign, flag, countBadge, lantern, scaffold, boards, barrier,
  hourglass, finial, crate, flowerBox, openBook, bookRow, displayCase, easel, gear, commitStone, branchPost,
  mergeSign, envelope, robot, robotBody, robotArms, progressRing,
} from './kit';

export interface AssetOptions {
  state?: AssetState;
  /** Contained items for containers, messages for mailboxes, steles in a cluster. */
  count?: number;
  /** 0..1 for keeps and factories. */
  progress?: number | null;
  placeId?: string | null;
  /** Draw every part in one colour: the silhouette audit. */
  flat?: string | null;
  x?: number; z?: number; scale?: number;
}

export interface BuiltAsset {
  type: AssetType;
  state: AssetState;
  parts: Part[];
  /** Number of leading parts that form the type's state-independent core. */
  core: number;
  sockets: Sockets;
  footprint: number;
  height: number;
}

interface Ctx { k: Kit; m: Materials; state: AssetState; count: number; progress: number | null; tone: string }
type Builder = (c: Ctx, done: () => void) => { sockets: Sockets; footprint: number; height: number };

const PI = Math.PI;

/* ---- STORY ---- */
const storyKeep: Builder = ({ k, m, state, progress }, core) => {
  roundPlinth(k, m, 1.55);
  k.part('cylinder', 0, 1.35, 0, .85, 2.2, .85, m.plaster).part('cylinder', 0, .55, 0, .9, .6, .9, m.stone);
  k.part('cylinder', 0, 2.5, 0, .95, .12, .95, m.stone);
  crenellations(k.at(0, 2.56, 0), m.stone, .86, 10, .22);
  turret(k.at(.86, .3, -.45), m, .32, 1.9, m.brand);
  door(k, m, .85, .46, .8, m.wood);
  k.part('box', 0, 1.65, .86, .9, .26, .04, m.paper).part('cylinder', -.46, 1.65, .86, .06, .3, .06, m.wood).part('cylinder', .46, 1.65, .86, .06, .3, .06, m.wood);
  core();
  const pole = k.at(-.25, 2.55, .1);
  if (state === 'planned') { flag(pole, m, m.brand, 1.5, true, true); scaffold(k.at(0, 2.4, 0), m, 1.7, .6, 1.7); }
  else flag(pole, m, state === 'blocked' ? m.block : m.brand, 1.5, true);
  if (state === 'blocked') boards(k.at(0, 0, .9), m.block, .6, .4);
  if (state === 'working') k.part('box', 0, .45, .89, .3, .45, .02, m.wait, { motion: MOTION.glow });
  if (state === 'done') finial(k.at(.86, 3.0, -.45), m, 1.4);
  if (progress !== null) progressRing(k, m, progress, 1.75);
  return { footprint: 2.05, height: 4.1, sockets: { door: k.point(0, 0, 1.6), sign: k.point(0, 1.65, .9), badge: k.point(-.9, 2.2, .5), top: k.point(0, 4.2, 0), left: k.point(-2.1, 0, 0), right: k.point(2.1, 0, 0), back: k.point(0, 0, -2.1) } };
};
const storyGate: Builder = ({ k, m, state }, core) => {
  slab(k, m, 2.4, .9, m.stone);
  for (const x of [-1, 1]) {
    k.part('box', x * .85, 1.15, 0, .5, 2.1, .55, m.plaster).part('box', x * .85, .3, 0, .58, .4, .62, m.stone);
    crenellations(k.at(x * .85, 2.26, 0), m.stone, .3, 4, .16);
  }
  k.part('arch', 0, 1.0, 0, .62, .85, 2.5, m.stone).part('box', 0, 2.0, 0, 1.3, .22, .5, m.stone);
  core();
  const live = state !== 'planned';
  k.part('gem', 0, 1.25, 0, .3, .48, .12, live ? m.merged : m.muted, { motion: live ? MOTION.bob : MOTION.still });
  if (live) for (const x of [-1, 1]) flag(k.at(x * .85, 2.3, 0), m, state === 'blocked' ? m.block : m.brand, .7, true);
  if (state === 'blocked') k.part('box', 0, .8, .2, 1.3, .1, .06, m.block);
  if (state === 'done') k.part('gem', 0, 2.2, .25, .14, .18, .06, m.gold);
  return { footprint: 1.65, height: 3.2, sockets: { door: k.point(0, 0, 1.2), sign: k.point(0, 2.0, .3), top: k.point(0, 3.2, 0) } };
};

/* ---- WORK ---- */
const taskWorkshop: Builder = ({ k, m, state, tone }, core) => {
  squareFooting(k, m, 1.5, 1.4);
  const built = state !== 'planned', faded = state === 'cancelled';
  const w = 1.2, d = 1.05, h = 1.0, y0 = .22;
  const walls = k.at(0, y0, 0);
  const plaster = faded ? m.muted : m.plaster;
  // Core: footing and timber frame. Half-built keeps the frame and shows the gable as rafters.
  for (const x of [-1, 1]) for (const z of [-1, 1]) walls.part('box', x * (w / 2 - .02), h / 2, z * (d / 2 - .02), .1, h, .1, m.timber);
  core();
  const wallH = built ? h : .42;
  walls.part('box', 0, wallH / 2, 0, w, wallH, d, plaster);
  if (built) walls.part('box', 0, h * .62, 0, w + .05, .07, d + .05, m.timber);
  const roof = k.at(0, y0 + h, 0);
  const roofTone = state === 'blocked' ? tint(m.block, m.ink, .35) : faded ? m.slate : m.roof;
  if (built) {
    gableRoof(roof.at(0, 0, 0), roofTone, w + .25, .85, d + .3);
    k.part('cylinder', 0, y0 + h + .32, d / 2 + .16, .11, .04, .11, m.timber, { rx: PI / 2 })
      .part('cylinder', 0, y0 + h + .32, d / 2 + .17, .08, .04, .08, state === 'working' ? m.wait : m.glass, { rx: PI / 2, motion: state === 'working' ? MOTION.glow : MOTION.still });
    chimney(k.at(.33, y0 + h + .2, -.25), m, .65, state === 'working');
    door(walls, m, d / 2, .32, .56);
    for (const x of [-.36, .36]) windowPane(walls, m, x, .66, d / 2, state === 'working');
    checkboxSign(walls.at(.66, .9, .2), m, tone, state === 'done');
  } else {
    // Rafters: two sloped beams per gable end plus the ridge — still a house.
    for (const z of [-1, 1]) for (const x of [-1, 1]) roof.part('box', x * .33, .4, z * (d / 2), .05, .78, .05, m.wood, { rz: x * .72 });
    roof.part('box', 0, .82, 0, .05, .05, d + .1, m.wood);
    scaffold(walls, m, w, h * .95, d);
    crate(k.at(.95, 0, .55), m, .32);
    k.part('box', -.9, .08, .45, .5, .08, .18, m.wood).part('box', -.9, .17, .45, .5, .08, .18, m.wood);
  }
  if (state === 'working') k.part('box', -.68, y0 + .55, .3, .05, 1.1, .05, m.wood, { rz: .18 }).part('box', -.62, y0 + .55, .45, .05, 1.1, .05, m.wood, { rz: .18 });
  if (state === 'waiting') { for (const x of [-.36, .36]) shutters(walls, m.wait, x, .66, d / 2); hourglass(k.at(.45, 0, 1.05), m, m.wait); }
  if (state === 'blocked') { boards(walls.at(0, 0, d / 2 + .06), m.block, .48, .32); barrier(k.at(0, 0, 1.15), m, m.block); }
  if (state === 'done') { finial(roof.at(0, .85, d / 2 + .15), m); flag(roof.at(0, .3, -.3), m, m.gold, .85); for (const x of [-.36, .36]) flowerBox(walls.at(x, .5, d / 2 + .06), m, .28); }
  if (state === 'cancelled') { walls.part('box', 0, .3, d / 2 + .06, .5, .07, .05, m.wood, { rz: .3 }); }
  return {
    footprint: 1.5, height: 2.6,
    sockets: { door: k.point(0, 0, 1.25), sign: k.point(.66, 1.4, .8), badge: k.point(0, 2.6, .4), left: k.point(-1.55, 0, -.1), right: k.point(1.4, 0, .55), back: k.point(0, 0, -1.4), robot: k.point(.85, 0, 1.35), top: k.point(0, 2.3, 0) },
  };
};
const attentionBelfry: Builder = ({ k, m, state }, core) => {
  roundPlinth(k, m, .7);
  for (const x of [-1, 1]) for (const z of [-1, 1]) k.part('box', x * .38, 1.0, z * .38, .09, 1.6, .09, m.timber);
  k.part('box', 0, 1.82, 0, .95, .1, .95, m.wood).part('cone', 0, 2.17, 0, .78, .6, .78, m.roof, { ry: PI / 4 }).part('spire', 0, 2.55, 0, .05, .2, .05, m.gold);
  core();
  if (state !== 'cancelled') {
    const ringing = state === 'waiting';
    k.part('spire', 0, 1.47, 0, .3, .45, .3, ringing ? m.wait : m.muted, { motion: ringing ? MOTION.sway : MOTION.still })
      .part('orb', 0, 1.22, 0, .07, .07, .07, m.metalDark, { motion: ringing ? MOTION.sway : MOTION.still })
      .part('cylinder', .12, .95, 0, .015, .9, .015, m.paper);
  }
  return { footprint: 1.0, height: 2.7, sockets: { door: k.point(0, 0, 1.0), top: k.point(0, 2.7, 0) } };
};

/* ---- SESSIONS ---- */
const sessionRobot: Builder = ({ k, m, state }, core) => {
  // The live ring is the robot's ground: it marks "running" from any distance.
  k.part('ring', 0, .03, 0, .55, .55, 1.5, m.run, { rx: PI / 2, motion: MOTION.glow }).part('disc', 0, .02, 0, .5, 1, .5, tint(m.run, m.card, .55));
  const visor = state === 'blocked' ? m.block : state === 'waiting' ? m.wait : state === 'planned' ? m.info : m.run;
  robotBody(k, m, { visor, armUp: false, tilt: state === 'waiting' ? .25 : 0 });
  core();
  robotArms(k, m, state === 'working');
  if (state === 'waiting') for (let i = 0; i < 3; i++) k.part('orb', .3 + i * .14, 1.5 + i * .17, .1, .05 + i * .03, .05 + i * .03, .05 + i * .03, m.card, { motion: MOTION.bob });
  if (state === 'blocked') k.part('gem', 0, 1.95, 0, .16, .2, .16, m.block, { motion: MOTION.bob });
  return { footprint: .6, height: 1.7, sockets: { top: k.point(0, 1.8, 0), badge: k.point(0, 2.1, 0) } };
};
const sessionStele: Builder = ({ k, m, state, count }, core) => {
  const n = Math.max(1, Math.min(3, count));
  const slots: Array<[number, number, number]> = [[0, 0, 1], [-.55, -.35, .8], [.55, -.4, .72]];
  for (let i = 0; i < n; i++) {
    const [x, z, s] = slots[i]!;
    const st = k.at(x, 0, z, s);
    st.part('cylinder', 0, .07, 0, .42, .14, .42, m.stone).part('cylinder', 0, .17, 0, .32, .08, .32, m.stoneDark)
      .part('box', 0, .85, 0, .34, 1.3, .26, m.stone, { rz: state === 'blocked' && i === 0 ? .1 : 0 })
      .part('box', 0, .78, .135, .22, .16, .02, m.metalDark)
      .part('box', -.04, .79, .15, .07, .025, .01, m.paper, { rz: -.6 }).part('box', -.04, .76, .15, .07, .025, .01, m.paper, { rz: .6 })
      .part('box', .05, .73, .15, .07, .02, .01, m.paper);
  }
  core();
  for (let i = 0; i < n; i++) {
    const [x, z, s] = slots[i]!;
    const st = k.at(x, 0, z, s);
    const gemTone = state === 'blocked' ? m.block : state === 'cancelled' ? m.muted : m.gold;
    st.part('gem', state === 'blocked' && i === 0 ? .05 : 0, 1.22, .14, .09, .12, .03, gemTone);
    if (state === 'blocked' && i === 0) st.part('cone', .38, .1, .25, .22, .22, .22, m.stone, { ry: PI / 4, rz: 1.6 });
    else st.part('cone', 0, 1.65, 0, .24, .3, .19, m.stone, { ry: PI / 4 });
    if (state === 'cancelled' && i === 0) st.part('box', 0, 1.38, 0, .4, .3, .32, m.muted, { rz: .12 });
  }
  if (count > 3) countBadge(k.at(.6, 1.3, .2), m, count, m.muted);
  return { footprint: 1.0, height: 1.8, sockets: { top: k.point(0, 1.9, 0), badge: k.point(.6, 1.3, .2) } };
};

/* ---- PEOPLE ---- */
const teammateCamp: Builder = ({ k, m, state }, core) => {
  k.part('disc', 0, .02, 0, 1.0, 1, 1.0, tint(m.leaf, m.stone, .4));
  gableRoof(k.at(-.25, .55, -.1), m.wait, 1.25, 1.1, 1.3);
  k.part('cone', -.25, .45, .53, .28, .7, .04, m.timber).part('cylinder', -.25, .55, -.75, .025, 1.2, .025, m.timber);
  for (let i = 0; i < 6; i++) { const a = i * PI / 3; k.part('orb', .7 + Math.sin(a) * .2, .06, .45 + Math.cos(a) * .2, .07, .06, .07, m.stoneDark); }
  core();
  if (state === 'working') k.part('gem', .7, .26, .45, .12, .22, .12, m.wait, { motion: MOTION.glow });
  else k.part('box', .7, .08, .45, .26, .05, .05, m.wood, { ry: .6 }).part('box', .7, .08, .45, .26, .05, .05, m.wood, { ry: -.6 });
  flag(k.at(.65, 0, -.55), m, m.brand, 1.3);
  return { footprint: 1.25, height: 1.6, sockets: { door: k.point(-.25, 0, 1.0), top: k.point(0, 1.6, 0) } };
};

/* ---- KNOWLEDGE ---- */
const docLectern: Builder = ({ k, m, state }, core) => {
  roundPlinth(k, m, .75);
  k.part('box', 0, .55, -.05, .16, .7, .16, m.timber).part('box', 0, .9, 0, .9, .06, .6, m.wood, { rx: -.35 });
  core();
  openBook(k.at(0, 1.25, .05), m, 1.2, state !== 'planned', state === 'done' ? m.gold : m.muted);
  if (state === 'planned') k.part('box', .45, 1.25, .2, .03, .35, .03, m.paper, { rz: -.5 }).part('cone', .54, 1.42, .2, .04, .1, .04, m.ink, { rz: -.5 });
  return { footprint: 1.0, height: 1.7, sockets: { door: k.point(0, 0, .95), top: k.point(0, 1.7, 0) } };
};
const artifactVitrine: Builder = ({ k, m, state }, core) => {
  roundPlinth(k, m, .7);
  displayCase(k.at(0, .27, 0), m, null, 1.15);
  core();
  if (state !== 'planned') k.part('gem', 0, .27 + 1.15 * 1.15, 0, .18, .26, .18, m.merged, { motion: MOTION.bob });
  return { footprint: 1.0, height: 2.3, sockets: { door: k.point(0, 0, .95), top: k.point(0, 2.3, 0) } };
};
const drawingEasel: Builder = ({ k, m, state }, core) => {
  k.part('disc', 0, .02, 0, .8, 1, .8, m.stone);
  easel(k.at(0, 0, 0), m, false, 1.35);
  core();
  if (state !== 'planned') {
    const e = k.at(0, 0, 0, 1.35);
    e.part('box', -.1, 1.08, .1, .36, .07, .02, m.info, { rx: -.12, rz: .3 }).part('box', .12, .94, .095, .28, .07, .02, m.brand, { rx: -.12, rz: -.4 }).part('orb', .16, 1.14, .1, .07, .07, .02, m.wait);
  }
  k.part('cylinder', .55, .35, .35, .2, .03, .2, m.wood, { rx: 1.2 }).part('orb', .5, .4, .42, .04, .04, .02, m.block).part('orb', .6, .36, .42, .04, .04, .02, m.info);
  return { footprint: .9, height: 1.9, sockets: { door: k.point(0, 0, .9), top: k.point(0, 1.9, 0) } };
};
const fileCrate: Builder = ({ k, m }, core) => {
  k.part('disc', 0, .02, 0, .85, 1, .85, m.stone);
  crate(k.at(-.15, 0, 0), m, .62); crate(k.at(.05, .62, .02), m, .5, tint(m.wood, m.card, .15)); crate(k.at(.5, 0, .3), m, .36);
  core();
  k.part('ring', .05, 1.32, .02, .14, .28, .6, m.metal).part('ring', .05, 1.28, .03, .09, .2, .6, m.metal).part('box', .05, 1.12, .27, .4, .3, .02, m.paper, { rz: .08 });
  return { footprint: .95, height: 1.65, sockets: { door: k.point(0, 0, .9), top: k.point(0, 1.65, 0) } };
};
const memoryCrystal: Builder = ({ k, m }, core) => {
  k.part('ring', 0, .3, 0, .8, .8, .8, m.gold, { rx: PI / 2 }).part('cylinder', 0, .1, 0, .7, .2, .7, m.stone);
  for (let i = 0; i < 5; i++) { const a = i * 2.4; k.part('gem', Math.cos(a) * .4, .8 + (i % 2) * .25, Math.sin(a) * .4, .22, .62, .22, i % 2 ? m.merged : m.info, { ry: a, motion: MOTION.bob }); }
  core();
  return { footprint: 1.0, height: 1.8, sockets: { top: k.point(0, 1.8, 0) } };
};

/* ---- CODE ---- */
const prTollgate: Builder = ({ k, m, state }, core) => {
  k.part('box', .2, .03, .15, 2.0, .06, .7, tint(m.stone, m.wood, .2));
  k.part('box', -.6, .55, -.3, .6, .9, .55, m.plaster).part('box', -.6, 1.05, -.3, .78, .1, .72, m.slate)
    .part('box', -.6, .6, -.02, .36, .26, .02, m.glass).part('box', -.6, .6, -.01, .42, .32, .02, m.timber);
  k.part('box', -.15, .4, .15, .14, .8, .14, m.metalDark);
  mergeSign(k.at(-.95, 0, .35), m, m.merged);
  core();
  const lamp = toneOfState(m, state === 'working' ? 'planned' : state);
  k.part('orb', -.6, 1.22, -.3, .1, .1, .1, lamp, { motion: MOTION.glow });
  const stripe = (x: number, y: number, rz: number) => k.part('box', x, y, .15, .26, .1, .07, m.card, { rz });
  if (state === 'done') {
    k.part('box', -.15, 1.25, .15, .1, 1.4, .06, m.gold);
    for (let i = 0; i < 3; i++) stripe(-.15, .75 + i * .4, PI / 2);
  } else if (state === 'cancelled') {
    k.part('box', .55, .06, .5, 1.4, .1, .06, m.muted, { ry: .4 });
  } else {
    const arm = state === 'blocked' ? m.block : m.wait;
    k.part('box', .55, .78, .15, 1.4, .1, .06, arm);
    for (let i = 0; i < 3; i++) stripe(.2 + i * .4, .78, 0);
    if (state === 'blocked') k.part('box', .6, .78, .2, .35, .06, .03, m.ink, { rz: .7 }).part('box', .6, .78, .21, .35, .06, .03, m.ink, { rz: -.7 });
    k.part('box', 1.25, .4, .15, .06, .8, .06, m.metalDark);
  }
  return { footprint: 1.25, height: 1.6, sockets: { door: k.point(.4, 0, .9), top: k.point(-.6, 1.4, -.3) } };
};
const commitMilestone: Builder = ({ k, m }, core) => {
  k.part('box', 0, .03, 0, 1.6, .05, .14, m.metalDark).part('box', 0, .07, 0, 1.6, .03, .05, m.metal);
  commitStone(k, m, m.info, 1.3);
  core();
  return { footprint: .8, height: .8, sockets: { top: k.point(0, .8, 0) } };
};
const worktreeBranch: Builder = ({ k, m, state }, core) => {
  k.part('cylinder', 0, .06, 0, .35, .12, .35, m.stoneDark);
  core();
  branchPost(k, m, state === 'working', 1.2);
  return { footprint: .6, height: 1.7, sockets: { top: k.point(0, 1.7, 0) } };
};
const messageLetter: Builder = ({ k, m }, core) => {
  envelope(k.at(0, .3, 0), m, m.block, 1.5);
  core();
  return { footprint: .3, height: .5, sockets: {} };
};
const unknownCairn: Builder = ({ k, m }, core) => {
  k.part('orb', 0, .25, 0, .5, .3, .45, m.stone).part('orb', .05, .65, 0, .36, .22, .32, m.stoneDark).part('orb', -.02, .95, .02, .24, .16, .22, m.stone);
  core();
  k.part('gem', 0, 1.45, 0, .16, .24, .16, m.merged, { motion: MOTION.bob }).part('ring', 0, 1.45, 0, .3, .3, .5, m.merged);
  return { footprint: .7, height: 1.8, sockets: { top: k.point(0, 1.8, 0) } };
};

/* ---- CONTAINERS ---- */
const storyLibrary: Builder = ({ k, m, count }, core) => {
  k.part('box', 0, .12, 0, 2.9, .24, 2.0, m.stone).part('box', 0, .07, 1.15, 1.4, .14, .35, m.stoneDark).part('box', 0, .03, 1.38, 1.6, .06, .2, m.stoneDark);
  k.part('box', 0, .84, -.15, 2.4, 1.2, 1.3, m.plaster);
  for (let i = 0; i < 4; i++) k.part('cylinder', -.9 + i * .6, .84, .72, .09, 1.2, .09, m.paper).part('box', -.9 + i * .6, .28, .72, .22, .08, .22, m.stone);
  k.part('box', 0, 1.5, .25, 2.6, .14, 1.1, m.stone);
  ridgeRoof(k.at(0, 1.57, -.15), m.merged, 2.5, .5, 1.5);
  ridgeRoof(k.at(0, 1.57, .62), m.paper, 2.6, .5, .25);
  k.part('cylinder', 0, 2.05, -.15, .5, .35, .5, m.plaster).part('dome', 0, 2.22, -.15, .5, .5, .5, m.merged).part('spire', 0, 2.82, -.15, .07, .25, .07, m.gold);
  for (const x of [-1, 1]) k.part('arch', x * 1.21, .65, -.15, .2, .25, 3, m.timber, { ry: PI / 2 }).part('box', x * 1.205, .75, -.15, .02, .25, .38, m.glass);
  door(k.at(0, .24, 0), m, .5, .4, .7);
  core();
  openBook(k.at(0, 1.25, .76), m, .55);
  countBadge(k.at(.95, 1.85, .7), m, count, m.merged);
  return { footprint: 1.9, height: 3.1, sockets: { door: k.point(0, 0, 1.6), badge: k.point(.95, 1.85, .7), sign: k.point(0, 1.85, .78), top: k.point(0, 3.1, -.15) } };
};
const storyCodeFactory: Builder = ({ k, m, state, count }, core) => {
  slab(k, m, 2.9, 2.0, m.stoneDark);
  k.part('box', .1, .72, -.1, 2.2, 1.2, 1.3, m.brick).part('box', .1, .2, -.1, 2.26, .16, 1.36, m.stone);
  for (let i = 0; i < 3; i++) {
    const z = -.55 + i * .45;
    k.part('prism', .1, 1.55, z, 2.2, .45, .45, m.slate);
    k.part('box', .1, 1.5, z - .22, 2.1, .32, .02, m.glass);
  }
  k.part('cylinder', -1.05, 1.5, -.55, .2, 2.8, .2, m.brick);
  for (const y of [.8, 1.6, 2.4]) k.part('cylinder', -1.05, y, -.55, .23, .07, .23, m.metalDark);
  gear(k.at(.65, .95, .56), m, .32);
  k.part('box', -.3, .55, .56, .6, .7, .04, m.metal);
  for (let i = 0; i < 4; i++) k.part('box', -.3, .3 + i * .16, .59, .58, .03, .02, m.metalDark);
  // Worktree pipes branching on the side wall.
  k.part('cylinder', 1.22, .85, -.1, .06, .9, .06, m.metal).part('cylinder', 1.32, 1.35, -.3, .05, .45, .05, m.metal, { rx: .6 }).part('cylinder', 1.32, 1.35, .1, .05, .45, .05, m.metal, { rx: -.6 });
  // Conveyor out of the door.
  k.part('box', .55, .32, 1.05, 1.5, .08, .4, m.metalDark);
  for (let i = 0; i < 4; i++) k.part('cylinder', -.1 + i * .43, .2, 1.05, .07, .4, .07, m.metal, { rx: PI / 2 }).part('box', -.1 + i * .43, .14, 1.05, .05, .28, .05, m.metalDark);
  core();
  if (state === 'working') for (let i = 0; i < 3; i++) k.part('orb', -1.05 + i * .03, 3.1 + i * .3, -.55, .18 + i * .05, .16 + i * .04, .18 + i * .05, m.card, { motion: MOTION.rise });
  const cubes = state === 'planned' ? 0 : Math.min(3, Math.max(1, count));
  for (let i = 0; i < cubes; i++) k.part('box', .1 + i * .45, .48, 1.05, .22, .22, .22, m.info).part('ring', .1 + i * .45, .48, 1.165, .06, .06, .5, m.card);
  countBadge(k.at(1.0, 1.95, .5), m, count, m.info);
  return { footprint: 1.9, height: 3.3, sockets: { door: k.point(-.3, 0, 1.4), badge: k.point(1.0, 1.95, .5), sign: k.point(.65, .95, .6), top: k.point(-1.05, 3.0, -.55) } };
};
const taskLibrary: Builder = ({ k, m, count }, core) => {
  k.part('box', 0, .06, 0, .9, .12, .62, m.stone);
  k.part('box', 0, .55, -.08, .8, .9, .4, m.wood).part('box', 0, .55, .02, .7, .8, .22, m.timber);
  shedRoof(k.at(0, 1.07, -.02), m.merged, .96, .66, -.35);
  for (const y of [.24, .5, .76]) k.part('box', 0, y, .08, .72, .03, .26, m.wood);
  core();
  const per = Math.ceil(Math.min(count, 27) / 3);
  for (let row = 0; row < 3; row++) bookRow(k.at(0, .26 + row * .26, .1), m, Math.max(0, Math.min(per, count - row * per)), .66, row * 3);
  countBadge(k.at(.38, 1.3, .2), m, count, m.merged);
  return { footprint: .6, height: 1.4, sockets: { door: k.point(0, 0, .5), badge: k.point(.38, 1.3, .2) } };
};
const taskMailbox: Builder = ({ k, m, count }, core) => {
  k.part('cylinder', 0, .04, 0, .22, .08, .22, m.stone).part('box', 0, .45, 0, .09, .85, .09, m.timber);
  k.part('box', 0, .95, 0, .3, .2, .48, m.slate).part('cylinder', 0, 1.05, 0, .15, .48, .15, m.slate, { rx: PI / 2 }).part('box', 0, 1.0, .245, .26, .26, .02, m.metalDark);
  core();
  const up = count > 0;
  k.part('box', .17, up ? 1.18 : .98, -.05, .03, up ? .3 : .06, up ? .06 : .3, m.block, {}).part('box', .17, up ? 1.3 : .98, up ? .03 : -.24, .03, .12, .14, m.block);
  for (let i = 0; i < Math.min(3, count); i++) k.part('box', -.06 + i * .06, 1.13 + i * .015, .2 + i * .02, .2, .02, .14, m.paper, { rz: .1 * (i - 1) });
  countBadge(k.at(0, 1.5, .1), m, count, m.wait);
  return { footprint: .35, height: 1.7, sockets: { door: k.point(0, 0, .4), badge: k.point(0, 1.5, .1) } };
};
const taskCodeShed: Builder = ({ k, m, state }, core) => {
  k.part('box', 0, .06, 0, 1.0, .12, .8, m.stoneDark);
  k.part('box', -.1, .5, -.1, .7, .76, .55, m.wood);
  shedRoof(k.at(-.1, .93, -.1), m.slate, .85, .72, .3);
  gear(k.at(-.1, .55, .19), m, .17);
  core();
  branchPost(k.at(.42, .1, .05), m, state === 'working', .65);
  for (let i = 0; i < 2; i++) commitStone(k.at(-.3 + i * .38, .1, .55), m, m.info, .45);
  if (state === 'done') k.part('box', .42, 1.05, .3, .05, .6, .04, m.gold);
  return { footprint: .7, height: 1.2, sockets: { door: k.point(-.1, 0, .5) } };
};
const mailboxCategories: Builder = ({ k, m, count }, core) => {
  for (const x of [-.55, .55]) k.part('box', x, .45, 0, .08, .9, .08, m.timber);
  k.part('box', 0, .88, 0, 1.4, .07, .1, m.timber);
  const tones = [m.info, m.run, m.block];
  for (let i = 0; i < 3; i++) k.part('box', -.45 + i * .45, 1.05, 0, .3, .2, .4, m.slate).part('cylinder', -.45 + i * .45, 1.15, 0, .15, .4, .15, m.slate, { rx: PI / 2 });
  core();
  for (let i = 0; i < 3; i++) {
    const n = Math.max(0, count - i * 2);
    k.part('box', -.45 + i * .45 + .16, n ? 1.25 : 1.08, -.05, .03, n ? .25 : .05, n ? .05 : .25, tones[i]!);
    countBadge(k.at(-.45 + i * .45, 1.5, .1, .8), m, n, tones[i]!);
  }
  return { footprint: .8, height: 1.7, sockets: { door: k.point(0, 0, .4) } };
};

export const ASSET_BUILDERS: Readonly<Record<AssetType, Builder>> = {
  'story-keep': storyKeep, 'story-gate': storyGate,
  'task-workshop': taskWorkshop, 'attention-belfry': attentionBelfry,
  'session-robot': sessionRobot, 'session-stele': sessionStele,
  'teammate-camp': teammateCamp,
  'doc-lectern': docLectern, 'artifact-vitrine': artifactVitrine, 'drawing-easel': drawingEasel, 'file-crate': fileCrate, 'memory-crystal': memoryCrystal,
  'pr-tollgate': prTollgate, 'commit-milestone': commitMilestone, 'worktree-branch': worktreeBranch,
  'message-letter': messageLetter, 'unknown-cairn': unknownCairn,
  'story-library': storyLibrary, 'story-code-factory': storyCodeFactory, 'task-library': taskLibrary, 'task-mailbox': taskMailbox,
  'task-code-shed': taskCodeShed, 'mailbox-categories': mailboxCategories,
};

/** Build one asset. Deterministic: same inputs, same parts. */
export function buildAsset(type: AssetType, palette: Palette, opts: AssetOptions = {}): BuiltAsset {
  const parts: Part[] = [];
  const k = new Kit(parts, opts.x ?? 0, 0, opts.z ?? 0, opts.scale ?? 1, opts.placeId ?? null, opts.flat ?? null);
  const m = materialsOf(palette);
  const state = stateFor(type, opts.state ?? ASSET_SPECS[type].states[0]!);
  let core = -1;
  const out = ASSET_BUILDERS[type]({ k, m, state, count: opts.count ?? 0, progress: opts.progress ?? null, tone: toneOfState(m, state) }, () => { core = parts.length; });
  return { type, state, parts, core: core < 0 ? parts.length : core, ...out };
}

/** The kit's building blocks one by one, for the catalog's parts sheet. */
export const KIT_BLOCKS: ReadonlyArray<{ name: string; draw: (k: Kit, m: Materials) => void }> = [
  { name: 'round plinth', draw: (k, m) => roundPlinth(k, m, .8) },
  { name: 'square footing', draw: (k, m) => squareFooting(k, m, 1.2, 1.0) },
  { name: 'timber walls', draw: (k, m) => timberWalls(k, m, 1.0, .9, .8) },
  { name: 'gable roof', draw: (k, m) => gableRoof(k.at(0, .2, 0), m.roof, 1.1, .8, 1.0) },
  { name: 'ridge roof / pediment', draw: (k, m) => ridgeRoof(k.at(0, .2, 0), m.merged, 1.2, .6, .9) },
  { name: 'shed roof', draw: (k, m) => shedRoof(k.at(0, .5, 0), m.slate, 1.0, .8, .3) },
  { name: 'door + arch', draw: (k, m) => { k.part('box', 0, .45, 0, .8, .9, .1, m.plaster); door(k, m, .05, .4, .7); } },
  { name: 'windows lit / shuttered', draw: (k, m) => { k.part('box', 0, .45, 0, 1, .9, .1, m.plaster); windowPane(k, m, -.25, .5, .05, true); windowPane(k, m, .25, .5, .05, false); shutters(k, m.wait, .25, .5, .05); } },
  { name: 'crenellations + turret', draw: (k, m) => { crenellations(k.at(-.4, 0, 0), m.stone, .4, 8, .16); turret(k.at(.5, 0, 0), m, .25, 1.0, m.brand); } },
  { name: 'chimney + smoke', draw: (k, m) => chimney(k, m, .8, true) },
  { name: 'nameplate', draw: (k, m) => nameplate(k, m) },
  { name: 'checkbox sign', draw: (k, m) => checkboxSign(k.at(0, 1, 0), m, m.run, true) },
  { name: 'flag / pennant / furled', draw: (k, m) => { flag(k.at(-.5, 0, 0), m, m.brand); flag(k.at(0, 0, 0), m, m.brand, 1, true); flag(k.at(.5, 0, 0), m, m.brand, 1, false, true); } },
  { name: 'count badge 1/3/12', draw: (k, m) => { countBadge(k.at(-.5, .8, 0), m, 1, m.merged); countBadge(k.at(0, .8, 0), m, 3, m.merged); countBadge(k.at(.5, .8, 0), m, 12, m.merged); } },
  { name: 'lantern', draw: (k, m) => lantern(k, m) },
  { name: 'scaffold', draw: (k, m) => scaffold(k, m, .9, 1.1, .8) },
  { name: 'boards + barrier', draw: (k, m) => { boards(k.at(0, .4, 0), m.block); barrier(k.at(0, 0, .5), m, m.block); } },
  { name: 'hourglass', draw: (k, m) => hourglass(k, m, m.wait) },
  { name: 'finial', draw: (k, m) => finial(k.at(0, .3, 0), m, 1.5) },
  { name: 'crate', draw: (k, m) => crate(k, m, .5) },
  { name: 'flower box', draw: (k, m) => flowerBox(k.at(0, .3, 0), m, .5) },
  { name: 'open book', draw: (k, m) => openBook(k.at(0, .6, 0), m) },
  { name: 'book row', draw: (k, m) => { k.part('box', 0, .02, 0, .8, .04, .25, m.wood); bookRow(k.at(0, .04, 0), m, 10, .76); } },
  { name: 'display case', draw: (k, m) => displayCase(k, m, m.merged, .9) },
  { name: 'easel', draw: (k, m) => easel(k, m, true) },
  { name: 'gear', draw: (k, m) => gear(k.at(0, .5, 0), m, .4) },
  { name: 'commit stone', draw: (k, m) => commitStone(k, m) },
  { name: 'branch post', draw: (k, m) => branchPost(k, m, true) },
  { name: 'merge sign', draw: (k, m) => mergeSign(k, m, m.merged) },
  { name: 'envelope', draw: (k, m) => envelope(k.at(0, .4, 0), m, m.block, 1.5) },
  { name: 'robot parts', draw: (k, m) => robot(k, m, { visor: m.run, armUp: true, tilt: 0 }) },
];

/** Draw one kit block (catalog parts sheet). */
export function buildBlock(index: number, palette: Palette, x: number, z: number, flat: string | null = null): Part[] {
  const parts: Part[] = [];
  KIT_BLOCKS[index]!.draw(new Kit(parts, x, 0, z, 1, null, flat), materialsOf(palette));
  return parts;
}

export interface AssetMetrics {
  /** Occupied rectangle, centred on the origin (layout). */
  footprint: { w: number; d: number };
  /** Conservative occupied radius (matches world.ts `footprint`). */
  radius: number;
  height: number;
  /** Where roads meet the entrance, relative to the origin. */
  doorstep: { x: number; z: number };
  /** Where a DOM count label sits (.sgm-labels), relative to the origin; null when the type has none. */
  badgeAnchor: { x: number; y: number; z: number } | null;
  /** Where this building's running-session robot stands; null for non-buildings. */
  robotStand: { x: number; z: number } | null;
  /** Attachment sockets for the task Library (left), Mailbox (right) and steles (back). */
  attach: { left: { x: number; z: number } | null; right: { x: number; z: number } | null; back: { x: number; z: number } | null };
  /** Task buildings: where the task Library annex and the Mailbox stand (same as attach.left/right). */
  attachments: { taskLibrary: { x: number; z: number } | null; mailbox: { x: number; z: number } | null };
}

const metricsCache = new Map<AssetType, AssetMetrics>();
const METRIC_PALETTE: Palette = { ink: 'black', ink3: 'gray', surface: 'white', card: 'white', line: 'gray', line2: 'gray', brand: 'gray', run: 'gray', info: 'gray', block: 'gray', wait: 'gray', merged: 'gray' };
/** Layout metrics for a type, measured once from its fullest default build. Palette-independent. */
export function assetMetrics(type: AssetType): AssetMetrics {
  const hit = metricsCache.get(type);
  if (hit) return hit;
  const built = buildAsset(type, METRIC_PALETTE, { state: ASSET_SPECS[type].states.includes('done') ? 'done' : ASSET_SPECS[type].states[0]!, count: 6 });
  let w = 0, d = 0;
  for (const p of built.parts) {
    if (p.geo === 'paving' || p.geo === 'disc') continue;
    const r = Math.max(p.sx, p.sz) * (p.geo === 'box' || p.geo === 'prism' ? .5 : 1);
    w = Math.max(w, Math.abs(p.x) + r); d = Math.max(d, Math.abs(p.z) + r);
  }
  const s = built.sockets, xz = (q?: { x: number; z: number }) => (q ? { x: q.x, z: q.z } : null);
  const out: AssetMetrics = {
    footprint: { w: +(2 * w).toFixed(2), d: +(2 * d).toFixed(2) }, radius: built.footprint, height: built.height,
    doorstep: xz(s.door) ?? { x: 0, z: built.footprint + .3 },
    badgeAnchor: s.badge ?? null, robotStand: xz(s.robot),
    attach: { left: xz(s.left), right: xz(s.right), back: xz(s.back) },
    attachments: { taskLibrary: xz(s.left), mailbox: xz(s.right) },
  };
  metricsCache.set(type, out);
  return out;
}
