import { describe, expect, it } from 'vitest';
import { SPAWN_SELECTION_GROUP_LIMIT, type EntityId } from '@tm8/contract';

import {
  composeSelection,
  defaultRow,
  groupDiff,
  groupIds,
  groupLock,
  manualOutcome,
  NO_SELECTION_EDITS,
  toggleRow,
  type GroupOutcome,
  type LaunchContextRow,
  type LaunchGroupDefaults,
  type LaunchGroupEdit,
} from './launch-selection';

const id = (n: string) => n as EntityId;
const row = (n: string): LaunchContextRow => ({ id: id(n), kind: 'doc', title: n, text: null, derived: false, via: 'linked' });
const ready = (...ids: string[]): LaunchGroupDefaults => ({ status: 'ready', rows: ids.map(row), total: ids.length });
const NONE: LaunchGroupEdit = { removed: [], added: [] };

function apply(defaults: LaunchGroupDefaults, ...ids: string[]): LaunchGroupEdit {
  let edit = NONE;
  for (const n of ids) {
    const result = toggleRow(defaults, edit, id(n));
    if ('refused' in result) throw new Error(result.refused);
    edit = result.edit;
  }
  return edit;
}

const OMITTED: Record<'memories' | 'skills' | 'references', GroupOutcome> = {
  memories: { omit: 'not-asked' },
  skills: { omit: 'not-asked' },
  references: { omit: 'not-asked' },
};

describe('a group edit is a diff against the defaults', () => {
  it('an untouched group is its defaults, and is omitted', () => {
    const defaults = ready('a', 'b');
    expect(groupIds(defaults, NONE)).toEqual(['a', 'b']);
    expect(groupDiff(defaults, NONE).line).toBeNull();
    expect(manualOutcome(defaults, NONE)).toEqual({ omit: 'not-asked' });
  });

  it('unticking a default is a removal, stated as a diff, and the group is sent exact', () => {
    const defaults = ready('a', 'b', 'c');
    const edit = apply(defaults, 'a', 'c');
    expect(groupDiff(defaults, edit)).toEqual({ removed: 2, added: 0, line: '−2 defaults removed' });
    expect(manualOutcome(defaults, edit)).toEqual({ send: ['b'] });
  });

  it('adding keeps every default and appends in tick order', () => {
    const defaults = ready('a', 'b');
    const edit = apply(defaults, 'z', 'y');
    expect(groupDiff(defaults, edit).line).toBe('+2 added');
    expect(manualOutcome(defaults, edit)).toEqual({ send: ['a', 'b', 'z', 'y'] });
  });

  it('re-ticking a removal restores the defaults, and the group is omitted again', () => {
    const defaults = ready('a', 'b');
    const edit = apply(defaults, 'a', 'a');
    expect(groupDiff(defaults, edit).line).toBeNull();
    expect(manualOutcome(defaults, edit)).toEqual({ omit: 'not-asked' });
  });

  it('removing every default sends the EMPTY exact set — a real decision, not an omission', () => {
    const defaults = ready('a');
    const edit = apply(defaults, 'a');
    expect(manualOutcome(defaults, edit)).toEqual({ send: [] });
    expect(groupDiff(defaults, edit).line).toBe('−1 default removed');
  });

  it('a teammate change re-applies the diff: a stale removal falls away, an addition stays', () => {
    const before = ready('a', 'b');
    const edit = apply(before, 'a', 'z');
    const after = ready('b', 'c');
    expect(groupDiff(after, edit)).toEqual({ removed: 0, added: 1, line: '+1 added' });
    expect(manualOutcome(after, edit)).toEqual({ send: ['b', 'c', 'z'] });
  });

  it('an addition that is a default of the new teammate is simply a default', () => {
    const edit = apply(ready('a'), 'b');
    expect(manualOutcome(ready('a', 'b'), edit)).toEqual({ omit: 'not-asked' });
  });
});

describe('a group whose defaults are not known cannot be edited, and is never sent', () => {
  it('loading and unknown lock the group', () => {
    expect(groupLock({ status: 'loading' })).toMatch(/Reading/);
    const unknown: LaunchGroupDefaults = { status: 'unknown', reason: 'no node answer' };
    expect(groupLock(unknown)).toBe('no node answer');
    expect(toggleRow(unknown, NONE, id('a'))).toEqual({ refused: 'no node answer' });
    expect(manualOutcome(unknown, { removed: [], added: [id('a')] })).toEqual({ omit: 'not-asked' });
  });
});

