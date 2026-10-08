import { describe, expect, it } from 'vitest';
import { buildMapModel, fromProjection, RUBBLE_TTL_MS } from './index';
import type { MapEntity, MapInput, MapModel, MapScope } from './types';
const at = Date.parse('2026-10-08T12:00:00Z');
const stamp = new Date(at).toISOString();
const task = (id: string, extra: Partial<MapEntity> = {}): MapEntity => ({ id, kind: 'task', title: id, status: 'open', pointsEstimate: 3, acceptance: { total: 0, completed: 0 }, ...extra });
const place = (m: MapModel, id: string) => m.places.find(p => p.id === id)!;
const point = (m: MapModel, id: string) => [place(m, id).x, place(m, id).z];
const snapshot = (scope: MapScope, entities: MapEntity[], edges: MapInput['edges'] = []): MapInput => ({ scope, entities, edges });
const scopes: MapScope[] = [{ kind: 'space', id: 'space' }, { kind: 'story', id: 'story' }];

describe.each(scopes)('Taskland real transitions at $kind scope', scope => {
  const build = (input: MapInput, previous?: MapModel, now = at) => buildMapModel(input, { type: 'taskland', scope, previous, now });
  const edit = (input: MapInput, id: string, patch: Partial<MapEntity>): MapInput => ({ ...input, entities: input.entities.map(n => n.id === id ? { ...n, ...patch } : n) });
  it('moves root compounds and child yards, preserving neighbours and descendant offsets', () => {
    let input = snapshot(scope, [task('root'), task('child', { parentId: 'root' }), task('grandchild', { parentId: 'child' }), task('sibling', { parentId: 'root' }), task('neighbour')]);
    let previous = build(input);
    for (const status of ['pulled', 'working', 'in_review', 'blocked', 'open']) {
      input = edit(input, 'root', { status });
      const next = build(input, previous);
      expect(point(next, 'neighbour')).toEqual(point(previous, 'neighbour'));
      for (const id of ['child', 'grandchild', 'sibling']) {
        expect(place(next, id).x - place(next, 'root').x).toBeCloseTo(place(previous, id).x - place(previous, 'root').x);
        expect(place(next, id).z - place(next, 'root').z).toBeCloseTo(place(previous, id).z - place(previous, 'root').z);
      }
      previous = next;
    }
    const changed = build(edit(input, 'child', { status: 'in_review' }), previous);
    for (const id of ['root', 'sibling', 'neighbour']) expect(point(changed, id)).toEqual(point(previous, id));
    expect(point(changed, 'child')).not.toEqual(point(previous, 'child'));
  });
  it('ships a child immediately, preserves its siblings, and keeps a root marker in its old lot', () => {
    let input = snapshot(scope, [task('root', { status: 'working' }), task('child', { parentId: 'root' }), task('sibling', { parentId: 'root' }), task('neighbour')]);
    const before = build(input);
    input = edit(input, 'child', { status: 'done' });
    const childDone = build(input, before);
    expect(childDone.places.some(p => p.id === 'child')).toBe(false);
    for (const id of ['root', 'sibling', 'neighbour']) expect(point(childDone, id)).toEqual(point(before, id));
    const town = buildMapModel(input, { type: 'town', scope, now: at });
    expect(town.places.map(p => p.id)).toEqual(['child']);
    input = edit(input, 'root', { status: 'done' });
    const rootDone = build(input, childDone);
    expect(place(rootDone, 'root')).toMatchObject({ role: 'shipped-marker', constructionStage: 'shipped-marker', progress: 1 });
    expect(point(rootDone, 'root')).toEqual(point(before, 'root'));
    expect(point(rootDone, 'sibling')).toEqual(point(childDone, 'sibling'));
    expect(buildMapModel(input, { type: 'town', scope }).places.every(p => p.parentId === null)).toBe(true);
    const lastDone = build(edit(input, 'sibling', { status: 'done' }), rootDone);
    expect(lastDone.places.map(p => p.id)).toEqual(['neighbour']);
    expect(point(lastDone, 'neighbour')).toEqual(point(before, 'neighbour'));
  });
  it('keeps only a foundation for a shipped nested parent with open grandchildren', () => {
    const input = snapshot(scope, [task('root'), task('child', { parentId: 'root', status: 'in_review' }), task('grandchild', { parentId: 'child' })]);
    const before = build(input), changed = edit(input, 'child', { status: 'done' }), after = build(changed, before);
    expect(place(after, 'child')).toMatchObject({ role: 'shipped-marker', mailbox: null });
    expect(point(after, 'child')).toEqual(point(before, 'child'));
    expect(point(after, 'grandchild')).toEqual(point(before, 'grandchild'));
    expect(buildMapModel(changed, { type: 'town', scope }).places.map(p => p.id)).toEqual(['child']);
    expect(build(edit(changed, 'grandchild', { status: 'done' }), after).places.map(p => p.id)).toEqual(['root']);
  });
  it('keeps rubble where it stood through reload, expires exactly at 24h and releases the last marker', () => {
    const input = snapshot(scope, [task('root', { status: 'in_review' }), task('child', { parentId: 'root', status: 'working' }), task('neighbour')]);
    const before = build(input);
    const changed = edit(edit(input, 'root', { status: 'done' }), 'child', { status: 'cancelled', cancelledAt: stamp, terminalFromStatus: 'working' });
    const rubble = build(changed, before);
    expect(point(rubble, 'child')).toEqual(point(before, 'child'));
    expect(place(rubble, 'child')).toMatchObject({ constructionStage: 'rubble', cancelledAt: stamp, rubbleExpiresAt: at + RUBBLE_TTL_MS });
    expect(rubble.nextLifecycleAt).toBe(at + RUBBLE_TTL_MS);
    const reloaded = build(changed, undefined, at + RUBBLE_TTL_MS - 1);
    expect(reloaded.places.some(p => p.id === 'child')).toBe(true);
    expect(reloaded.nextLifecycleAt).toBe(at + RUBBLE_TTL_MS);
    const expired = build(changed, rubble, at + RUBBLE_TTL_MS);
    expect(expired.places.map(p => p.id)).toEqual(['neighbour']);
    expect(expired.nextLifecycleAt).toBeNull();
    expect(point(expired, 'neighbour')).toEqual(point(before, 'neighbour'));
    expect(buildMapModel(changed, { type: 'town', scope }).places.map(p => p.id)).toEqual(['root']);
  });
  it('never fabricates cancellation evidence, uses prior-land evidence or a documented todo fallback', () => {
    const unknown = snapshot(scope, [task('root', { status: 'cancelled' })]);
    const first = build(unknown), reloaded = build(unknown, undefined, at + RUBBLE_TTL_MS * 100);
    expect(place(reloaded, 'root')).toMatchObject({ cancelledAt: null, rubbleExpiresAt: null, groupId: 'group:@roots:to_do' });
    expect(reloaded.nextLifecycleAt).toBeNull();
    expect(reloaded.warnings.join(' ')).toContain('authoritative cancellation timestamp');
    expect(place(first, 'root').badges).toContain('cancellation-time-unknown');
    expect(place(build(edit(unknown, 'root', { terminalFromStatus: 'in_review' })), 'root').groupId).toBe('group:@roots:review');
    expect(place(build(edit(unknown, 'root', { cancelledAt: '2026-10-08' })), 'root').rubbleExpiresAt).toBeNull();
  });
  it('reopen resets cancellation evidence and recancel uses the new authoritative instant', () => {
    let input = snapshot(scope, [task('root', { status: 'cancelled', cancelledAt: stamp })]);
    const first = build(input);
    const missingEvidence = build(edit(input, 'root', { cancelledAt: null }), first, at + 100);
    expect(missingEvidence.nextLifecycleAt).toBe(at + RUBBLE_TTL_MS);
    input = edit(input, 'root', { status: 'working', cancelledAt: null });
    const reopened = build(input, first, at + 100);
    expect(place(reopened, 'root')).toMatchObject({ constructionStage: 'lot', cancelledAt: null, rubbleExpiresAt: null });
    const stamp2 = new Date(at + 1000).toISOString();
    const recancelled = build(edit(input, 'root', { status: 'cancelled', cancelledAt: stamp2 }), reopened, at + 1000);
    expect(recancelled.nextLifecycleAt).toBe(at + 1000 + RUBBLE_TTL_MS);
  });
  it('keeps unrelated neighbours stable when estimates grow and child shipping shrinks a compound', () => {
    const input = snapshot(scope, [task('root', { pointsEstimate: 1 }), task('child', { parentId: 'root', pointsEstimate: 1 }), task('neighbour')]);
    const before = build(input);
    const grown = build(edit(input, 'child', { pointsEstimate: 13 }), before);
    expect(point(grown, 'neighbour')).toEqual(point(before, 'neighbour'));
    const shipped = build(edit(input, 'child', { status: 'done' }), grown);
    expect(point(shipped, 'neighbour')).toEqual(point(before, 'neighbour'));
  });
  it.each(['root', 'nested'])('replaces expired %s ancestor rubble with a neutral yard anchor until its last descendant leaves', location => {
    let input = snapshot(scope, [task('outer'), task('cancelled', { parentId: location === 'nested' ? 'outer' : null, status: 'working' }),
      task('child', { parentId: 'cancelled' }), task('grandchild', { parentId: 'child' }), task('neighbour')]);
    const before = build(input);
    input = edit(input, 'cancelled', { status: 'cancelled', cancelledAt: stamp });
    const rubble = build(input, before, at + RUBBLE_TTL_MS - 1);
    expect(place(rubble, 'cancelled').constructionStage).toBe('rubble');
    const cleared = build(input, rubble, at + RUBBLE_TTL_MS);
    expect(place(cleared, 'cancelled')).toMatchObject({ role: 'hierarchy-marker', constructionStage: 'foundation',
      assetKey: 'task.hierarchy-marker', progress: null, rubbleExpiresAt: null, rubbleRemovalNotAfter: null });
    for (const id of ['outer', 'cancelled', 'child', 'grandchild', 'neighbour']) expect(point(cleared, id)).toEqual(point(rubble, id));
    expect(place(cleared, 'child').parentId).toBe('cancelled');
    expect(place(build(edit(input, 'cancelled', { cancelledAt: null }), cleared, at + RUBBLE_TTL_MS + 1), 'cancelled').role).toBe('hierarchy-marker');
    expect(cleared.nextLifecycleAt).toBeNull();
    expect(buildMapModel(input, { type: 'town', scope }).places).toEqual([]);
    const lastLeaves = edit(edit(input, 'child', { status: 'done' }), 'grandchild', { status: 'done' });
    const done = build(lastLeaves, cleared, at + RUBBLE_TTL_MS + 1);
    expect(done.places.some(p => p.id === 'cancelled')).toBe(false);
    expect(point(done, 'neighbour')).toEqual(point(before, 'neighbour'));
  });
});

