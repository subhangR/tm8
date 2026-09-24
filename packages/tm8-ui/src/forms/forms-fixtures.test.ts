/**
 * The forms fixtures are built from the contract, and they cover what the
 * panel has to draw. A fixture the server would refuse is a UI built against
 * a shape that never arrives.
 */
import { describe, expect, it } from 'vitest';
import {
  FORM_QUESTION_TYPE_NAMES,
  FormQuestionSchema,
  FormSectionSchema,
  FormSettingsSchema,
  validateFormAnswers,
} from '@tm8/contract';
import { FORM_FIXTURE_FORMS, FORM_FIXTURE_RESPONSES, FORM_FIXTURE_VIEWER } from './fixtures';

const formOf = (id: string) => FORM_FIXTURE_FORMS.find((f) => f.id === id)!;

describe('forms fixtures', () => {
  it('every question, section and settings object parses through the contract', () => {
    for (const f of FORM_FIXTURE_FORMS) {
      for (const { position: _p, ...question } of f.content.questions) {
        expect(FormQuestionSchema.safeParse(question).success, `${f.id}.${question.key}`).toBe(true);
      }
      for (const { position: _p, ...section } of f.content.sections) {
        expect(FormSectionSchema.safeParse(section).success, `${f.id}§${section.key}`).toBe(true);
      }
      expect(FormSettingsSchema.parse(f.content.settings)).toEqual(f.content.settings);
    }
  });

  it('every submitted answer set passes final validation; the draft passes partial', () => {
    for (const r of FORM_FIXTURE_RESPONSES) {
      const questions = r.questionsSnapshot?.questions ?? formOf(r.formId).content.questions;
      expect(validateFormAnswers(questions, r.answers, { final: r.status === 'submitted' }), r.id).toEqual([]);
    }
  });

  it('covers every type, several sections, every lifecycle state and every responses mode', () => {
    // Every fixture type is a contract type, and the five v1 types are all
    // here. Deliberately NOT "every contract type": a new type must not have
    // to touch fixtures (its example config/answer is rendered by the registry
    // totality test in question-types.test.tsx instead).
    const types = new Set(FORM_FIXTURE_FORMS.flatMap((f) => f.content.questions.map((q) => q.type)));
    expect([...types].every((t) => (FORM_QUESTION_TYPE_NAMES as readonly string[]).includes(t))).toBe(true);
    expect(types.size).toBeGreaterThanOrEqual(5);
    expect(Math.max(...FORM_FIXTURE_FORMS.map((f) => f.content.sections.length))).toBeGreaterThan(1);
    expect(new Set(FORM_FIXTURE_FORMS.map((f) => f.content.status))).toEqual(new Set(['draft', 'open', 'closed', 'cancelled']));
    expect(new Set(FORM_FIXTURE_FORMS.map((f) => f.content.settings.responses))).toEqual(new Set(['per_member', 'single', 'unlimited']));
  });

  it('covers every delivery status, a 1 → 2 → 3 revision chain, and one current row per chain', () => {
    const statuses = new Set(FORM_FIXTURE_RESPONSES.flatMap((r) => r.deliveries.map((d) => d.status)));
    expect(statuses).toEqual(new Set(['delivered', 'pending', 'spawned', 'cancelled']));
    const chain = FORM_FIXTURE_RESPONSES.filter((r) => r.lineageKey === FORM_FIXTURE_VIEWER.memberId && r.formId === 'form-release-review');
    expect(chain.map((r) => r.revision)).toEqual([1, 2, 3]);
    expect(chain.map((r) => r.supersedesId)).toEqual([null, chain[0]!.id, chain[1]!.id]);
    const current = new Map<string, number>();
    for (const r of FORM_FIXTURE_RESPONSES.filter((x) => x.isCurrent)) {
      const k = `${r.formId}/${r.lineageKey}`;
      current.set(k, (current.get(k) ?? 0) + 1);
    }
    expect([...current.values()].every((n) => n === 1)).toBe(true);
  });

  it('a draft reaches only its respondent: the only draft is the viewer’s own, and drafts are never current', () => {
    const drafts = FORM_FIXTURE_RESPONSES.filter((r) => r.status === 'draft');
    expect(drafts.length).toBeGreaterThan(0);
    for (const d of drafts) {
      expect(d.respondentId).toBe(FORM_FIXTURE_VIEWER.memberId);
      expect(d.isCurrent).toBe(false);
      expect(d.deliveries).toEqual([]);
    }
  });
});