describe('the 240 ceiling', () => {
  const many = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}${String(i)}`);

  it('refuses ticking past the ceiling at the row', () => {
    const defaults = ready(...many(SPAWN_SELECTION_GROUP_LIMIT, 'd'));
    const result = toggleRow(defaults, NONE, id('extra'));
    expect(result).toEqual({ refused: expect.stringMatching(/at most 240/) });
  });

  it('allows a swap at the ceiling: untick one, then tick another', () => {
    const defaults = ready(...many(SPAWN_SELECTION_GROUP_LIMIT, 'd'));
    const edit = apply(defaults, 'd0', 'extra');
    expect(groupIds(defaults, edit)).toHaveLength(SPAWN_SELECTION_GROUP_LIMIT);
  });

  it('locks a group whose defaults are over the ceiling, and says so', () => {
    const over: LaunchGroupDefaults = { status: 'ready', rows: many(SPAWN_SELECTION_GROUP_LIMIT, 'd').map(row), total: 300 };
    expect(groupLock(over)).toMatch(/300 defaults.*at most 240/);
    expect(manualOutcome(over, { removed: [id('d0')], added: [] })).toEqual({ omit: 'not-asked' });
  });

  it('composeSelection never sends an over-ceiling set, whatever the caller built', () => {
    const huge = { send: many(SPAWN_SELECTION_GROUP_LIMIT + 1, 'x').map(id) };
    expect(composeSelection({ ...OMITTED, skills: huge })).toEqual({
      selectionReasons: { memories: 'not-asked', skills: 'not-asked', references: 'not-asked' },
    });
  });
});

describe('composeSelection — per-group send', () => {
  it('no group edited: no `selection`, and every group says not-asked', () => {
    expect(composeSelection(OMITTED)).toEqual({
      selectionReasons: { memories: 'not-asked', skills: 'not-asked', references: 'not-asked' },
    });
  });

  it('only the edited group is sent; the others keep their defaults with a reason', () => {
    const fields = composeSelection({ ...OMITTED, references: { send: [id('r1')] } });
    expect(fields).toEqual({
      selection: { referenceIds: ['r1'] },
      selectionReasons: { memories: 'not-asked', skills: 'not-asked' },
    });
  });

  it('Jev’s outcome replaces the sheet’s for the groups it names', () => {
    const fields = composeSelection(
      { ...OMITTED, memories: { send: [id('mine')] }, references: { send: [] } },
      { memories: { send: [id('jev-a')] }, skills: { omit: 'jev-failed' } },
    );
    expect(fields).toEqual({
      selection: { memoryIds: ['jev-a'], referenceIds: [] },
      selectionReasons: { skills: 'jev-failed' },
    });
  });

  it('a pending Jev group is omitted as jev-pending while the answered one goes', () => {
    const fields = composeSelection(OMITTED, { memories: { omit: 'jev-pending' }, skills: { send: [id('s1')] } });
    expect(fields.selection).toEqual({ skillIds: ['s1'] });
    expect(fields.selectionReasons).toEqual({ memories: 'jev-pending', references: 'not-asked' });
  });

  it('out of Jev mode a failed Jev group explains a defaulted group, never an edited one', () => {
    const fields = composeSelection(
      { ...OMITTED, skills: { send: [id('s1')] } },
      {},
      { memories: 'jev-failed', skills: 'jev-failed' },
    );
    expect(fields).toEqual({
      selection: { skillIds: ['s1'] },
      selectionReasons: { memories: 'jev-failed', references: 'not-asked' },
    });
  });

  it('never names a group in both `selection` and `selectionReasons` (the node refuses that)', () => {
    const fields = composeSelection({
      memories: { send: [id('m')] },
      skills: { send: [] },
      references: { omit: 'not-asked' },
    }, {}, { memories: 'jev-failed' });
    const named = Object.keys(fields.selection ?? {}).map((key) => ({ memoryIds: 'memories', skillIds: 'skills', referenceIds: 'references' } as Record<string, string>)[key]);
    expect(named).toEqual(['memories', 'skills']);
    for (const group of named) expect(fields.selectionReasons).not.toHaveProperty(group!);
  });
});

describe('defaultRow — header text', () => {
  it('labels non-authored header text as derived, and authored as not', () => {
    const base = { entityId: 'e1', kind: 'doc', title: 'Spec', via: 'linked' as const };
    expect(defaultRow({ ...base, headerText: 'use when…', headerSource: 'authored' }).derived).toBe(false);
    expect(defaultRow({ ...base, headerText: 'a summary', headerSource: 'derived' }).derived).toBe(true);
    expect(defaultRow({ ...base, headerText: null, headerSource: null }).derived).toBe(false);
  });
});

it('NO_SELECTION_EDITS covers the three groups', () => {
  expect(Object.keys(NO_SELECTION_EDITS).sort()).toEqual(['memories', 'references', 'skills']);
});
