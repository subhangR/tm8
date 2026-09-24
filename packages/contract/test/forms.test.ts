/**
 * Forms W0 (FORMS-DESIGN v3): the question-type registry and its generic
 * consumers. The SQL half of the parity fixture runs in
 * packages/server/test/db/forms-parity.pg.test.ts.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CollabError,
  DEFAULT_FORM_SETTINGS,
  ERROR_STATUS,
  FORM_QUESTION_TYPES,
  FORM_QUESTION_TYPE_NAMES,
  FormAnswersSchema,
  FormQuestionSchema,
  FormSettingsSchema,
  FormSpecSchema,
  formAnswersEqual,
  formQuestionConfigIssues,
  renderFormResponseText,
  validateFormAnswers,
} from '../src/index.js';
import { ANSWER_CASES, CONFIG_CASES, PARITY_QUESTIONS, verdict } from './fixtures/form-parity.js';

const HERE = dirname(fileURLToPath(import.meta.url));

describe('FORM_QUESTION_TYPES', () => {
  it('ships exactly the five v1 types (decision 4)', () => {
    expect(FORM_QUESTION_TYPE_NAMES).toEqual(['single_choice', 'multi_choice', 'short_text', 'long_text', 'scale']);
  });

  it('keys each entry by its own type, and every example is valid', () => {
    for (const [key, def] of Object.entries(FORM_QUESTION_TYPES)) {
      expect(def.type).toBe(key);
      const config = def.configSchema.parse(def.example.config);
      const answer = def.answerSchema.parse(def.example.answer);
      expect(def.validate(config as never, answer as never), key).toEqual([]);
      expect(def.renderAnswerText(config as never, answer as never).length, key).toBeGreaterThan(0);
    }
  });

  it('is the only place in the contract that names a question type', () => {
    // The modularity rule: nothing outside the registry switches on type.
    const src = join(HERE, '../src');
    for (const file of readdirSync(src).filter((f) => f.endsWith('.ts') && f !== 'forms.ts')) {
      const text = readFileSync(join(src, file), 'utf8');
      for (const type of FORM_QUESTION_TYPE_NAMES) {
        expect(text.includes(`'${type}'`) || text.includes(`"${type}"`), `${file} names ${type}`).toBe(false);
      }
    }
  });
});

describe('validateFormAnswers — the shared parity fixture', () => {
  for (const c of ANSWER_CASES) {
    it(c.name, () => {
      expect(verdict(validateFormAnswers(PARITY_QUESTIONS, c.answers, { final: c.final }))).toEqual(c.expect);
    });
  }
});

describe('formQuestionConfigIssues — the shared parity fixture', () => {
  for (const c of CONFIG_CASES) {
    it(c.name, () => {
      expect(verdict(formQuestionConfigIssues(c.type, c.config))).toEqual(c.expect);
    });
  }
});

describe('FormQuestionSchema', () => {
  it('parses a question through its type entry and applies config defaults', () => {
    const q = FormQuestionSchema.parse({ key: 'rate', type: 'scale', title: 'Rate it' });
    expect(q).toEqual({ key: 'rate', type: 'scale', title: 'Rate it', required: true, config: { min: 1, max: 5 } });
  });

  it('refuses an unknown type, naming the known ones', () => {
    const r = FormQuestionSchema.safeParse({ key: 'q', type: 'yes_no', title: 'Q' });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toContain('single_choice');
    expect(r.error?.issues[0]?.path).toEqual(['type']);
  });

  it('reports a config problem under config', () => {
    const r = FormQuestionSchema.safeParse({ key: 'q', type: 'single_choice', title: 'Q', config: { options: [] } });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path.slice(0, 2)).toEqual(['config', 'options']);
  });

  it('refuses a bad key', () => {
    expect(FormQuestionSchema.safeParse({ key: 'Bad-Key', type: 'short_text', title: 'Q' }).success).toBe(false);
  });
});

describe('FormSettingsSchema (§3.3)', () => {
  it('defaults: per_member, humans, amend allowed, resume, 60 points', () => {
    expect(DEFAULT_FORM_SETTINGS).toEqual({
      responses: 'per_member',
      respondents: 'humans',
      closeOnSubmit: false,
      allowAmend: true,
      delivery: { target: 'requesting_session', onSessionNotLive: 'resume' },
      attentionPoints: 60,
    });
  });

  it('is strict and bounded', () => {
    expect(FormSettingsSchema.safeParse({ expiresAt: 'x' }).success).toBe(false);
    expect(FormSettingsSchema.safeParse({ attentionPoints: 0 }).success).toBe(false);
    expect(FormSettingsSchema.safeParse({ delivery: { target: 'elsewhere' } }).success).toBe(false);
    expect(FormSettingsSchema.parse({ delivery: { onSessionNotLive: 'queue' } }).delivery)
      .toEqual({ target: 'requesting_session', onSessionNotLive: 'queue' });
  });
});

describe('FormSpecSchema (forms.create input, §6)', () => {
  const spec = {
    title: 'Pick the migration strategy',
    sections: [{ key: 'plan', title: 'Plan' }],
    questions: [
      { key: 'strategy', type: 'single_choice', title: 'Which approach?', section: 'plan',
        config: FORM_QUESTION_TYPES.single_choice.example.config },
      { key: 'risks', type: 'long_text', title: 'Anything to watch for?', required: false },
    ],
    settings: { responses: 'single', closeOnSubmit: true },
    open: true,
  };

  it('accepts a full spec and fills defaults', () => {
    const parsed = FormSpecSchema.parse(spec);
    expect(parsed.settings?.allowAmend).toBe(true);
    expect(parsed.questions[1]).toMatchObject({ required: false, config: { maxLength: 20000 } });
  });

  it('refuses duplicate question keys and dangling sections', () => {
    const dup = { ...spec, questions: [spec.questions[0], spec.questions[0]] };
    expect(FormSpecSchema.safeParse(dup).success).toBe(false);
    const dangling = { ...spec, sections: [] };
    expect(FormSpecSchema.safeParse(dangling).success).toBe(false);
  });
});

describe('FormAnswersSchema', () => {
  it('is a map of question key to an answer object or null', () => {
    expect(FormAnswersSchema.safeParse({ a: { text: 'x' }, b: null }).success).toBe(true);
    expect(FormAnswersSchema.safeParse({ a: 'x' }).success).toBe(false);
    expect(FormAnswersSchema.safeParse({ 'Not-A-Key': {} }).success).toBe(false);
  });
});

describe('answer equality', () => {
  const mc = PARITY_QUESTIONS.find((q) => q.key === 'mc')!;
  const st = PARITY_QUESTIONS.find((q) => q.key === 'st')!;

  it('multi_choice compares selections as a set', () => {
    expect(formAnswersEqual(mc, { values: ['a', 'b'] }, { values: ['b', 'a'] })).toBe(true);
    expect(formAnswersEqual(mc, { values: ['a'] }, { values: ['a'], other: 'x' })).toBe(false);
    expect(formAnswersEqual(mc, { values: ['a'] }, { values: ['b'] })).toBe(false);
  });

  it('others default to canonical deep-equal; absent equals only absent', () => {
    expect(formAnswersEqual(st, { text: 'a' }, { text: 'a' })).toBe(true);
    expect(formAnswersEqual(st, { text: 'a' }, { text: 'b' })).toBe(false);
    expect(formAnswersEqual(st, undefined, null)).toBe(true);
    expect(formAnswersEqual(st, undefined, { text: 'a' })).toBe(false);
  });
});

describe('renderFormResponseText (§7.2)', () => {
  const questions = [
    { key: 'strategy', type: 'single_choice', title: 'Which approach?', config: FORM_QUESTION_TYPES.single_choice.example.config as Record<string, unknown> },
    { key: 'risks', type: 'long_text', title: 'Anything to watch for?', required: false, config: {} },
    { key: 'areas', type: 'multi_choice', title: 'Areas?', config: FORM_QUESTION_TYPES.multi_choice.example.config as Record<string, unknown> },
    { key: 'confidence', type: 'scale', title: 'Confidence?', config: { min: 1, max: 5 } },
  ];
  const answers = {
    strategy: { value: 'online_backfill' },
    risks: { text: 'The billing table is 40M rows; run it off-peak.' },
    areas: { values: ['api', 'cli'] },
    confidence: { number: 4 },
  };

  it('renders key and value for every answer', () => {
    expect(renderFormResponseText({ title: 'Pick the migration strategy', questions, answers })).toBe([
      'Form: Pick the migration strategy',
      '1. [strategy] Which approach? → online_backfill ("Online backfill") [recommended]',
      '2. [risks] Anything to watch for? →',
      '   The billing table is 40M rows; run it off-peak.',
      '3. [areas] Areas? → api ("API"), cli ("CLI")',
      '4. [confidence] Confidence? → 4 (1–5)',
    ].join('\n'));
  });

  it('a resubmission lists changed answers first, then the full set', () => {
    const previous = { ...answers, areas: { values: ['cli', 'api'] }, confidence: { number: 2 }, risks: null };
    const text = renderFormResponseText({ title: 'T', questions, answers, previousAnswers: previous });
    expect(text.split('\n').slice(0, 5)).toEqual([
      'Form: T',
      'Changed (2):',
      '2. [risks] Anything to watch for? →',
      '   The billing table is 40M rows; run it off-peak.',
      '4. [confidence] Confidence? → 4 (1–5)',
    ]);
    expect(text).toContain('All answers:\n1. [strategy]');
  });

  it('says so when nothing changed, and marks unanswered questions', () => {
    const text = renderFormResponseText({
      title: 'T', questions, answers: { ...answers, risks: null }, previousAnswers: { ...answers, risks: null },
    });
    expect(text).toContain('Changed: none');
    expect(text).toContain('2. [risks] Anything to watch for? → (no answer)');
  });
});

describe('form error codes in the closed taxonomy (§6)', () => {
  it('map to their HTTP statuses', () => {
    expect(new CollabError('form_answers_invalid', 'x').status).toBe(422);
    expect(ERROR_STATUS.form_not_open).toBe(409);
    expect(ERROR_STATUS.form_structure_frozen).toBe(409);
    expect(ERROR_STATUS.form_response_limit).toBe(409);
    expect(ERROR_STATUS.form_respondent_not_allowed).toBe(403);
  });
});
