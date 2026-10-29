import { describe, expect, it } from 'vitest';
import type { EntityId, EntitySummary } from '@tm8/contract';
import { createJournal } from './journal.js';
import { summary } from './test-support.js';

function lookupFrom(entities: Record<EntityId, EntitySummary>) {
  return (id: EntityId) => entities[id];
}

describe('createJournal', () => {
  it('captures prior summaries, including was-absent', () => {
    const j = createJournal();
    const before = summary('t1', { title: 'before' });
    j.applyOptimistic('cm1', [summary('t1', { title: 'after' }), summary('t2')], lookupFrom({ t1: before }));

    const instructions = j.rollback('cm1');
    expect(instructions).toContainEqual({ kind: 'restore', summary: before });
    expect(instructions).toContainEqual({ kind: 'remove', id: 't2' });
    expect(instructions).toHaveLength(2);
  });

  it('first capture wins when the same clientMutationId patches an entity twice', () => {
    const j = createJournal();
    const original = summary('t1', { title: 'original' });
    j.applyOptimistic('cm1', [summary('t1', { title: 'step 1' })], lookupFrom({ t1: original }));
    // Second optimistic pass sees its own first patch as "current" — the
    // journal must keep the ORIGINAL capture, not the intermediate.
    j.applyOptimistic('cm1', [summary('t1', { title: 'step 2' })], lookupFrom({ t1: summary('t1', { title: 'step 1' }) }));

    expect(j.rollback('cm1')).toEqual([{ kind: 'restore', summary: original }]);
  });

  it('widens the capture set on a second applyOptimistic with new ids', () => {
    const j = createJournal();
    j.applyOptimistic('cm1', [summary('t1')], lookupFrom({}));
    j.applyOptimistic('cm1', [summary('t2')], lookupFrom({}));
    const instructions = j.rollback('cm1');
    expect(instructions).toContainEqual({ kind: 'remove', id: 't1' });
    expect(instructions).toContainEqual({ kind: 'remove', id: 't2' });
  });

  it('reconcile drops the entry; double reconcile is a no-op', () => {
    const j = createJournal();
    j.applyOptimistic('cm1', [summary('t1')], lookupFrom({}));
    expect(j.has('cm1')).toBe(true);
    expect(j.reconcile('cm1')).toBe(true);
    expect(j.has('cm1')).toBe(false);
    expect(j.reconcile('cm1')).toBe(false);
  });

  it('rollback after reconcile returns no instructions (authoritative state won)', () => {
    const j = createJournal();
    j.applyOptimistic('cm1', [summary('t1')], lookupFrom({}));
    j.reconcile('cm1');
    expect(j.rollback('cm1')).toEqual([]);
  });

  it('rollback of an unknown clientMutationId returns no instructions', () => {
    const j = createJournal();
    expect(j.rollback('never-journaled')).toEqual([]);
  });

  it('rollback drops the entry (a second rollback is a no-op)', () => {
    const j = createJournal();
    j.applyOptimistic('cm1', [summary('t1')], lookupFrom({}));
    expect(j.rollback('cm1')).toHaveLength(1);
    expect(j.rollback('cm1')).toEqual([]);
  });

  it('tracks pending ids and clears', () => {
    const j = createJournal();
    j.applyOptimistic('cm1', [summary('t1')], lookupFrom({}));
    j.applyOptimistic('cm2', [summary('t2')], lookupFrom({}));
    expect(j.pending()).toEqual(['cm1', 'cm2']);
    j.clear();
    expect(j.pending()).toEqual([]);
    expect(j.has('cm1')).toBe(false);
  });
});
