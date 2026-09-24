/**
 * Build's working copy → the ordered `forms.*` calls that turn the stored form
 * into it (FORMS-DESIGN §6: the backend has no bulk structure write, only
 * `forms.update` and `forms.questions.add/update/remove/move`, each guarded by
 * the form's version).
 *
 * THE ORDER, and why:
 *   1. forms.update   changed settings, and — when the section list changed —
 *                     the new sections PLUS any removed section a stored
 *                     question still names (kept for now, so no step ever
 *                     leaves a question pointing at a missing section);
 *   2. remove         questions that are gone (a key rename is remove + add:
 *                     the backend has no key rename, and renaming is only
 *                     possible before the freeze, when no answer is stored);
 *   3. update         a field patch per changed question (null clears help/section);
 *   4. add            new questions, appended;
 *   5. move           the fewest `after` moves that yield the target order;
 *   6. forms.update   the final section list, only if step 1 kept extras.
 *
 * Pure: the port executes the plan, chaining each result's version, and a
 * retry after a partial failure re-plans against the form the last good step
 * left — so only the remainder is sent.
 */
import {
  formJsonEqual,
  type FormQuestionRow,
  type FormQuestionWire,
  type FormSection,
  type FormSectionRow,
  type FormSettings,
  type FormsQuestionsUpdateInput,
} from '@tm8/contract';

export interface StructureShape {
  sections: readonly FormSectionRow[];
  questions: readonly FormQuestionRow[];
  settings: FormSettings;
}

export type QuestionPatch = Omit<FormsQuestionsUpdateInput, 'expectedVersion' | 'clientMutationId' | 'actorId' | 'workSessionId'>;

export type StructureStep =
  | { op: 'update'; label: string; settings?: FormSettings; sections?: FormSection[] }
  | { op: 'remove'; label: string; key: string }
  | { op: 'patch'; label: string; key: string; patch: QuestionPatch }
  | { op: 'add'; label: string; question: FormQuestionWire }
  | { op: 'move'; label: string; key: string; after: string | null };

const byPosition = <T extends { position: number }>(rows: readonly T[]): T[] =>
  [...rows].sort((a, b) => a.position - b.position);

export function sectionWire({ position: _p, ...s }: FormSectionRow): FormSection {
  return s;
}

export function questionWire(q: FormQuestionRow): FormQuestionWire {
  const wire: FormQuestionWire = { key: q.key, type: q.type, title: q.title, required: q.required, config: q.config };
  if (q.help !== undefined) wire.help = q.help;
  if (q.section !== undefined) wire.section = q.section;
  return wire;
}

function questionPatch(from: FormQuestionRow, to: FormQuestionRow): QuestionPatch | null {
  const patch: QuestionPatch = {};
  if (from.type !== to.type) patch.type = to.type;
  if (from.title !== to.title) patch.title = to.title;
  if ((from.help ?? null) !== (to.help ?? null)) patch.help = to.help ?? null;
  if (from.required !== to.required) patch.required = to.required;
  if ((from.section ?? null) !== (to.section ?? null)) patch.section = to.section ?? null;
  if (from.type !== to.type || !formJsonEqual(from.config, to.config)) patch.config = to.config;
  return Object.keys(patch).length > 0 ? patch : null;
}

export function planStructure(base: StructureShape, next: StructureShape): StructureStep[] {
  const steps: StructureStep[] = [];
  const baseQs = byPosition(base.questions);
  const nextQs = byPosition(next.questions);
  const baseSections = byPosition(base.sections).map(sectionWire);
  const nextSections = byPosition(next.sections).map(sectionWire);

  // 1. settings + sections (with any still-referenced removed section kept).
  const settingsChanged = !formJsonEqual(base.settings, next.settings);
  const sectionsChanged = !formJsonEqual(baseSections, nextSections);
  const nextSectionKeys = new Set(nextSections.map((s) => s.key));
  const referenced = new Set(baseQs.map((q) => q.section).filter((k): k is string => k !== undefined));
  const kept = baseSections.filter((s) => !nextSectionKeys.has(s.key) && referenced.has(s.key));
  if (settingsChanged || sectionsChanged) {
    const words = [settingsChanged ? 'settings' : null, sectionsChanged ? 'sections' : null].filter(Boolean).join(' and ');
    steps.push({
      op: 'update',
      label: `save ${words}`,
      ...(settingsChanged ? { settings: next.settings } : {}),
      ...(sectionsChanged ? { sections: [...nextSections, ...kept] } : {}),
    });
  }

  // 2–4. questions by key.
  const nextByKey = new Map(nextQs.map((q) => [q.key, q]));
  const baseByKey = new Map(baseQs.map((q) => [q.key, q]));
  for (const q of baseQs) {
    if (!nextByKey.has(q.key)) steps.push({ op: 'remove', label: `remove question “${q.key}”`, key: q.key });
  }
  for (const q of nextQs) {
    const was = baseByKey.get(q.key);
    const patch = was ? questionPatch(was, q) : null;
    if (patch) steps.push({ op: 'patch', label: `update question “${q.key}”`, key: q.key, patch });
  }
  const order = baseQs.map((q) => q.key).filter((k) => nextByKey.has(k));
  for (const q of nextQs) {
    if (!baseByKey.has(q.key)) {
      steps.push({ op: 'add', label: `add question “${q.key}”`, question: questionWire(q) });
      order.push(q.key);
    }
  }

  // 5. moves: walk the target order, fixing each slot that is wrong.
  const target = nextQs.map((q) => q.key);
  target.forEach((key, i) => {
    if (order[i] === key) return;
    const after = i === 0 ? null : target[i - 1]!;
    order.splice(order.indexOf(key), 1);
    order.splice(i, 0, key);
    steps.push({ op: 'move', label: `move question “${key}”`, key, after });
  });

  // 6. drop the kept sections.
  if (sectionsChanged && kept.length > 0) {
    steps.push({ op: 'update', label: 'remove old sections', sections: nextSections });
  }
  return steps;
}
