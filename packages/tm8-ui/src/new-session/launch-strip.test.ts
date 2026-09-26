/**
 * The v3 strip as a pure view over the three selection groups: order, whose
 * each row is, the amber / purple chip facts, and folding several Attach
 * picks into one edit per group.
 */
import { describe, expect, it } from 'vitest';
import type { EntityId } from '@tm8/contract';

import { NO_SELECTION_EDITS, readyDefaults, type LaunchContextRow } from '../domain/launch-selection';
import { LAUNCH_DEFAULTS } from '../views/launch-fixtures';
import { addToEdits, buildStrip, stripChipTitle, stripKindOf } from './launch-strip';

const defaults = {
  memories: readyDefaults(LAUNCH_DEFAULTS.memories),
  skills: readyDefaults(LAUNCH_DEFAULTS.skills),
  references: readyDefaults(LAUNCH_DEFAULTS.references),
};
const row = (id: string, kind: string): LaunchContextRow => ({ id: id as EntityId, kind, title: id, text: null, derived: false, via: null });
const NONE = { memories: [], skills: [], references: [] };

describe('buildStrip', () => {
  it('orders groups files first, drops empty ones, and splits references by kind', () => {
    const strip = buildStrip({ defaults, edits: NO_SELECTION_EDITS, added: NONE });
    expect(strip.map((g) => g.def.kind)).toEqual(['file', 'memory', 'skill', 'doc']);
    expect(strip.every((g) => !g.edited && g.jev === 0)).toBe(true);
  });

  it('an unticked default stays visible and makes its group edited', () => {
    const edits = { ...NO_SELECTION_EDITS, references: { removed: ['ent-doc-spec' as EntityId], added: [] } };
    const doc = buildStrip({ defaults, edits, added: NONE }).find((g) => g.def.kind === 'doc')!;
    expect(doc.rows[0]!.ticked).toBe(false);
    expect(doc.edited).toBe(true);
    expect(doc.yours).toBe(0);
    expect(stripChipTitle(doc)).toBe('0 yours · you removed 1 · context index entries');
  });

  it('Jev’s carried adds count as ✦, not yours; a group of only Jev’s is not edited', () => {
    const edits = { ...NO_SELECTION_EDITS, references: { removed: [], added: ['t-2' as EntityId] } };
    const strip = buildStrip({
      defaults, edits, added: { ...NONE, references: [row('t-2', 'task')] },
      jev: { carried: { references: { added: ['t-2' as EntityId], removed: [] } }, why: { 't-2': 'useful · 2.1' } },
    });
    const task = strip.find((g) => g.def.kind === 'task')!;
    expect(task).toMatchObject({ yours: 0, jev: 1, edited: false });
    expect(task.rows[0]).toMatchObject({ source: 'jev', jev: 'picked', jevWhy: 'useful · 2.1' });
  });

  it('a default Jev left out is tagged, not counted as your removal', () => {
    const edits = { ...NO_SELECTION_EDITS, memories: { removed: ['ent-mem-tokens' as EntityId], added: [] } };
    const mem = buildStrip({
      defaults, edits, added: NONE,
      jev: { carried: { memories: { added: [], removed: ['ent-mem-tokens' as EntityId] } }, why: {} },
    }).find((g) => g.def.kind === 'memory')!;
    expect(mem.rows[0]!.jev).toBe('left-out');
    expect(mem.edited).toBe(false);
  });

  it('teammate rows land after skills', () => {
    const strip = buildStrip({
      defaults, edits: NO_SELECTION_EDITS, added: NONE,
      teammates: [{ id: 'tm-x' as EntityId, kind: 'team_member', title: 'x', group: 'teammates', ticked: true, source: 'jev', via: null, jev: 'picked', jevWhy: null, unsent: 'not yet' }],
    });
    expect(strip.map((g) => g.def.kind)).toEqual(['file', 'memory', 'skill', 'teammate', 'doc']);
  });
});

describe('addToEdits', () => {
  it('folds several picks into one edit per group, re-ticking a removed default', () => {
    const edits = { ...NO_SELECTION_EDITS, references: { removed: ['ent-doc-spec' as EntityId], added: [] } };
    const out = addToEdits(defaults, edits, [row('ent-doc-spec', 'doc'), row('d-2', 'doc'), row('m-2', 'memory')],
      (r) => (r.kind === 'memory' ? 'memories' : 'references'));
    expect(out.references?.edit).toEqual({ removed: [], added: ['d-2'] });
    expect(out.memories?.edit).toEqual({ removed: [], added: ['m-2'] });
    expect(out.references?.rows.map((r) => r.id)).toEqual(['d-2']);
  });
});

describe('stripKindOf', () => {
  it('maps a reference by its kind and falls back to docs', () => {
    expect(stripKindOf('references', 'file')).toBe('file');
    expect(stripKindOf('references', 'weird')).toBe('doc');
    expect(stripKindOf('memories', 'anything')).toBe('memory');
  });
});
