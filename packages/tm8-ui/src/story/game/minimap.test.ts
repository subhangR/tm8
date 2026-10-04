import { describe, expect, it } from 'vitest';
import { STORY_FIXTURE } from '../fixture';
import { buildWorld, type World } from './world';
import { HOME } from './store';
import {
  GLYPH_OF_SHAPE, MINIMAP_PAD, MINIMAP_SIZE, PICK_RADIUS, REVEAL_RADIUS,
  headingAngle, headingOf, inClearing, mapExtent, minimapModel, minimapSignature, pickTarget, project, readDistricts, unproject,
} from './minimap';

const world = buildWorld(STORY_FIXTURE);
const player = { x: HOME.x, z: HOME.z, heading: 0 };
const inBounds = ([px, py]: readonly [number, number]) => px >= 0 && px <= MINIMAP_SIZE && py >= 0 && py <= MINIMAP_SIZE;

describe('project / unproject', () => {
  it('puts the hub at the centre and the island edge inside the pad', () => {
    const at = project(50, 200, 10);
    expect(at(0, 0)).toEqual([100, 100]);
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
      const [px, py] = at(Math.cos(a) * 50, Math.sin(a) * 50);
      expect(Math.hypot(px - 100, py - 100)).toBeCloseTo(90, 6);
    }
  });

  it('turns the map to the camera: W (-x,-z) is up, D (+x,-z) is right', () => {
    const at = project(50, 200, 10);
    const [ux, uy] = at(-1, -1);
    expect(ux).toBeCloseTo(100, 6);
    expect(uy).toBeLessThan(100);
    const [rx, ry] = at(1, -1);
    expect(rx).toBeGreaterThan(100);
    expect(ry).toBeCloseTo(100, 6);
  });

  it('round-trips world → pixel → world', () => {
    const at = project(world.extent, MINIMAP_SIZE), back = unproject(world.extent, MINIMAP_SIZE);
    for (const [x, z] of [[0, 0], [12.5, -3], [-40, 27.25], [world.extent * .7, world.extent * -.7]] as const) {
      const [rx, rz] = back(...at(x, z));
      expect(rx).toBeCloseTo(x, 9);
      expect(rz).toBeCloseTo(z, 9);
    }
  });
});

describe('minimapModel on the fixture', () => {
  const all = new Set(world.places.map((p) => p.id));
  const model = minimapModel(world, all, player);

  it('frames the occupied land, within the island', () => {
    const extent = mapExtent(world);
    expect(extent).toBeLessThanOrEqual(world.extent);
    expect(model.extent).toBe(extent);
    for (const p of world.places) expect(Math.min(world.extent, Math.hypot(p.x, p.z) + REVEAL_RADIUS)).toBeLessThanOrEqual(extent + 1e-9);
  });

  it('draws every place and every road point inside the canvas', () => {
    expect(model.dots).toHaveLength(world.places.length);
    for (const d of model.dots) expect(inBounds([d.px, d.py]), d.id).toBe(true);
    expect(model.roads).toHaveLength(world.roads.length);
    for (const r of model.roads) for (const q of r.points) expect(inBounds(q), r.id).toBe(true);
  });

  it('keeps portals, roots and the hub distinguishable', () => {
    expect(model.dots.filter((d) => d.hub)).toHaveLength(1);
    expect(model.dots.filter((d) => d.portal).length).toBe(STORY_FIXTURE.page.childStories.length);
    expect(model.dots.filter((d) => d.root).length).toBe(STORY_FIXTURE.page.roots.length);
    for (const d of model.dots) expect(d.glyph === 'ring', d.id).toBe(d.portal);
    expect(Object.entries(GLYPH_OF_SHAPE).filter(([, g]) => g === 'ring').map(([s]) => s)).toEqual(['portal']);
  });

  it('clears fog only round revealed places and the player', () => {
    const only = new Set<string>();
    const fresh = minimapModel(world, only, player);
    expect(fresh.dots.filter((d) => d.revealed).map((d) => d.id)).toEqual([world.hubId]);
    expect(fresh.fog).toHaveLength(2); // the hub and the player
    const far = fresh.dots.filter((d) => Math.hypot(d.px - fresh.size / 2, d.py - fresh.size / 2) > fresh.fog[0]!.r * 1.5);
    expect(far.length).toBeGreaterThan(0);
    for (const d of far) expect(inClearing(fresh, d.px, d.py), d.id).toBe(false);
    const scale = (MINIMAP_SIZE / 2 - MINIMAP_PAD) / mapExtent(world);
    expect(fresh.fog[0]!.r).toBeCloseTo(REVEAL_RADIUS * scale, 9);
  });

  it('tracks the player position and heading', () => {
    const p = minimapModel(world, all, { x: 10, z: -4, heading: Math.PI / 2 }).player;
    const [px, py] = project(mapExtent(world), MINIMAP_SIZE)(10, -4);
    expect([p.px, p.py]).toEqual([px, py]);
    expect(p.angle).toBeCloseTo(headingAngle(Math.PI / 2), 9);
  });
});

