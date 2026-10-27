/**
 * Grouping seams for the world layout: pure, swappable, no scene knowledge.
 *
 *  - `siteLayout`      — where a parent's hierarchy children stand on its SITE
 *                        (concentric rings; the newest child nearest). Swap it
 *                        for a grid or a street and `layoutWorld` is unchanged:
 *                        it only reads `slots` and `radius`.
 *  - `DISTRICT_OF`     — the status → district table. Status CATEGORIES are
 *                        not entity kinds, so the table may live here.
 *  - `districtSectors` — turns district weights into angular sectors from the
 *                        hub, in `DISTRICT_ORDER`, starting at the top.
 *
 * Everything here is deterministic: the same input is the same land.
 */
import type { StatusCategory } from '@tm8/contract';

const TAU = Math.PI * 2;

/* ------------------------------------------------------------------------- */
/* SITES                                                                     */
/* ------------------------------------------------------------------------- */

/** A thing that takes up land: a place, or a whole nested site. */
export interface SiteUnit {
  id: string;
  /** Clear radius around the centre (a place's footprint, or a nested site's radius). */
  radius: number;
}

export interface SiteSlot {
  id: string;
  /** Offset from the parent's centre, in a frame where the parent's anchor lies toward +x. */
  dx: number;
  dz: number;
  /** 0 = the innermost ring. */
  ring: number;
}

export interface SiteLayout {
  slots: SiteSlot[];
  /** Radius of the whole site from the parent's centre, children's own radii included. */
  radius: number;
}

/**
 * Children on concentric rings around the parent. Rings fill inside out in the
 * given order (callers pass newest first: TIME IS DISTANCE). Every chord and
 * every radial step keeps `gap` of clear land between unit radii, so children
 * never overlap one another, the parent, or anything outside `radius`. Each
 * ring leaves one empty slot facing +x so the road from the anchor comes in
 * clean; `seed` (0..1) turns each ring a little so sibling sites differ.
 */
export function siteLayout(parent: SiteUnit, children: readonly SiteUnit[], seed: number, gap: number): SiteLayout {
  const slots: SiteSlot[] = [];
  if (!children.length) return { slots, radius: parent.radius };
  let i = 0, ring = 0, inner = parent.radius, innerRadius = 0, outer = parent.radius;
  while (i < children.length) {
    // Grow the ring greedily: add the next child while every chord still clears.
    let count = 0, widest = 0, radius = 0;
    for (let j = i; j < children.length; j++) {
      const widestNext = Math.max(widest, children[j]!.radius);
      const radiusNext = innerRadius + inner + widestNext + gap;
      const pitch = (widestNext * 2 + gap) * 1.002;
      const capacity = Math.max(1, Math.floor(Math.PI / Math.asin(Math.min(1, pitch / (2 * radiusNext)))) - 1);
      if (count + 1 > capacity) break;
      count++; widest = widestNext; radius = radiusNext;
    }
    const step = TAU / (count + 1);
    const turn = ((seed * 7919 + ring * 0.37) % 1 - .5) * .6 * step * (ring % 2 ? -1 : 1);
    for (let k = 0; k < count; k++) {
      const angle = Math.PI + (k - (count - 1) / 2) * step + turn;
      slots.push({ id: children[i + k]!.id, dx: Math.cos(angle) * radius, dz: Math.sin(angle) * radius, ring });
    }
    i += count; ring++;
    innerRadius = radius; inner = widest; outer = radius + widest;
  }
  return { slots, radius: outer };
}

/* ------------------------------------------------------------------------- */
/* DISTRICTS                                                                 */
/* ------------------------------------------------------------------------- */

export type WorldDistrict = 'to_do' | 'in_progress' | 'blocked' | 'done';

/** Sector order around the hub, from the top, clockwise on the ground plane. */
export const DISTRICT_ORDER: readonly WorldDistrict[] = ['to_do', 'in_progress', 'blocked', 'done'];

/** Status category → district. Cancelled work is finished work and rests with `done`. */
export const DISTRICT_OF: Readonly<Record<StatusCategory, WorldDistrict>> = {
  to_do: 'to_do',
  in_progress: 'in_progress',
  done: 'done',
  cancelled: 'done',
};

/** The district a task stands in: done beats blocked (as `toneOf` does); no category reads as to do. */
export function districtOf(row: { statusCategory: StatusCategory | null; blocked?: boolean }): WorldDistrict {
  const d = row.statusCategory ? DISTRICT_OF[row.statusCategory] : 'to_do';
  return d === 'done' ? d : row.blocked ? 'blocked' : d;
}

export interface Sector<K> {
  id: K;
  /** Angles in radians on the ground plane (`atan2(z, x)`), `from < to`, within [-π/2, 3π/2). */
  from: number;
  to: number;
}

/** Sectors proportional to weight, in the given order, starting at `start` (the top of the map). */
export function districtSectors<K>(weights: ReadonlyArray<{ id: K; weight: number }>, start: number = -Math.PI / 2): Array<Sector<K>> {
  const live = weights.filter((w) => w.weight > 0);
  const total = live.reduce((s, w) => s + w.weight, 0);
  let at = start;
  return live.map((w) => {
    const from = at;
    at += (TAU * w.weight) / total;
    return { id: w.id, from, to: at };
  });
}
