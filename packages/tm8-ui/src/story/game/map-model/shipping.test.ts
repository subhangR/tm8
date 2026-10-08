import { describe, expect, it } from 'vitest';
import { buildMapModel } from './index';
import type { MapEntity, MapInput, MapModel } from './types';
const scope = { kind: 'space' as const, id: 'space' };
const task = (id: string, extra: Partial<MapEntity> = {}): MapEntity => ({ id, kind: 'task', title: id, status: 'done', ...extra });
const place = (m: MapModel, id: string) => m.places.find(p => p.id === id)!;
const build = (input: MapInput, previous?: MapModel, type: 'town' | 'taskland' = 'town') => buildMapModel(input, { type, scope, previous, now: Date.parse('2026-10-08T12:00:00Z') });

describe('independent immediate shipping and persisted Town boundary', () => {
  it('admits done tasks, completed sessions and live produced items as independent roots', () => {
    const input: MapInput = { scope, entities: [task('parent'), task('child', { parentId: 'parent' }),
      task('cancelled', { status: 'cancelled' }), task('open', { status: 'open' }),
      { id: 'session', kind: 'work_session', title: 'Session', outcome: 'completed', processState: 'failed' },
      { id: 'reopened', kind: 'work_session', title: 'Reopened', outcome: 'open', endedKind: 'completed', processState: 'running' },
      { id: 'item', kind: 'doc', title: 'Item' }, { id: 'expired-item', kind: 'file', title: 'Ended output' },
      { id: 'input', kind: 'artifact', title: 'Input' }], edges: [
      { id: 'produced', type: 'produces', fromId: 'parent', toId: 'item' },
      { id: 'ended', type: 'produces', fromId: 'parent', toId: 'expired-item', endedAt: '2026-10-08T00:00:00Z' },
      { id: 'reference', type: 'attached_to', fromId: 'input', toId: 'parent' },
      { id: 'cancelled-output', type: 'produces', fromId: 'cancelled', toId: 'input' },
    ] };
    const model = build(input);
    expect(model.places.map(p => p.id).sort()).toEqual(['child', 'item', 'parent', 'session']);
    expect(model.places.every(p => p.parentId === null && p.groupId === 'group:@roots:shipping-yard')).toBe(true);
  });
  it('honors finite persisted positions, keeps unplaced slots clear, and counts only yard buildings', () => {
    const input: MapInput = { scope, entities: [task('placed'), task('unplaced'), task('other')], edges: [] };
    const before = build(input), target = place(before, 'unplaced');
    const persisted = { ...input, townPlacements: [{ entityId: 'placed', x: target.x, z: target.z, actorId: 'human', layer: 'human' }] };
    const original = JSON.stringify(persisted);
    const model = build(persisted, before);
    expect(place(model, 'placed')).toMatchObject({ x: target.x, z: target.z, groupId: 'group:@roots:town' });
    expect(model.groups.find(g => g.key === 'shipping-yard')?.placeIds.sort()).toEqual(['other', 'unplaced']);
    expect(model.shippingYard).toEqual({ position: { x: 0, z: -12 }, waitingIds: ['other', 'unplaced'] });
    expect(model.bounds.minZ).toBeLessThanOrEqual(-16);
    expect(place(model, 'unplaced').x).not.toBe(target.x);
    for (const p of model.places) for (const other of model.places) if (p.id !== other.id) {
      expect(Math.hypot(p.x - other.x, p.z - other.z)).toBeGreaterThanOrEqual(p.radius + other.radius);
    }
    expect(build(persisted, model).places).toEqual(model.places);
    expect(JSON.stringify(persisted)).toBe(original);
  });
  it('ignores placements for reopened or unadmitted ids without mutating persisted state', () => {
    const placements = [{ entityId: 'root', x: 99, z: 101, actorId: 'member', layer: 'human' }, { entityId: 'outside', x: 0, z: 0 }];
    const input: MapInput = { scope, entities: [task('root')], edges: [], townPlacements: placements };
    const placed = build(input);
    expect(place(placed, 'root').x).toBe(99);
    const reopened = build({ ...input, entities: [task('root', { status: 'working' })] }, placed);
    expect(reopened.places).toEqual([]);
    expect(reopened.shippingYard?.waitingIds).toEqual([]);
    expect(input.townPlacements).toEqual(placements);
    expect(place(build(input, reopened), 'root')).toMatchObject({ x: 99, z: 101 });
    expect(build(input, reopened).shippingYard?.position).toEqual(placed.shippingYard?.position);
    expect(place(build(input, undefined, 'taskland'), 'root')).toBeUndefined();
  });
  it('ignores invalid coordinates with a warning and never applies Town positions to Taskland', () => {
    const input: MapInput = { scope, entities: [task('root', { status: 'working' }), task('done')], edges: [],
      townPlacements: [{ entityId: 'root', x: 99, z: 101 }, { entityId: 'done', x: NaN, z: 0 }] };
    const town = build(input);
    expect(place(town, 'done').groupId).toBe('group:@roots:shipping-yard');
    expect(town.warnings.join(' ')).toContain('Invalid town placement');
    expect(town.shippingYard?.waitingIds).toEqual(['done']);
    expect(build(input, undefined, 'taskland').places).toEqual(build({ ...input, townPlacements: [] }, undefined, 'taskland').places);
  });
  it('aggregates ROOT mailbox over shipped and expired descendants and preserves adapter subtree totals', () => {
    const input: MapInput = { scope, entities: [task('root', { status: 'working', mailbox: { count: 2, basis: 'unread' } }),
      task('done', { parentId: 'root', mailbox: { count: 3, basis: 'unread' } }),
      task('expired', { parentId: 'root', status: 'cancelled', cancelledAt: '2026-10-01T00:00:00Z', mailbox: { count: 5, basis: 'unread' } })], edges: [] };
    const before = JSON.stringify(input), model = build(input, undefined, 'taskland');
    expect(model.places).toHaveLength(1);
    expect(place(model, 'root').mailbox).toMatchObject({ count: 10, basis: 'unread' });
    const enriched = buildMapModel(input, { type: 'taskland', scope, adapters: { task: () => ({ mailbox: { count: 7, basis: 'unread' } }) } });
    expect(place(enriched, 'root').mailbox).toMatchObject({ count: 15, basis: 'unread' });
    const mixed = build({ ...input, entities: input.entities.map(n => n.id === 'done' ? { ...n, mailbox: { count: 3, basis: 'messages' as const } } : n) }, undefined, 'taskland');
    expect(place(mixed, 'root').mailbox).toMatchObject({ count: 10, basis: 'messages', approx: true });
    expect(JSON.stringify(input)).toBe(before);
  });
});
