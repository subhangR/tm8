import { describe, expect, it } from 'vitest';
import { buildMapModel, type MapInput, type MapScope } from '../map-model';
import { shippingYardCount, tasklandLabels, tasklandPlotDetail } from './TasklandVisuals';

const scopes: MapScope[] = [{ kind: 'story', id: 'story' }, { kind: 'space', id: 'space' }];
function input(scope: MapScope): MapInput {
  return { scope, entities: [
    { id: 'root', kind: 'task', title: 'Root', status: 'working', pointsEstimate: 3, progress: .6, mailbox: { count: 2 } },
    { id: 'child', kind: 'task', title: 'Child', parentId: 'root', status: 'blocked', pendingAttention: 1, mailbox: { count: 3, approx: true } },
    { id: 'done-child', kind: 'task', title: 'Done child', parentId: 'root', status: 'done', pointsEstimate: 2 },
    { id: 'cancelled', kind: 'task', title: 'Cancelled', status: 'cancelled' },
    { id: 'output', kind: 'artifact', title: 'Output' },
  ], edges: [{ id: 'produces', type: 'produces', fromId: 'done-child', toId: 'output' }] };
}
describe.each(scopes)('Taskland cues at $kind scope', scope => {
  it('exposes model-owned nested yards, root subtree totals and the missing estimate', () => {
    const model = buildMapModel(input(scope), { scope, type: 'taskland' });
    const labels = tasklandLabels(model);
    expect(labels.filter(l => l.cue === 'mailbox')).toHaveLength(2);
    expect(labels.find(l => l.id === 'root:mailbox')?.detail).toBe('≈5 subtree messages · 1 attention');
    expect(labels.some(l => l.id === 'child:mailbox')).toBe(false);
    expect(labels.filter(l => l.cue === 'surveyor').map(l => l.entityId)).toEqual(['child']);
    expect(labels.some(l => l.title === 'District · Construction yard')).toBe(true);
    expect(labels.some(l => l.title === 'Mini yard · Paused yard')).toBe(true);
    const child = model.places.find(p => p.entityId === 'child')!;
    expect(tasklandPlotDetail(child)).toContain('Nested yard');
  });
  it('counts independently completed children and their output in the scoped Shipping Yard', () => {
    const model = buildMapModel(input(scope), { scope, type: 'town' });
    expect(model.places.map(p => p.entityId).sort()).toEqual(['done-child', 'output']);
    expect(shippingYardCount(model)).toBe(2);
    expect(tasklandLabels(model)[0]?.detail).toBe('2 waiting for placement');
    expect(tasklandLabels(model)[0]?.cue).toBe('shipping');
    // A placed object remains in Town, but it is no longer waiting at the gate.
    model.groups = model.groups.map(g => ({ ...g, placeIds: g.placeIds.filter(id => id !== 'output') }));
    expect(shippingYardCount(model)).toBe(1);
  });
  it('keeps a done root marker while an open child builds, without adding cancelled work to shipping', () => {
    const snapshot = input(scope);
    snapshot.entities = snapshot.entities.map(e => e.id === 'root' ? { ...e, status: 'done' } : e);
    const model = buildMapModel(snapshot, { scope, type: 'taskland' });
    const root = model.places.find(p => p.entityId === 'root')!;
    expect(tasklandPlotDetail(root)).toBe('Shipped · children still building');
    expect(tasklandLabels(model).some(l => l.id === 'root:surveyor')).toBe(false);
    const rubble = model.places.find(p => p.entityId === 'cancelled')!;
    expect(tasklandPlotDetail(rubble)).toContain('Cancelled');
    const town = buildMapModel(snapshot, { scope, type: 'town' });
    expect(shippingYardCount(town)).toBe(3);
    expect(town.places.some(p => p.entityId === 'cancelled')).toBe(false);
  });
});
it('does not introduce construction labels on the other maps, and labels empty shipping explicitly', () => {
  const scope = scopes[0]!;
  const snapshot = { scope, entities: [], edges: [] };
  expect(tasklandLabels(buildMapModel(snapshot, { scope, type: 'office' }))).toEqual([]);
  expect(tasklandLabels(buildMapModel(snapshot, { scope, type: 'town' }))[0]?.detail).toBe('0 waiting for placement');
});
it('does not round progress up across construction thresholds', () => {
  const scope = scopes[0]!;
  const place = buildMapModel(input(scope), { scope, type: 'taskland' }).places[0]!;
  expect(tasklandPlotDetail({ ...place, progress: 2 / 3, constructionStage: 'scaffolding' })).toContain('66% · scaffolding');
  expect(tasklandPlotDetail({ ...place, progress: .999, constructionStage: 'walls' })).toContain('99% · walls');
});
