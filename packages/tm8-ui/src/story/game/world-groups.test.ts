import { describe, expect, it } from 'vitest';
import { DISTRICT_ORDER, districtOf, districtSectors, siteLayout, type SiteUnit } from './world-groups';

const GAP = 6;
const unit = (id: string, radius = 1.5): SiteUnit => ({ id, radius });

describe('siteLayout', () => {
  it('returns no slots and the parent footprint for a childless parent', () => {
    expect(siteLayout(unit('p'), [], 0.3, GAP)).toEqual({ slots: [], radius: 1.5 });
  });

  it.each([1, 2, 3, 6, 7, 13, 40, 125])('keeps %i children clear of the parent and one another, inside the site radius', (n) => {
    const kids = Array.from({ length: n }, (_, i) => unit(`k${i}`, 1.5 + (i % 3) * .4));
    const site = siteLayout(unit('p', 1.65), kids, 0.42, GAP);
    expect(site.slots.map((s) => s.id)).toEqual(kids.map((k) => k.id));
    const r = new Map(kids.map((k) => [k.id, k.radius]));
    for (const s of site.slots) {
      expect(Math.hypot(s.dx, s.dz) - r.get(s.id)!).toBeGreaterThanOrEqual(1.65 + GAP - 1e-6);
      expect(Math.hypot(s.dx, s.dz) + r.get(s.id)!).toBeLessThanOrEqual(site.radius + 1e-6);
      for (const t of site.slots) if (t !== s) expect(Math.hypot(s.dx - t.dx, s.dz - t.dz) - r.get(s.id)! - r.get(t.id)!).toBeGreaterThanOrEqual(GAP - 1e-6);
    }
  });

  it('is deterministic, grows with child count and puts the first (newest) children on the inner ring', () => {
    const kids = (n: number) => Array.from({ length: n }, (_, i) => unit(`k${i}`));
    expect(siteLayout(unit('p'), kids(9), 0.1, GAP)).toEqual(siteLayout(unit('p'), kids(9), 0.1, GAP));
    expect(siteLayout(unit('p'), kids(30), 0.1, GAP).radius).toBeGreaterThan(siteLayout(unit('p'), kids(9), 0.1, GAP).radius);
    const site = siteLayout(unit('p'), kids(20), 0.1, GAP);
    const rings = site.slots.map((s) => s.ring);
    expect(rings).toEqual([...rings].sort((a, b) => a - b));
    expect(rings[0]).toBe(0);
    expect(Math.hypot(site.slots[0]!.dx, site.slots[0]!.dz)).toBeLessThan(Math.hypot(site.slots.at(-1)!.dx, site.slots.at(-1)!.dz));
  });

  it('leaves the +x side (toward the anchor) open on the inner ring', () => {
    const site = siteLayout(unit('p'), Array.from({ length: 5 }, (_, i) => unit(`k${i}`)), 0.5, GAP);
    for (const s of site.slots) expect(Math.abs(Math.atan2(s.dz, s.dx))).toBeGreaterThan(Math.PI / 4);
  });

  it('accounts for nested sites through a child radius', () => {
    const site = siteLayout(unit('p'), [unit('big', 12), unit('small')], 0.2, GAP);
    const big = site.slots.find((s) => s.id === 'big')!, small = site.slots.find((s) => s.id === 'small')!;
    expect(Math.hypot(big.dx - small.dx, big.dz - small.dz)).toBeGreaterThanOrEqual(12 + 1.5 + GAP - 1e-6);
    expect(site.radius).toBeGreaterThanOrEqual(Math.hypot(big.dx, big.dz) + 12);
  });
});

describe('districts', () => {
  it('maps every status category and the blocked flag to a district', () => {
    expect(districtOf({ statusCategory: 'to_do' })).toBe('to_do');
    expect(districtOf({ statusCategory: null })).toBe('to_do');
    expect(districtOf({ statusCategory: 'in_progress' })).toBe('in_progress');
    expect(districtOf({ statusCategory: 'in_progress', blocked: true })).toBe('blocked');
    expect(districtOf({ statusCategory: 'to_do', blocked: true })).toBe('blocked');
    expect(districtOf({ statusCategory: 'done', blocked: true })).toBe('done');
    expect(districtOf({ statusCategory: 'cancelled' })).toBe('done');
  });

  it('cuts the circle into sectors proportional to weight, in order, from the top', () => {
    const sectors = districtSectors(DISTRICT_ORDER.map((id, i) => ({ id, weight: i === 2 ? 0 : 1 })));
    expect(sectors.map((s) => s.id)).toEqual(['to_do', 'in_progress', 'done']);
    expect(sectors[0]!.from).toBeCloseTo(-Math.PI / 2);
    expect(sectors.at(-1)!.to).toBeCloseTo(Math.PI * 1.5);
    for (const [i, s] of sectors.entries()) {
      expect(s.to - s.from).toBeCloseTo(Math.PI * 2 / 3);
      if (i) expect(s.from).toBeCloseTo(sectors[i - 1]!.to);
    }
    expect(districtSectors([])).toEqual([]);
  });
});