describe('construction fraction thresholds and worker lifecycle', () => {
  const scope = scopes[0]!;
  it('uses only explicitly supplied proven bounds, without presenting them as exact dates', () => {
    const editAt = at + 2 * 60 * 60 * 1000;
    const input = fromProjection({ entities: [{ id: 'root', kind: 'task', status: 'cancelled', cancelledNotAfter: new Date(editAt).toISOString(), updatedAt: new Date(editAt).toISOString() }], edges: [] }, scope);
    const before = buildMapModel(input, { type: 'taskland', scope, now: at + RUBBLE_TTL_MS });
    expect(place(before, 'root')).toMatchObject({ cancelledAt: null, rubbleExpiresAt: null, rubbleRemovalNotAfter: editAt + RUBBLE_TTL_MS });
    expect(before.nextLifecycleAt).toBe(editAt + RUBBLE_TTL_MS);
    expect(before.warnings.join(' ')).toContain('exact rubble expiry is unknown');
    expect(buildMapModel(input, { type: 'taskland', scope, now: editAt + RUBBLE_TTL_MS - 1 }).places).toHaveLength(1);
    expect(buildMapModel(input, { type: 'taskland', scope, now: editAt + RUBBLE_TTL_MS }).places).toEqual([]);
    const old = fromProjection({ entities: [{ id: 'root', kind: 'task', status: 'cancelled', cancelledNotAfter: '2026-10-01T00:00:00Z' }], edges: [] }, scope);
    expect(buildMapModel(old, { type: 'taskland', scope, now: at }).places).toEqual([]);
    const unproven = fromProjection({ entities: [{ id: 'root', kind: 'task', status: 'cancelled', updatedAt: '2026-10-01T00:00:00Z' }], edges: [] }, scope);
    expect(unproven.entities[0]?.cancelledNotAfter).toBeNull();
    const legacy = buildMapModel(unproven, { type: 'taskland', scope, now: at });
    expect(legacy.places).toHaveLength(1);
    expect(legacy.nextLifecycleAt).toBeNull();
  });
  it('exact cancellation ignores later edits, and reopening clears upper-bound removal state', () => {
    const input = fromProjection({ entities: [{ id: 'root', kind: 'task', state: { workStatus: 'cancelled', statusChangedAt: stamp }, updatedAt: new Date(at + 2 * 60 * 60 * 1000).toISOString() }], edges: [] }, scope);
    expect(input.entities[0]?.cancelledNotAfter).toBeNull();
    const before = buildMapModel(input, { type: 'taskland', scope, now: at });
    expect(place(before, 'root')).toMatchObject({ cancelledAt: stamp, rubbleExpiresAt: at + RUBBLE_TTL_MS, rubbleRemovalNotAfter: null });
    expect(buildMapModel(input, { type: 'taskland', scope, now: at + RUBBLE_TTL_MS }).places).toEqual([]);
    const reopened = fromProjection({ entities: [{ id: 'root', kind: 'task', state: { workStatus: 'working' }, updatedAt: stamp }], edges: [] }, scope);
    expect(reopened.entities[0]?.cancelledNotAfter).toBeNull();
    expect(place(buildMapModel(reopened, { type: 'taskland', scope, previous: before, now: at + 1 }), 'root')).toMatchObject({ cancelledAt: null, rubbleExpiresAt: null, rubbleRemovalNotAfter: null });
  });
  it.each([[0, 3, 'lot'], [1, 3, 'foundation'], [2, 3, 'scaffolding'], [67, 100, 'walls'], [999, 1000, 'walls'], [3, 3, 'topped-out']])('uses exact %s/%s fraction for stage %s', (completed, total, constructionStage) => {
    const model = buildMapModel(snapshot(scope, [task('root', { acceptance: { completed: Number(completed), total: Number(total) } })]), { type: 'taskland', scope });
    expect(place(model, 'root').constructionStage).toBe(constructionStage);
  });
  it('ends, completes, resets and resumes claims without changing robot identity or masking terminal evidence', () => {
    const entities = [task('root', { status: 'blocked' }), { id: 'session', kind: 'work_session', title: 'Session', outcome: 'open', processState: 'running', live: true }];
    const edge = { id: 'claim', type: 'working_on', fromId: 'session', toId: 'root', status: 'working' };
    const make = (sessionPatch: Partial<MapEntity> = {}, claimPatch = {}) => buildMapModel(snapshot(scope, [entities[0]!, { ...entities[1]!, ...sessionPatch }], [{ ...edge, ...claimPatch }]), { type: 'taskland', scope });
    expect(make().robots[0]).toMatchObject({ id: 'robot:claim', pose: 'blocked' });
    expect(make({}, { endedAt: stamp }).robots).toEqual([]);
    expect(make({ outcome: 'completed', processState: 'failed' }).robots).toEqual([]);
    expect(make({ outcome: 'open', endedKind: 'completed', processState: 'idle' }).robots[0]?.id).toBe('robot:claim');
    expect(make({ outcome: 'open', endedKind: 'failed', processState: 'running' }).robots[0]?.id).toBe('robot:claim');
    expect(make({ outcome: 'open', processState: 'failed' }).robots).toEqual([]);
    expect(make({ live: false }).robots).toEqual([]);
    expect(make({}, { status: 'waiting' }).robots).toHaveLength(1);
    expect(make({}, { status: 'ended' }).robots).toEqual([]);
    const cancelled = buildMapModel(snapshot(scope, [task('root', { status: 'cancelled' }), entities[1]!], [edge]), { type: 'taskland', scope });
    expect(cancelled.robots).toEqual([]);
  });
});
