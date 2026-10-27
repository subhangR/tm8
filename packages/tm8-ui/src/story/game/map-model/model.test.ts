import { describe, expect, it } from 'vitest';
import { buildMapModel, fromProjection, layoutForest, MAP_FIXTURES, FIXTURE_SCOPE, smallFixture, denseFixture, nestedFixture } from './index';
import type { MapInput, MapModel, MapType } from './types';
const build = (input: MapInput, type: MapType = 'taskland', previous?: MapModel) => buildMapModel(input, { type, scope: input.scope ?? FIXTURE_SCOPE, previous });
const point = (model: MapModel, id: string) => { const p = model.places.find(p => p.id === id)!; return [p.x, p.z]; };
function invariant(model: MapModel): void {
  const byId = new Map(model.places.map(p => [p.id, p]));
  expect(byId.size).toBe(model.places.length);
  for (const p of model.places) {
    expect(Number.isFinite(p.x + p.z + p.footprint)).toBe(true);
    expect(p.footprint).toBeGreaterThanOrEqual(p.radius);
    if (p.parentId) {
      const parent = byId.get(p.parentId)!;
      expect(p.compoundBounds.minX).toBeGreaterThanOrEqual(parent.compoundBounds.minX - 1e-7);
      expect(p.compoundBounds.minZ).toBeGreaterThanOrEqual(parent.compoundBounds.minZ - 1e-7);
      expect(p.compoundBounds.maxX).toBeLessThanOrEqual(parent.compoundBounds.maxX + 1e-7);
      expect(p.compoundBounds.maxZ).toBeLessThanOrEqual(parent.compoundBounds.maxZ + 1e-7);
      expect(p.compoundBounds.minZ).toBeGreaterThan(parent.z + parent.radius);
    }
  }
  for (let i = 0; i < model.places.length; i++) for (let j = i + 1; j < model.places.length; j++) {
    const a = model.places[i]!, b = model.places[j]!;
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThanOrEqual(a.radius + b.radius - 1e-7);
    if (a.parentId === b.parentId) expect(a.compoundBounds.maxX <= b.compoundBounds.minX || b.compoundBounds.maxX <= a.compoundBounds.minX || a.compoundBounds.maxZ <= b.compoundBounds.minZ || b.compoundBounds.maxZ <= a.compoundBounds.minZ).toBe(true);
  }
}
describe('renderer-agnostic entity maps', () => {
  it('routes real entities across six maps, decor never masquerades as an entity', () => {
    const input = smallFixture(), ids = new Set(input.entities.map(n => n.id));
    for (const type of ['hub', 'taskland', 'office', 'library', 'factory', 'town'] as const) {
      const model = build(input, type); invariant(model);
      for (const p of model.places) expect(ids.has(p.entityId)).toBe(true);
      expect(model.roads.every(r => r.type === 'depends_on')).toBe(true);
      if (type === 'hub') { expect(model.places).toHaveLength(0); expect(model.portals).toHaveLength(6); expect(model.decor).toHaveLength(5); }
      if (type === 'library' || type === 'factory') expect(model.groups.every(g => g.key === 'collection')).toBe(true);
      if (type === 'office') expect(model.groups.every(g => g.proposed && g.label.includes('proposed'))).toBe(true);
    }
    const land = build(input), town = build(input, 'town');
    expect(land.places.find(p => p.id === 'task-done')?.role).toBe('shipped-marker');
    expect(land.places.find(p => p.id === 'task-done')?.progress).toBe(0.61);
    expect(town.places.map(p => p.id)).toEqual(expect.arrayContaining(['task-done', 'session-done', 'artifact-square']));
    expect(town.places.some(p => p.id === 'task-cancelled')).toBe(false);
    expect(land.places.find(p => p.id === 'task-cancelled')?.constructionStage).toBe('rubble');
  });
  it('is deterministic including shuffled input, repairs cycles and handles empty maps', () => {
    for (const fixture of Object.values(MAP_FIXTURES)) {
      const input = fixture(), model = build(input);
      expect(build({ ...input, entities: [...input.entities].reverse() }).places).toEqual(model.places);
      if (input.entities.length < 100) invariant(model);
      expect(build(input)).toEqual(model);
    }
    const pathological = build(MAP_FIXTURES.pathological());
    expect(pathological.warnings.some(s => s.includes('Cycle'))).toBe(true);
  });
  it('repeats groups at every depth and keeps child moves within their compound', () => {
    const input = nestedFixture(), before = build(input);
    const changed = { ...input, entities: input.entities.map(n => n.id === 'nested-3' ? { ...n, status: 'open' } : n) };
    const after = build(changed, 'taskland', before);
    expect(Math.max(...before.places.map(n => n.depth))).toBe(5);
    expect(new Set(before.groups.map(g => g.depth)).size).toBe(6);
    for (const p of before.places) if (!['nested-3', 'nested-4', 'nested-5'].includes(p.id)) expect(point(after, p.id)).toEqual(point(before, p.id));
    expect(point(after, 'nested-3')).not.toEqual(point(before, 'nested-3'));
    invariant(after);
  });
  it('moves a root compound without changing local offsets or other roots', () => {
    const input = nestedFixture(), before = build(input);
    const after = build({ ...input, entities: input.entities.map(n => n.id === 'task-foundation' ? { ...n, status: 'in_review' } : n) }, 'taskland', before);
    const [bx, bz] = point(before, 'task-foundation'), [ax, az] = point(after, 'task-foundation');
    for (const id of ['task-plans', 'nested-1', 'nested-5']) {
      const a = point(after, id), b = point(before, id);
      expect(a[0]! - ax!).toBeCloseTo(b[0]! - bx!, 7); expect(a[1]! - az!).toBeCloseTo(b[1]! - bz!, 7);
    }
    expect(point(after, 'task-blocked')).toEqual(point(before, 'task-blocked')); invariant(after);
  });
  it('reuses freed slots and retains cancelled plots in place', () => {
    const input = smallFixture(), before = build(input);
    const after = build({ ...input, entities: input.entities.map(n => n.id === 'task-review' ? { ...n, status: 'working' } : n) }, 'taskland', before);
    const added = build({ ...input, entities: [...input.entities.filter(n => n.id !== 'task-review'), { id: 'new-review', kind: 'task', title: 'New', status: 'in_review' }] }, 'taskland', after);
    expect(point(added, 'new-review')).toEqual(point(before, 'task-review'));
    const cancelled = build({ ...input, entities: input.entities.map(n => n.id === 'task-review' ? { ...n, status: 'cancelled' } : n) }, 'taskland', before);
    expect(point(cancelled, 'task-review')).toEqual(point(before, 'task-review'));
    expect(cancelled.places.find(p => p.id === 'task-review')!.constructionStage).toBe('rubble');
  });
  it('emits one robot per active claim, linked by session and removes ended claims', () => {
    const model = build(smallFixture());
    expect(model.robots).toHaveLength(3);
    expect(model.robots.filter(r => r.sessionId === 'session-builder')).toHaveLength(2);
    expect(new Set(model.robots.map(r => r.id)).size).toBe(3);
    expect(model.robots.find(r => r.claimId === 'claim-helper')?.pose).toBe('waiting');
  });
  it('preserves completion outcome after a process fails or exits', () => {
    const input = fromProjection({ entities: [{ id: 's', kind: 'work_session', title: 'Done', outcome: 'completed', processState: 'failed', status: 'failed' }], edges: [] }, FIXTURE_SCOPE);
    expect(build(input, 'office').places).toHaveLength(0); expect(build(input, 'town').places).toHaveLength(1);
  });
  it('does not let an open outcome mask a running or ended process', () => {
    const input = fromProjection({ entities: [
      { id: 'task', kind: 'task', title: 'Task', status: 'working' },
      { id: 'running', kind: 'work_session', title: 'Running', outcome: 'open', processState: 'running', live: true },
      { id: 'failed', kind: 'work_session', title: 'Failed', outcome: 'open', processState: 'failed', live: true },
      { id: 'exited', kind: 'work_session', title: 'Exited', outcome: 'open', status: 'exited' },
      { id: 'completed', kind: 'work_session', title: 'Completed', outcome: 'completed', processState: 'failed' },
    ], edges: ['running', 'failed', 'exited', 'completed'].map(id => ({ id: `claim-${id}`, type: 'working_on', fromId: id, toId: 'task' })) }, FIXTURE_SCOPE);
    const office = build(input, 'office');
    expect(office.places.find(p => p.id === 'running')?.groupId).toContain(':active');
    expect(office.places.find(p => p.id === 'failed')?.assetKey).toBe('office.plaque');
    expect(office.places.find(p => p.id === 'exited')?.assetKey).toBe('office.plaque');
    expect(build(input).robots.map(r => r.sessionId)).toEqual(['running']);
    expect(build(input, 'town').places.map(p => p.id)).toEqual(['completed']);
  });
  it('preserves authoritative weighted percent and parent direction from a StoryPage snapshot', () => {
    const input = fromProjection({ id: 'story-real', kind: 'story', page: {
      nodes: [{ id: 'p', kind: 'task', title: 'Done root', status: 'done' }, { id: 'c', kind: 'task', title: 'Open child', status: 'open' }],
      roots: [{ id: 'p', kind: 'task', title: 'Done root', status: 'done', weighted: { percent: 37, size: 13 } }],
      edges: [{ type: 'parent', fromId: 'p', toId: 'c' }],
    } });
    const model = build(input);
    expect(input.entities.find(e => e.id === 'c')!.parentId).toBe('p');
    expect(model.places.find(e => e.id === 'p')!.progress).toBe(0.37);
    expect(model.places.find(e => e.id === 'c')!.progress).toBeNull();
  });
  it('reads normalized query row state/content and preserves scope provenance', () => {
    const input = fromProjection({ scope: FIXTURE_SCOPE, entities: [
      { id: 't', kind: 'task', content: { title: 'Query task' }, state: { status: 'done', progress: { percent: 42, size: 8 } } },
      { id: 's', kind: 'work_session', content: { title: 'Query session' }, state: { status: 'failed', processState: 'exited', outcome: 'completed', endedKind: 'completed' } },
    ], edges: [] }, { kind: 'space', id: 'space' });
    expect(input.scope).toEqual(FIXTURE_SCOPE);
    expect(input.warnings?.[0]).toContain('only story');
    expect(input.entities[0]).toMatchObject({ title: 'Query task', status: 'done', progress: 0.42, subtreeWeight: 8 });
    expect(input.entities[1]).toMatchObject({ outcome: 'completed', processState: 'exited' });
    const model = buildMapModel(input, { type: 'town', scope: { kind: 'space', id: 'space' } });
    expect(model.scope).toEqual(FIXTURE_SCOPE); expect(model.warnings.length).toBeGreaterThan(0);
    expect(model.places).toHaveLength(2);
  });
  it('aggregates root mailbox counts through depth five without mutating input', () => {
    const input = nestedFixture();
    const enriched = { ...input, entities: input.entities.map(n => ({ ...n, mailbox: { count: 1 } })) };
    const before = JSON.stringify(enriched); const model = build(enriched);
    expect(model.places.find(p => p.id === 'task-foundation')!.mailbox?.count).toBe(7);
    expect(model.places.filter(p => p.parentId).every(p => p.mailbox === null)).toBe(true);
    expect(JSON.stringify(enriched)).toBe(before);
  });
  it('supports kind enrichment without replacing entity identity or graph state', () => {
    const input = smallFixture();
    const model = buildMapModel(input, { type: 'taskland', scope: FIXTURE_SCOPE, adapters: { task: n => ({ assetKey: 'custom.castle', label: `Label ${n.title}`, badges: ['custom'], mailbox: { count: 99 } }) } });
    expect(model.places.every(p => p.assetKey === 'custom.castle' && p.label.startsWith('Label '))).toBe(true);
    expect(model.places.filter(p => !p.parentId).every(p => p.mailbox?.count === 99)).toBe(true);
  });
  it('allocates actual hex slots', () => {
    const model = build(smallFixture());
    for (const p of model.places) {
      const r = p.z / (3 * Math.sqrt(3) / 2), q = p.x / 3 - r / 2;
      expect(r).toBeCloseTo(Math.round(r), 7); expect(q).toBeCloseTo(Math.round(q), 7);
    }
  });
  it('indexes 1000 places in under 300ms, with non-overlapping root compounds', () => {
    const input = denseFixture(1000), start = performance.now(), model = build(input), elapsed = performance.now() - start;
    console.info(`1000-place nested layout: ${elapsed.toFixed(1)}ms`);
    expect(model.places).toHaveLength(1000); expect(elapsed).toBeLessThan(300);
    const roots = model.places.filter(p => !p.parentId);
    for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++) {
      const a = roots[i]!.compoundBounds, b = roots[j]!.compoundBounds;
      expect(a.maxX <= b.minX || b.maxX <= a.minX || a.maxZ <= b.minZ || b.maxZ <= a.minZ).toBe(true);
    }
  });
  it('keeps unrelated slots stable through repeated mixed-size status changes', () => {
    let input = denseFixture(80), previous = build(input);
    const statuses = ['open', 'working', 'in_review', 'blocked'];
    for (let i = 0; i < 32; i++) {
      const id = `dense-${String(1 + i % 9).padStart(4, '0')}`;
      input = { ...input, entities: input.entities.map(n => n.id === id ? { ...n, status: statuses[Math.floor(i / 4) % 4] } : n) };
      const next = build(input, 'taskland', previous);
      for (const p of previous.places) if (p.id !== id) expect(point(next, p.id)).toEqual(point(previous, p.id));
      invariant(next); previous = next;
    }
  });
  it('grows deep unary compounds linearly instead of multiplying empty circles', () => {
    const chain = (count: number) => layoutForest(Array.from({ length: count }, (_, i) => ({ id: `n${i}`, parentId: i ? `n${i - 1}` : null, radius: 2, group: ['open', 'working', 'blocked'][i % 3]!, title: `Node ${i}` })), { groups: ['open', 'working', 'blocked'] });
    const small = chain(5).bounds, deep = chain(15).bounds;
    expect(deep.maxX - deep.minX).toBeLessThan(4 * (small.maxX - small.minX));
    expect(deep.maxZ - deep.minZ).toBeLessThan(4 * (small.maxZ - small.minZ));
  });
  it('promotes missing parents and deterministically repairs generic cycles', () => {
    const model = layoutForest([{ id: 'a', parentId: 'b', radius: 2, group: 'g', title: 'A' }, { id: 'b', parentId: 'a', radius: 2, group: 'g', title: 'B' }, { id: 'orphan', parentId: 'missing', radius: 2, group: 'g', title: 'Orphan' }]);
    expect(model.nodes.find(p => p.id === 'a')!.parentId).toBeNull();
    expect(model.warnings).toHaveLength(2);
  });
});
