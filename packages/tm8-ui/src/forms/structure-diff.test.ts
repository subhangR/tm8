/** Build's working copy → ordered forms.* steps (structure-diff.ts). */
import { describe, expect, it } from 'vitest';
import { FormSettingsSchema, type FormQuestionRow, type FormSectionRow } from '@tm8/contract';
import { planStructure, type StructureShape } from './structure-diff';

const settings = FormSettingsSchema.parse({});
const q = (key: string, position: number, extra: Partial<FormQuestionRow> = {}): FormQuestionRow => ({
  key, type: 'short_text', title: key, required: true, position, config: {}, ...extra,
});
const s = (key: string, position: number): FormSectionRow => ({ key, title: key, position });
const shape = (questions: FormQuestionRow[], sections: FormSectionRow[] = [], extra: Partial<StructureShape> = {}): StructureShape =>
  ({ questions, sections, settings, ...extra });

describe('planStructure', () => {
  it('no change → no steps', () => {
    expect(planStructure(shape([q('a', 0)]), shape([q('a', 0)]))).toEqual([]);
  });

  it('settings only → one forms.update carrying only settings', () => {
    const steps = planStructure(shape([q('a', 0)]), shape([q('a', 0)], [], { settings: { ...settings, allowAmend: false } }));
    expect(steps).toEqual([{ op: 'update', label: 'save settings', settings: { ...settings, allowAmend: false } }]);
  });

  it('a field patch per changed question; null clears help and section', () => {
    const base = shape([q('a', 0, { help: 'h', section: 'x' })], [s('x', 0)]);
    const next = shape([q('a', 0, { title: 'A', required: false })], [s('x', 0)]);
    expect(planStructure(base, next)).toEqual([
      { op: 'patch', label: 'update question “a”', key: 'a', patch: { title: 'A', help: null, required: false, section: null } },
    ]);
  });

  it('a type change sends the new config with it', () => {
    const [step] = planStructure(shape([q('a', 0)]), shape([q('a', 0, { type: 'long_text', config: { maxLength: 9 } })]));
    expect(step).toMatchObject({ op: 'patch', patch: { type: 'long_text', config: { maxLength: 9 } } });
  });

  it('a key rename is remove + add (the backend has no rename)', () => {
    expect(planStructure(shape([q('a', 0)]), shape([q('z', 0)])).map((x) => x.op)).toEqual(['remove', 'add']);
  });

  it('reorders with the fewest moves', () => {
    const base = shape([q('a', 0), q('b', 1), q('c', 2), q('d', 3)]);
    const steps = planStructure(base, shape([q('d', 0), q('a', 1), q('b', 2), q('c', 3)]));
    expect(steps).toEqual([{ op: 'move', label: 'move question “d”', key: 'd', after: null }]);
  });

  it('adds append, then moves place them', () => {
    const steps = planStructure(shape([q('a', 0), q('b', 1)]), shape([q('a', 0), q('n', 1), q('b', 2)]));
    expect(steps.map((x) => [x.op, 'key' in x ? x.key : x.op === 'add' ? x.question.key : null, 'after' in x ? x.after : undefined]))
      .toEqual([['add', 'n', undefined], ['move', 'n', 'a']]);
  });

  it('removing a section a stored question still names keeps it until the questions moved off it', () => {
    const base = shape([q('a', 0, { section: 'old' })], [s('old', 0)]);
    const next = shape([q('a', 0, { section: 'new' })], [s('new', 0)]);
    expect(planStructure(base, next)).toEqual([
      { op: 'update', label: 'save sections', sections: [{ key: 'new', title: 'new' }, { key: 'old', title: 'old' }] },
      { op: 'patch', label: 'update question “a”', key: 'a', patch: { section: 'new' } },
      { op: 'update', label: 'remove old sections', sections: [{ key: 'new', title: 'new' }] },
    ]);
  });

  it('the order is update → remove → patch → add → move', () => {
    const base = shape([q('a', 0), q('b', 1), q('c', 2)]);
    const next = shape([q('c', 0), q('b', 1, { title: 'B' }), q('n', 2)], [s('x', 0)]);
    expect(planStructure(base, next).map((x) => x.op)).toEqual(['update', 'remove', 'patch', 'add', 'move']);
  });
});