describe('headings', () => {
  it('points the marker the way the walk goes on the turned map', () => {
    const at = project(50, 200, 10);
    for (const [dx, dz] of [[1, 0], [0, 1], [-1, -1], [1, -1], [-.3, .8]] as const) {
      const h = headingOf(0, 0, dx, dz)!;
      const [px, py] = at(dx, dz);
      const want = Math.atan2(py - 100, px - 100);
      const got = headingAngle(h);
      expect(Math.cos(got)).toBeCloseTo(Math.cos(want), 9);
      expect(Math.sin(got)).toBeCloseTo(Math.sin(want), 9);
    }
  });

  it('has no heading for a step that did not move', () => {
    expect(headingOf(3, 3, 3, 3)).toBeNull();
  });
});

describe('pickTarget', () => {
  const fresh = minimapModel(world, new Set(), player);
  const hub = fresh.dots.find((d) => d.hub)!;

  it('walks to a revealed place under the pointer', () => {
    expect(pickTarget(world, fresh, hub.px + PICK_RADIUS / 2, hub.py)).toEqual({ x: 0, z: 0, placeId: world.hubId });
  });

  it('walks to revealed ground', () => {
    const t = pickTarget(world, fresh, fresh.player.px - 4, fresh.player.py + 8)!;
    expect(t.placeId).toBeNull();
    const [x, z] = unproject(mapExtent(world), MINIMAP_SIZE)(fresh.player.px - 4, fresh.player.py + 8);
    expect([t.x, t.z]).toEqual([x, z]);
  });

  it('refuses fog and unrevealed places', () => {
    const hidden = fresh.dots.find((d) => !d.revealed && !inClearing(fresh, d.px, d.py))!;
    expect(hidden).toBeDefined();
    expect(pickTarget(world, fresh, hidden.px, hidden.py)).toBeNull();
    expect(pickTarget(world, fresh, 1, 1)).toBeNull();
  });
});

describe('readDistricts', () => {
  it('is empty when the world has none', () => {
    expect(readDistricts(world, world.extent, MINIMAP_SIZE)).toEqual([]);
  });

  it('reads sectors defensively and skips malformed ones', () => {
    const withDistricts = { ...world, districts: [
      { id: 'd1', statusCategory: 'blocked', startAngle: 0, endAngle: Math.PI / 2, innerRadius: 10, outerRadius: 30 },
      { category: 'mystery', from: 1, to: 2 },
      { id: 'bad', statusCategory: 'done' },
      null,
    ] } as World;
    const got = readDistricts(withDistricts, 50, 200, 10);
    expect(got.map((d) => [d.id, d.color])).toEqual([['d1', 'block'], ['district-1', 'ink3']]);
    expect(got[0]!.inner).toBeCloseTo(18, 9);
    expect(got[0]!.outer).toBeCloseTo(54, 9);
    expect(got[1]!.outer).toBeCloseTo(90, 9);
    // A sector starting along world +x lands where project() puts +x.
    const [px, py] = project(50, 200, 10)(30, 0);
    expect(got[0]!.start).toBeCloseTo(Math.atan2(py - 100, px - 100), 9);
  });
});

describe('minimapSignature', () => {
  it('ignores sub-pixel jitter and changes with a real move or turn', () => {
    const a = minimapSignature({ x: 1, z: 2, heading: 0 }, 180, 2);
    expect(minimapSignature({ x: 1.01, z: 2.02, heading: 0.001 }, 180, 2)).toBe(a);
    expect(minimapSignature({ x: 1.5, z: 2, heading: 0 }, 180, 2)).not.toBe(a);
    expect(minimapSignature({ x: 1, z: 2, heading: 1 }, 180, 2)).not.toBe(a);
    expect(minimapSignature({ x: 1, z: 2, heading: 0 }, 180, 1)).not.toBe(a);
  });
});
