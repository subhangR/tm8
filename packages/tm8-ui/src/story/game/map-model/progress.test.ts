import { describe, expect, it } from 'vitest';
import { fromProjection, taskConstructionProgress } from './index';
import type { MapEntity } from './types';
const task = (id: string, extra: Partial<MapEntity> = {}): MapEntity => ({ id, kind: 'task', title: id, status: 'open', ...extra });
const rolled = (entities: MapEntity[], id = 'root') => taskConstructionProgress(entities).byId.get(id)!;

describe('Design Rules points-weighted construction', () => {
  it('weights own criteria and live child subtrees, without reusing server percent', () => {
    const result = rolled([
      task('root', { pointsEstimate: 8, acceptance: { total: 4, completed: 1 }, progress: .99 }),
      task('done', { parentId: 'root', status: 'done', pointsEstimate: 3, acceptance: { total: 4, completed: 0 } }),
      task('open', { parentId: 'root', pointsEstimate: 5, acceptance: { total: 2, completed: 1 } }),
    ]);
    expect(result).toMatchObject({ weight: 8, subtreeWeight: 16, own: .25, sizeBucket: 13 });
    expect(result.progress).toBe((8 * .25 + 3 + 5 * .5) / 16);
  });
  it('excludes a criteria-free parent own weight from progress while retaining it in size', () => {
    const entities = [task('root', { pointsEstimate: 13, acceptance: { total: 0, completed: 0 } }),
      task('child', { parentId: 'root', pointsEstimate: 2, status: 'done' }),
      task('other', { parentId: 'root', pointsEstimate: 3 })];
    expect(rolled(entities)).toMatchObject({ subtreeWeight: 18, progress: 2 / 5, own: null });
    entities[0]!.acceptance = { total: 3, completed: 0 };
    expect(rolled(entities).progress).toBe(2 / 18);
  });
  it('makes done p=1 with open descendants and excludes cancelled subtrees entirely', () => {
    const entities = [task('root', { pointsEstimate: 2 }), task('done', { parentId: 'root', status: 'done', pointsEstimate: 3 }),
      task('open', { parentId: 'done', pointsEstimate: 5 }), task('rubble', { parentId: 'root', status: 'cancelled', pointsEstimate: 13 }),
      task('excluded', { parentId: 'rubble', status: 'done', pointsEstimate: 13 })];
    const result = taskConstructionProgress(entities).byId;
    expect(result.get('done')).toMatchObject({ progress: 1, subtreeWeight: 8 });
    expect(result.get('rubble')).toMatchObject({ progress: null, subtreeWeight: 0 });
    expect(result.get('root')).toMatchObject({ progress: 1, subtreeWeight: 10 });
  });
  it('defaults missing estimates to one and leaves an empty leaf at zero', () => {
    expect(rolled([task('root')])).toMatchObject({ weight: 1, subtreeWeight: 1, progress: 0, estimateMissing: true });
    expect(rolled([task('root', { status: 'done' })])).toMatchObject({ progress: 1 });
  });
  it('honors zero estimates and has a finite zero-denominator result', () => {
    expect(rolled([task('root', { pointsEstimate: 0 })])).toMatchObject({ weight: 0, subtreeWeight: 0, progress: 0, sizeBucket: 1, estimateMissing: false });
    expect(rolled([task('root', { pointsEstimate: 0, status: 'done' })]).progress).toBe(1);
    expect(rolled([task('root', { pointsEstimate: 0, acceptance: { total: 2, completed: 1 } })]).progress).toBe(.5);
  });
  it.each([[1, 1], [1.1, 2], [2.1, 3], [4, 5], [6, 8], [9, 13], [99, 13]])('uses Fibonacci size bucket for %s points', (weight, sizeBucket) => {
    expect(rolled([task('root', { pointsEstimate: weight })]).sizeBucket).toBe(sizeBucket);
  });
  it('recovers a hidden estimate only with guaranteed complete children', () => {
    const entities = [task('root', { estimateTent: false, subtreeWeight: 13, progress: .92, acceptance: { total: 4, completed: 1 } }),
      task('child', { parentId: 'root', estimateTent: false, subtreeWeight: 5, status: 'done' })];
    const complete = taskConstructionProgress(entities, true);
    expect(complete.byId.get('root')).toMatchObject({ weight: 8, subtreeWeight: 13, progress: 7 / 13, estimateMissing: false });
    expect(complete.warnings).toEqual([]);
    const partial = taskConstructionProgress(entities);
    expect(partial.byId.get('root')).toMatchObject({ subtreeWeight: 13, progress: .92 });
    expect(partial.warnings.join(' ')).toContain('fallback');
  });
  it('projects task summary counts, detail criteria and timestamp evidence without inventing it', () => {
    const input = fromProjection({ entities: [
      { id: 'summary', kind: 'task', state: { status: 'working', acceptance: { total: 3, completed: 1 }, progress: { percent: 33, own: 1 / 3, size: 8, tent: false } } },
      { id: 'detail', kind: 'task', content: { acceptanceCriteria: [{ id: 'one', done: true }, { id: 'two', done: false }], pointsEstimate: 3 } },
      { id: 'cancelled', kind: 'task', status: 'cancelled', updatedAt: '2026-10-08T12:00:00Z', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'evidence', kind: 'task', status: 'cancelled', cancelledAt: '2026-10-08T11:00:00Z', terminalFromStatus: 'in_review' },
      { id: 'dto', kind: 'task', version: 9, updatedAt: '2026-10-08T12:00:00Z', state: { workStatus: 'cancelled', statusChangedAt: '2026-10-08T11:00:00Z' } },
      { id: 'open-dto', kind: 'task', state: { workStatus: 'working', statusChangedAt: '2026-10-08T11:00:00Z' } },
    ], edges: [] });
    expect(input.entities[0]).toMatchObject({ acceptance: { total: 3, completed: 1 }, ownProgress: 1 / 3, estimateTent: false, subtreeWeight: 8 });
    expect(input.entities[1]).toMatchObject({ acceptance: { total: 2, completed: 1 }, pointsEstimate: 3 });
    expect(input.entities[2]?.cancelledAt).toBeNull();
    expect(input.entities[3]).toMatchObject({ cancelledAt: '2026-10-08T11:00:00Z', terminalFromStatus: 'in_review' });
    expect(input.entities[4]).toMatchObject({ status: 'cancelled', cancelledAt: '2026-10-08T11:00:00Z', version: 9, updatedAt: '2026-10-08T12:00:00Z' });
    expect(input.entities[5]?.cancelledAt).toBeNull();
  });
});
