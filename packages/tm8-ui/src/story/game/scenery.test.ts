import { describe, expect, it } from 'vitest';
import { STORY_FIXTURE } from '../fixture';
import { buildWorld } from './world';
import { makeScenery } from './scenery';
import { KIT_GEOMETRIES } from './assets/geometry';
import { placeAsset } from './place-asset';
import type { Palette } from './palette';
const palette: Palette = { ink: 'rgb(20,20,20)', ink3: 'rgb(100,100,100)', surface: 'rgb(240,240,230)', card: 'rgb(255,255,255)', line: 'rgb(200,200,200)', line2: 'rgb(180,180,180)', brand: 'rgb(160,90,40)', run: 'rgb(50,140,80)', info: 'rgb(50,100,160)', block: 'rgb(180,70,60)', wait: 'rgb(180,150,40)', merged: 'rgb(120,80,160)' };
describe('instanced scenery', () => {
  it('keeps decorative scatter fixed when work status changes', () => {
    const world = buildWorld(STORY_FIXTURE);
    const before = makeScenery(world, palette);
    const after = makeScenery({ ...world, places: world.places.map((p) => ({ ...p, tone: 'done' as const, live: !p.live })) }, palette);
    const foliage = (parts: typeof before) => parts.filter((p) => !p.placeId && p.motion === 1);
    expect(foliage(after)).toEqual(foliage(before));
    expect(foliage(before).length).toBeGreaterThan(100);
  });
  it('uses at most the kit\'s geometry batches (including flat road surfaces) for the complete 50+ place fixture', () => {
    const page = { ...STORY_FIXTURE.page, nodes: [...STORY_FIXTURE.page.nodes, ...Array.from({ length: 25 }, (_, i) => ({ ...STORY_FIXTURE.page.nodes[1]!, id: `stress-${i}`, title: `Place ${i}` }))] };
    const world = buildWorld({ ...STORY_FIXTURE, page }), parts = makeScenery(world, palette);
    expect(world.places.length).toBeGreaterThanOrEqual(50);
    expect(new Set(parts.map((p) => p.geo)).size).toBeLessThanOrEqual(Object.keys(KIT_GEOMETRIES).length);
    expect(parts.every((p) => [p.x, p.y, p.z, p.sx, p.sy, p.sz].every(Number.isFinite))).toBe(true);
    for (const place of world.places) expect(parts.some((p) => p.placeId === place.id)).toBe(true);
  });
  it('caps decorative scatter even when the land grows to a thousand entities', () => {
    const world = buildWorld(STORY_FIXTURE);
    const place = world.places.find((p) => p.shape === 'building')!;
    const parts = makeScenery({ ...world, roads: [], extent: 600, places: Array.from({ length: 1000 }, (_, i) => ({ ...place, id: `bounded-${i}`, x: (i % 32 - 16) * 18, z: (Math.floor(i / 32) - 16) * 18 })) }, palette);
    expect(parts.filter((p) => !p.placeId && p.motion === 1).length).toBeLessThanOrEqual(5400);
    expect(new Set(parts.map((p) => p.geo)).size).toBeLessThanOrEqual(Object.keys(KIT_GEOMETRIES).length);
  });
  it('draws every geometry from the registered kit, and every place through its kit asset', () => {
    const world = buildWorld(STORY_FIXTURE), parts = makeScenery(world, palette);
    for (const part of parts) expect(part.geo in KIT_GEOMETRIES).toBe(true);
    for (const place of world.places) {
      const own = parts.filter((p) => p.placeId === place.id), asset = placeAsset(place, world);
      expect(own.length, `${place.id} (${asset.type})`).toBeGreaterThan(0);
      // The robot for a live session is drawn once, by the robots layer: its plot keeps only a pad and a lantern.
      if (asset.type === 'session-robot') {
        const ended = makeScenery({ ...world, places: [{ ...place, live: false }] }, palette).filter((p) => p.placeId === place.id);
        expect(own.length).toBeLessThan(ended.length);
      } else expect(Math.max(...own.map((p) => p.y))).toBeGreaterThan(.4);
    }
  });
  it('renders a task\'s attachments beside its workshop only when the page carries them', () => {
    const world = buildWorld(STORY_FIXTURE);
    const task = world.places.find((p) => p.attachments !== null)!;
    const parts = makeScenery(world, palette).filter((p) => p.placeId === task.id);
    const bare = makeScenery({ ...world, places: world.places.map((p) => (p.id === task.id ? { ...p, attachments: null } : p)) }, palette).filter((p) => p.placeId === task.id);
    expect(parts.length).toBeGreaterThan(bare.length);
  });
});
