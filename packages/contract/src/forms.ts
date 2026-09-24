/**
 * Forms (FORMS-DESIGN v3, migration 209): the question-type registry and the
 * schemas every surface validates against before it calls the server.
 *
 * THE RULE. A question type is ONE entry in `FORM_QUESTION_TYPES`. The entry
 * owns its config schema, answer schema, validator, plain-text renderer and
 * answer equality. Nothing outside the registry switches on a question type:
 * the generic functions below (`validateFormAnswers`, `renderFormResponseText`,
 * `FormQuestionSchema`) only look an entry up and call it.
 *
 * ADDING A TYPE (e.g. `yes_no`):
 *   1. add one entry to FORM_QUESTION_TYPES below;
 *   2. add one SQL arm, `internal.form_qtype_<type>(op, config, answer)`, in a
 *      new migration (see 209's header for its contract);
 *   3. add its cases to the shared parity fixture (test/fixtures/form-parity.ts):
 *      a fixture question of the type, its config bounds, and one answer case
 *      per issue code its arm can return.
 * Nothing else changes: no existing test names a type list, and the registry
 * <-> SQL-arm totality check (forms-parity.pg.test.ts) goes red if step 1 or
 * step 2 is missing. The UI input/answer components are the W1-frontend
 * registry's concern.
 *
 * PARITY. `internal.validate_form_answers` in SQL is the authority; these
 * validators mirror it so the CLI and UI fail early. Both run the same
 * fixture set and must return the same `{key, code}` verdicts
 * (packages/server/test/db/forms-parity.pg.test.ts). Two rules keep them
 * aligned where engines differ:
 *   - lengths are Unicode code points (`[...s].length` = Postgres char_length);
 *   - "blank" means only ASCII space, tab, CR, LF.
 * A short_text `pattern` must match the WHOLE text and is compiled by both
 * engines (JS with the `u` flag, Postgres ARE); stick to the common subset
 * (character classes, quantifiers, groups, alternation, `\d` `\w`).
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

/**
 * One problem with one answer. `code` is machine-readable; the generic codes
 * are `required`, `invalid_shape`, `unknown_question`, `unknown_type`, and a
 * type adds its own (`not_an_option`, `too_long`, ...). It is a string, not a
 * closed union, so a new type's codes need no change outside its entry.
 */
export interface FormIssue {
  code: string;
  message: string;
}

/** An issue located on a question key (`$` for the answers object itself). */
export interface FormAnswerIssue extends FormIssue {
  key: string;
}

/**
 * The code an entry's `validate` returns ALONE for a well-formed answer that
 * says nothing (blank text, nothing selected). The generic layer turns it into
 * `required` on a final submit of a required question, and accepts it otherwise.
 */
export const FORM_EMPTY_ANSWER = 'empty';

/** `details` on a 422 `form_answers_invalid`. */
export interface FormAnswersInvalidDetails {
  reason: 'form_answers_invalid';
  issues: FormAnswerIssue[];
}

// ---------------------------------------------------------------------------
// Shared helpers (engine-neutral lengths and blankness)
// ---------------------------------------------------------------------------

/** Length in code points, which is what Postgres `char_length` counts. */
export function formTextLength(text: string): number {
  return [...text].length;
}

/** Blank = only ASCII whitespace (space, tab, CR, LF), matching SQL `form_blank`. */
export function isBlankFormText(text: string): boolean {
  return /^[ \t\r\n]*$/.test(text);
}

/** A string whose code-point length is within [min, max]. */
function cpString(min: number, max: number) {
  return z.string().refine((s) => {
    const n = formTextLength(s);
    return n >= min && n <= max;
  }, `must be ${min}..${max} characters`);
}

const issue = (code: string, message: string): FormIssue => ({ code, message });
const empty = (message: string): FormIssue[] => [issue(FORM_EMPTY_ANSWER, message)];

/** Canonical deep equality over JSON values (object key order ignored). */
export function formJsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => formJsonEqual(v, bb[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bk = Object.keys(bo).filter((k) => bo[k] !== undefined);
  return ak.length === bk.length && ak.every((k) => formJsonEqual(ao[k], bo[k]));
}

/** A whole-text match. Both engines wrap the pattern the same way. */
function fullMatch(pattern: string): RegExp {
  return new RegExp(`^(?:${pattern})$`, 'u');
}

function compiles(pattern: string): boolean {
  try {
    fullMatch(pattern);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Options (shared by the choice types; a shape, not a type switch)
// ---------------------------------------------------------------------------

export const FormOptionSchema = z.object({
  value: cpString(1, 200),
  label: cpString(1, 500),
  help: cpString(0, 2000).optional(),
  /** Rendered as a badge and pre-selected by "accept recommended". */
  recommended: z.boolean().optional(),
}).strict();
export type FormOption = z.infer<typeof FormOptionSchema>;

function optionsSchema(maxRecommended: number) {
  return z.array(FormOptionSchema).min(2).max(50).superRefine((options, ctx) => {
    const seen = new Set<string>();
    for (const option of options) {
      if (seen.has(option.value)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate option value "${option.value}"` });
      }
      seen.add(option.value);
    }
    if (options.filter((o) => o.recommended === true).length > maxRecommended) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `at most ${maxRecommended} option(s) may be recommended` });
    }
  });
}

function renderOption(options: FormOption[], value: string): string {
  const option = options.find((o) => o.value === value);
  if (!option) return value;
  return `${value} ("${option.label}")${option.recommended ? ' [recommended]' : ''}`;
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * One question type. `C` is the parsed config (defaults applied), `A` the
 * parsed answer.
 */
export interface FormQuestionTypeDef<C = any, A = any> {
  readonly type: string;
  /** Short human name, for builders and help text. */
  readonly label: string;
  /** Strict; applies defaults. Mirrors the SQL arm's `config` op. */
  readonly configSchema: z.ZodType<C, z.ZodTypeDef, unknown>;
  /** Strict shape of one answer. A parse failure is `invalid_shape`. */
  readonly answerSchema: z.ZodType<A, z.ZodTypeDef, unknown>;
  /**
   * Semantic checks on a well-shaped answer. Mirrors the SQL arm's `answer`
   * op issue-for-issue. Returns `[{code: 'empty'}]` alone for an empty answer.
   */
  validate(config: C, answer: A): FormIssue[];
  /** One answer as plain text for the PTY (§7.2). */
  renderAnswerText(config: C, answer: A): string;
  /** `block` answers go on their own indented lines. Default `inline`. */
  readonly textLayout?: 'inline' | 'block';
  /** Equality for "changed answers first". Default: canonical deep-equal. */
  answersEqual?(config: C, a: A, b: A): boolean;
  /** A valid config and answer: CLI help and tests use it. */
  readonly example: { config: unknown; answer: A };
}

function defineQuestionType<C, A>(def: FormQuestionTypeDef<C, A>): FormQuestionTypeDef<C, A> {
  return def;
}

const singleChoice = defineQuestionType({
  type: 'single_choice',
  label: 'Single choice',
  configSchema: z.object({
    options: optionsSchema(1),
    allowOther: z.boolean().default(false),
    display: z.enum(['radio', 'dropdown']).default('radio'),
  }).strict(),
  answerSchema: z.union([
    z.object({ value: z.string() }).strict(),
    z.object({ other: z.string() }).strict(),
  ]),
  validate(config, answer) {
    if ('value' in answer) {
      return config.options.some((o) => o.value === answer.value)
        ? []
        : [issue('not_an_option', `"${answer.value}" is not one of the options`)];
    }
    if (!config.allowOther) return [issue('other_not_allowed', 'this question does not accept a write-in')];
    if (isBlankFormText(answer.other)) return [issue('invalid_shape', 'other must not be blank')];
    if (formTextLength(answer.other) > 2000) return [issue('too_long', 'other must be at most 2000 chars')];
    return [];
  },
  renderAnswerText(config, answer) {
    return 'value' in answer ? renderOption(config.options, answer.value) : `other: "${answer.other}"`;
  },
  example: {
    config: {
      options: [
        { value: 'online_backfill', label: 'Online backfill', recommended: true },
        { value: 'dual_write', label: 'Dual write' },
      ],
    },
    answer: { value: 'online_backfill' },
  },
});

const multiChoice = defineQuestionType({
  type: 'multi_choice',
  label: 'Multiple choice',
  configSchema: z.object({
    options: optionsSchema(50),
    allowOther: z.boolean().default(false),
    minSelected: z.number().int().min(0).max(50).optional(),
    maxSelected: z.number().int().min(1).max(50).optional(),
  }).strict().refine(
    (c) => c.minSelected === undefined || c.maxSelected === undefined || c.minSelected <= c.maxSelected,
    'minSelected must not exceed maxSelected',
  ),
  answerSchema: z.object({ values: z.array(z.string()), other: z.string().optional() }).strict(),
  validate(config, answer) {
    if (new Set(answer.values).size !== answer.values.length) {
      return [issue('invalid_shape', 'values must not repeat')];
    }
    const issues: FormIssue[] = [];
    const bad = answer.values.filter((v) => !config.options.some((o) => o.value === v));
    if (bad.length > 0) issues.push(issue('not_an_option', `${bad.map((v) => `"${v}"`).join(', ')} not among the options`));
    if (answer.other !== undefined) {
      if (!config.allowOther) issues.push(issue('other_not_allowed', 'this question does not accept a write-in'));
      else if (isBlankFormText(answer.other)) issues.push(issue('invalid_shape', 'other must not be blank'));
      else if (formTextLength(answer.other) > 2000) issues.push(issue('too_long', 'other must be at most 2000 chars'));
    }
    const selected = answer.values.length + (answer.other !== undefined ? 1 : 0);
    if (selected === 0) return empty('nothing selected');
    if (selected < (config.minSelected ?? 0)) issues.push(issue('too_few', `select at least ${config.minSelected}`));
    if (config.maxSelected !== undefined && selected > config.maxSelected) {
      issues.push(issue('too_many', `select at most ${config.maxSelected}`));
    }
    return issues;
  },
  renderAnswerText(config, answer) {
    const parts = answer.values.map((v) => renderOption(config.options, v));
    if (answer.other !== undefined) parts.push(`other: "${answer.other}"`);
    return parts.length > 0 ? parts.join(', ') : '(none selected)';
  },
  // Selection order is not meaning: compare as a set, plus the write-in.
  answersEqual(_config, a, b) {
    const as = new Set(a.values);
    return as.size === new Set(b.values).size && b.values.every((v) => as.has(v)) && a.other === b.other;
  },
  example: {
    config: {
      options: [
        { value: 'api', label: 'API' },
        { value: 'ui', label: 'UI' },
        { value: 'cli', label: 'CLI' },
      ],
      maxSelected: 2,
    },
    answer: { values: ['api', 'cli'] },
  },
});

const shortText = defineQuestionType({
  type: 'short_text',
  label: 'Short text',
  configSchema: z.object({
    placeholder: cpString(0, 200).optional(),
    maxLength: z.number().int().min(1).max(500).default(500),
    pattern: cpString(1, 500).refine(compiles, 'pattern is not a valid regular expression').optional(),
  }).strict(),
  answerSchema: z.object({ text: z.string() }).strict(),
  validate(config, answer) {
    if (isBlankFormText(answer.text)) return empty('blank');
    const issues: FormIssue[] = [];
    if (formTextLength(answer.text) > config.maxLength) issues.push(issue('too_long', `at most ${config.maxLength} chars`));
    if (config.pattern !== undefined && !fullMatch(config.pattern).test(answer.text)) {
      issues.push(issue('pattern_mismatch', 'does not match the required pattern'));
    }
    return issues;
  },
  renderAnswerText(_config, answer) {
    return answer.text;
  },
  example: { config: { placeholder: 'e.g. billing' }, answer: { text: 'billing' } },
});

const longText = defineQuestionType({
  type: 'long_text',
  label: 'Long text',
  configSchema: z.object({
    placeholder: cpString(0, 200).optional(),
    minLength: z.number().int().min(0).max(20000).optional(),
    maxLength: z.number().int().min(1).max(20000).default(20000),
  }).strict().refine((c) => (c.minLength ?? 0) <= c.maxLength, 'minLength must not exceed maxLength'),
  answerSchema: z.object({ text: z.string() }).strict(),
  validate(config, answer) {
    if (isBlankFormText(answer.text)) return empty('blank');
    const n = formTextLength(answer.text);
    const issues: FormIssue[] = [];
    if (n < (config.minLength ?? 0)) issues.push(issue('too_short', `at least ${config.minLength} chars`));
    if (n > config.maxLength) issues.push(issue('too_long', `at most ${config.maxLength} chars`));
    return issues;
  },
  renderAnswerText(_config, answer) {
    return answer.text;
  },
  textLayout: 'block',
  example: { config: {}, answer: { text: 'The billing table is 40M rows; run it off-peak.' } },
});

const scale = defineQuestionType({
  type: 'scale',
  label: 'Scale',
  configSchema: z.object({
    min: z.union([z.literal(0), z.literal(1)]).default(1),
    max: z.number().int().min(2).max(10).default(5),
    minLabel: cpString(0, 100).optional(),
    maxLabel: cpString(0, 100).optional(),
  }).strict(),
  answerSchema: z.object({ number: z.number().int() }).strict(),
  validate(config, answer) {
    return answer.number < config.min || answer.number > config.max
      ? [issue('out_of_range', `must be between ${config.min} and ${config.max}`)]
      : [];
  },
  renderAnswerText(config, answer) {
    const labels = config.minLabel || config.maxLabel
      ? `, ${config.minLabel ?? config.min} … ${config.maxLabel ?? config.max}` : '';
    return `${answer.number} (${config.min}–${config.max}${labels})`;
  },
  example: { config: { min: 1, max: 5, minLabel: 'Low', maxLabel: 'High' }, answer: { number: 4 } },
});

/**
 * THE registry, keyed by type (the key and the entry's `type` are the same
 * string). Every key has a SQL arm `internal.form_qtype_<key>` and vice versa
 * (checked by forms-parity.pg.test.ts). Decision 4 set the v1 contents.
 */
export const FORM_QUESTION_TYPES = {
  single_choice: singleChoice,
  multi_choice: multiChoice,
  short_text: shortText,
  long_text: longText,
  scale,
} as const satisfies Record<string, FormQuestionTypeDef>;

export type FormQuestionType = keyof typeof FORM_QUESTION_TYPES;

export const FORM_QUESTION_TYPE_NAMES = Object.keys(FORM_QUESTION_TYPES) as FormQuestionType[];

/** The registry entry for a type, or undefined for an unknown one. */
export function formQuestionTypeDef(type: string): FormQuestionTypeDef | undefined {
  return Object.prototype.hasOwnProperty.call(FORM_QUESTION_TYPES, type)
    ? (FORM_QUESTION_TYPES as Record<string, FormQuestionTypeDef>)[type]
    : undefined;
}

// ---------------------------------------------------------------------------
// Form structure: keys, sections, questions
// ---------------------------------------------------------------------------

/** Question and section keys: stable, agent-chosen (matches the SQL CHECK). */
export const FormKeySchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'keys are lowercase snake_case, 1..64 chars');

export const FormSectionSchema = z.object({
  key: FormKeySchema,
  title: cpString(1, 300),
  help: cpString(0, 4000).optional(),
}).strict();
export type FormSection = z.infer<typeof FormSectionSchema>;

/**
 * One question. `config` is checked by the type's own schema and comes back
 * parsed (defaults applied). Generic over the registry: no per-type arm here.
 */
export const FormQuestionSchema = z.object({
  key: FormKeySchema,
  type: z.string(),
  title: cpString(1, 500),
  help: cpString(0, 4000).optional(),
  required: z.boolean().default(true),
  section: FormKeySchema.optional(),
  config: z.record(z.unknown()).default({}),
}).strict().transform((question, ctx) => {
  const def = formQuestionTypeDef(question.type);
  if (!def) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['type'],
      message: `unknown question type "${question.type}" (known: ${FORM_QUESTION_TYPE_NAMES.join(', ')})`,
    });
    return z.NEVER;
  }
  const config = def.configSchema.safeParse(question.config);
  if (!config.success) {
    for (const i of config.error.issues) {
      ctx.addIssue({ ...i, path: ['config', ...i.path] } as z.IssueData);
    }
    return z.NEVER;
  }
  return { ...question, type: question.type as FormQuestionType, config: config.data as Record<string, unknown> };
});
export type FormQuestion = z.output<typeof FormQuestionSchema>;
export type FormQuestionInput = z.input<typeof FormQuestionSchema>;

// ---------------------------------------------------------------------------
// Settings (§3.3)
// ---------------------------------------------------------------------------

export const FormResponsesModeSchema = z.enum(['per_member', 'single', 'unlimited']);
export type FormResponsesMode = z.infer<typeof FormResponsesModeSchema>;

export const FormSettingsSchema = z.object({
  /** per_member: one current response per member (default); single: one on the form; unlimited. */
  responses: FormResponsesModeSchema.default('per_member'),
  /** humans (default): agents are refused; anyone: teammates may answer too. */
  respondents: z.enum(['humans', 'anyone']).default('humans'),
  closeOnSubmit: z.boolean().default(false),
  /** Decision 8: a member can edit and resubmit (a new revision, re-delivered). */
  allowAmend: z.boolean().default(true),
  delivery: z.object({
    target: z.enum(['requesting_session', 'new_session']).default('requesting_session'),
    onSessionNotLive: z.enum(['resume', 'queue', 'spawn_new']).default('resume'),
  }).strict().default({}),
  attentionPoints: z.number().int().min(1).max(100).default(60),
}).strict();
export type FormSettings = z.output<typeof FormSettingsSchema>;
export type FormSettingsInput = z.input<typeof FormSettingsSchema>;

/** Every setting at its default. */
export const DEFAULT_FORM_SETTINGS: FormSettings = FormSettingsSchema.parse({});

export const FormStatusSchema = z.enum(['draft', 'open', 'closed', 'cancelled']);
export type FormStatus = z.infer<typeof FormStatusSchema>;

/**
 * The lifecycle (§5) — the targets `forms.transition` accepts from each
 * status. Mirrors `public.transition_form` (211); the UI and actions.list
 * import it rather than restating it. Closing a form is not cancelling it:
 * `cancelled` is reachable from draft and open only.
 */
export const FORM_TRANSITIONS: Readonly<Record<FormStatus, readonly FormStatus[]>> = {
  draft: ['open', 'cancelled'],
  open: ['closed', 'cancelled'],
  closed: ['open'],
  cancelled: [],
};

/**
 * A question as STORED and read back (`internal.form_questions_json`):
 * config as written, plus its position. Not re-validated through the
 * registry on read — the database already did that on write.
 */
export const FormQuestionRowSchema = z.object({
  key: FormKeySchema,
  type: z.string().min(1),
  title: z.string().min(1),
  help: z.string().optional(),
  required: z.boolean(),
  section: FormKeySchema.optional(),
  position: z.number().int().nonnegative(),
  config: z.record(z.unknown()),
}).strict();
export type FormQuestionRow = z.infer<typeof FormQuestionRowSchema>;

export const FormSectionRowSchema = FormSectionSchema.extend({
  position: z.number().int().nonnegative(),
});
export type FormSectionRow = z.infer<typeof FormSectionRowSchema>;

// ---------------------------------------------------------------------------
// forms.create input (§6) and answers
// ---------------------------------------------------------------------------

export const FormSpecSchema = z.object({
  title: cpString(1, 300),
  description: cpString(0, 8000).optional(),
  sections: z.array(FormSectionSchema).max(50).optional(),
  questions: z.array(FormQuestionSchema).max(200),
  settings: FormSettingsSchema.optional(),
  /** Agents default to open; humans to draft (§5). */
  open: z.boolean().optional(),
  /** A human naming the session the answers go to (§3.2). */
  forSession: z.string().uuid().optional(),
  attachTo: z.array(z.string().uuid()).max(20).optional(),
}).strict().superRefine((spec, ctx) => {
  const sectionKeys = new Set<string>();
  (spec.sections ?? []).forEach((s, i) => {
    if (sectionKeys.has(s.key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sections', i, 'key'], message: `duplicate section key "${s.key}"` });
    sectionKeys.add(s.key);
  });
  const questionKeys = new Set<string>();
  spec.questions.forEach((q, i) => {
    if (questionKeys.has(q.key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['questions', i, 'key'], message: `duplicate question key "${q.key}"` });
    questionKeys.add(q.key);
    if (q.section !== undefined && !sectionKeys.has(q.section)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['questions', i, 'section'], message: `no section "${q.section}"` });
    }
  });
});
export type FormSpec = z.output<typeof FormSpecSchema>;
export type FormSpecInput = z.input<typeof FormSpecSchema>;

/**
 * `{ [questionKey]: Answer }`. The per-answer shape depends on the question,
 * so it is checked by `validateFormAnswers`, not here. `null` = unanswered.
 */
export const FormAnswersSchema = z.record(FormKeySchema, z.union([z.record(z.unknown()), z.null()]));
export type FormAnswers = z.infer<typeof FormAnswersSchema>;

// ---------------------------------------------------------------------------
// Validation (mirrors internal.validate_form_answers_against)
// ---------------------------------------------------------------------------

/** The part of a question validation and rendering read. */
export interface FormQuestionRef {
  key: string;
  type: string;
  title?: string;
  required?: boolean;
  config?: Record<string, unknown>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate answers against questions. `final: false` is a draft save: shape
 * and bounds only, no `required`. Returns [] when valid.
 */
export function validateFormAnswers(
  questions: readonly FormQuestionRef[],
  answers: unknown,
  opts: { final: boolean },
): FormAnswerIssue[] {
  if (!isPlainObject(answers)) {
    return [{ key: '$', code: 'invalid_shape', message: 'answers must be an object keyed by question key' }];
  }
  const out: FormAnswerIssue[] = [];
  const at = (key: string, issues: FormIssue[]) => issues.forEach((i) => out.push({ key, ...i }));
  const requiredMissing = (q: FormQuestionRef) => {
    if (opts.final && q.required !== false) at(q.key, [issue('required', 'an answer is required')]);
  };

  for (const q of questions) {
    const answer = answers[q.key];
    if (answer === undefined || answer === null) {
      requiredMissing(q);
      continue;
    }
    if (!isPlainObject(answer)) {
      at(q.key, [issue('invalid_shape', 'an answer must be an object')]);
      continue;
    }
    const def = formQuestionTypeDef(q.type);
    if (!def) {
      at(q.key, [issue('unknown_type', `unknown question type "${q.type}"`)]);
      continue;
    }
    const config = def.configSchema.safeParse(q.config ?? {});
    if (!config.success) {
      at(q.key, [issue('invalid_config', config.error.issues[0]?.message ?? 'invalid config')]);
      continue;
    }
    const shaped = def.answerSchema.safeParse(answer);
    if (!shaped.success) {
      at(q.key, [issue('invalid_shape', shaped.error.issues[0]?.message ?? 'invalid answer')]);
      continue;
    }
    const issues = def.validate(config.data, shaped.data);
    if (issues.length === 1 && issues[0]!.code === FORM_EMPTY_ANSWER) {
      requiredMissing(q);
      continue;
    }
    at(q.key, issues);
  }

  const known = new Set(questions.map((q) => q.key));
  for (const key of Object.keys(answers).filter((k) => !known.has(k)).sort()) {
    out.push({ key, code: 'unknown_question', message: 'no question has this key' });
  }
  return out;
}

/** A question's config check alone (mirrors internal.form_question_config_issues). */
export function formQuestionConfigIssues(type: string, config: unknown): FormIssue[] {
  const def = formQuestionTypeDef(type);
  if (!def) return [issue('unknown_type', `unknown question type "${type}"`)];
  const parsed = def.configSchema.safeParse(config);
  return parsed.success ? [] : [issue('invalid_config', parsed.error.issues[0]?.message ?? 'invalid config')];
}

// ---------------------------------------------------------------------------
// Plain-text rendering for the PTY (§7.2)
// ---------------------------------------------------------------------------

const NO_ANSWER = '(no answer)';

function answerText(q: FormQuestionRef, answer: unknown): string {
  if (answer === undefined || answer === null) return NO_ANSWER;
  const def = formQuestionTypeDef(q.type);
  const config = def?.configSchema.safeParse(q.config ?? {});
  const shaped = def?.answerSchema.safeParse(answer);
  if (!def || !config?.success || !shaped?.success) return JSON.stringify(answer);
  return def.renderAnswerText(config.data, shaped.data);
}

/** Two answers to one question are the same (entry's equality, else canonical). */
export function formAnswersEqual(q: FormQuestionRef, a: unknown, b: unknown): boolean {
  const absentA = a === undefined || a === null;
  const absentB = b === undefined || b === null;
  if (absentA || absentB) return absentA && absentB;
  const def = formQuestionTypeDef(q.type);
  const config = def?.configSchema.safeParse(q.config ?? {});
  const sa = def?.answerSchema.safeParse(a);
  const sb = def?.answerSchema.safeParse(b);
  if (def?.answersEqual && config?.success && sa?.success && sb?.success) {
    return def.answersEqual(config.data, sa.data, sb.data);
  }
  return formJsonEqual(a, b);
}

function questionLine(index: number, q: FormQuestionRef, answer: unknown): string {
  const head = `${index + 1}. [${q.key}] ${q.title ?? q.key} →`;
  const text = answerText(q, answer);
  const block = formQuestionTypeDef(q.type)?.textLayout === 'block' || text.includes('\n');
  if (!block || text === NO_ANSWER) return `${head} ${text}`;
  return `${head}\n${text.split('\n').map((line) => `   ${line}`).join('\n')}`;
}

/**
 * The body of a `form_response` delivery (§7.2). With `previousAnswers` (a
 * resubmission) the changed answers come first, then the full set. Numbering
 * follows question order in both lists.
 */
export function renderFormResponseText(input: {
  title: string;
  questions: readonly FormQuestionRef[];
  answers: Record<string, unknown>;
  previousAnswers?: Record<string, unknown>;
}): string {
  const lines = [`Form: ${input.title}`];
  const all = input.questions.map((q, i) => questionLine(i, q, input.answers[q.key]));
  if (input.previousAnswers !== undefined) {
    const previous = input.previousAnswers;
    const changed = input.questions
      .map((q, i) => ({ q, i }))
      .filter(({ q }) => !formAnswersEqual(q, input.answers[q.key], previous[q.key]));
    lines.push(changed.length === 0 ? 'Changed: none' : `Changed (${changed.length}):`);
    for (const { q, i } of changed) lines.push(questionLine(i, q, input.answers[q.key]));
    lines.push('All answers:');
  }
  lines.push(...all);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The forms.* operations (FORMS-DESIGN §6, W1): request bodies and views.
//
// Request bodies carry questions RAW (`FormQuestionWireSchema`): structure
// only, config as written. The database is the authority on a question's
// config (its type's SQL arm) and answers it as a 422 with issues, so the
// server never runs an author-supplied `pattern` through JS RegExp on the
// request path (W0 ReDoS note). CLI and UI validate early with
// `FormSpecSchema` / `FormQuestionSchema` above.
// ---------------------------------------------------------------------------

const FormIdSchema = z.string().min(1);

/** The command envelope every forms.* mutation carries. */
const formCommandShape = {
  actorId: FormIdSchema.optional(),
  workSessionId: FormIdSchema.optional(),
  clientMutationId: z.string().min(1),
};

/** The command envelope, as a type (mirrors `formCommandShape`). */
export interface FormCommandContext {
  actorId?: string;
  workSessionId?: string;
  clientMutationId: string;
}

/** A question as sent over the wire: structure checked, config left to SQL. */
export const FormQuestionWireSchema = z.object({
  key: FormKeySchema,
  type: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/, 'type is a lowercase identifier'),
  title: cpString(1, 500),
  help: cpString(0, 4000).optional(),
  required: z.boolean().optional(),
  section: FormKeySchema.optional(),
  config: z.record(z.unknown()).optional(),
}).strict();
export type FormQuestionWire = z.infer<typeof FormQuestionWireSchema>;

/** Settings as sent: sparse, every key optional (defaults apply on read). */
export const FormSettingsPatchSchema = z.object({
  responses: FormResponsesModeSchema.optional(),
  respondents: z.enum(['humans', 'anyone']).optional(),
  closeOnSubmit: z.boolean().optional(),
  allowAmend: z.boolean().optional(),
  delivery: z.object({
    target: z.enum(['requesting_session', 'new_session']).optional(),
    onSessionNotLive: z.enum(['resume', 'queue', 'spawn_new']).optional(),
  }).strict().optional(),
  attentionPoints: z.number().int().min(1).max(100).optional(),
}).strict();
export type FormSettingsPatch = z.infer<typeof FormSettingsPatchSchema>;

/** forms.create — the full spec in one call. */
export interface FormsCreateInput extends FormCommandContext {
  spaceId: string;
  title: string;
  description?: string;
  sections?: FormSection[];
  questions: FormQuestionWire[];
  settings?: FormSettingsPatch;
  open?: boolean;
  forSession?: string;
  attachTo?: string[];
  parentId?: string;
}
export const FormsCreateInputSchema: z.ZodType<FormsCreateInput> = z.object({
  ...formCommandShape,
  spaceId: FormIdSchema,
  title: cpString(1, 300),
  description: cpString(0, 8000).optional(),
  sections: z.array(FormSectionSchema).max(50).optional(),
  questions: z.array(FormQuestionWireSchema).max(200),
  settings: FormSettingsPatchSchema.optional(),
  /** Agents default to open, humans to draft (§5). */
  open: z.boolean().optional(),
  /** A human naming the session the answers go to (§3.2). */
  forSession: z.string().uuid().optional(),
  /** Tasks to attach to, beyond the requesting session's working_on tasks. */
  attachTo: z.array(z.string().uuid()).max(20).optional(),
  parentId: FormIdSchema.optional(),
}).strict();

/** forms.update — title, description, settings, sections (replaces the list). */
export interface FormsUpdateInput extends FormCommandContext {
  expectedVersion: number;
  title?: string;
  description?: string | null;
  settings?: FormSettingsPatch;
  sections?: FormSection[];
}
export const FormsUpdateInputSchema: z.ZodType<FormsUpdateInput> = z.object({
  ...formCommandShape,
  expectedVersion: z.number().int().positive(),
  title: cpString(1, 300).optional(),
  description: cpString(0, 8000).nullable().optional(),
  settings: FormSettingsPatchSchema.optional(),
  sections: z.array(FormSectionSchema).max(50).optional(),
}).strict();

/** forms.questions.add — `after` omitted appends; `null` puts it first. */
export interface FormsQuestionsAddInput extends FormCommandContext {
  expectedVersion: number;
  question: FormQuestionWire;
  after?: string | null;
}
export const FormsQuestionsAddInputSchema: z.ZodType<FormsQuestionsAddInput> = z.object({
  ...formCommandShape,
  expectedVersion: z.number().int().positive(),
  question: FormQuestionWireSchema,
  after: FormKeySchema.nullable().optional(),
}).strict();

/** forms.questions.update — partial; `null` clears help/section. */
export interface FormsQuestionsUpdateInput extends FormCommandContext {
  expectedVersion: number;
  type?: string;
  title?: string;
  help?: string | null;
  required?: boolean;
  section?: string | null;
  config?: Record<string, unknown>;
}
export const FormsQuestionsUpdateInputSchema: z.ZodType<FormsQuestionsUpdateInput> = z.object({
  ...formCommandShape,
  expectedVersion: z.number().int().positive(),
  type: z.string().regex(/^[a-z][a-z0-9_]{0,40}$/).optional(),
  title: cpString(1, 500).optional(),
  help: cpString(0, 4000).nullable().optional(),
  required: z.boolean().optional(),
  section: FormKeySchema.nullable().optional(),
  config: z.record(z.unknown()).optional(),
}).strict();

export interface FormsQuestionsRemoveInput extends FormCommandContext {
  expectedVersion: number;
}
export const FormsQuestionsRemoveInputSchema: z.ZodType<FormsQuestionsRemoveInput> = z.object({
  ...formCommandShape,
  expectedVersion: z.number().int().positive(),
}).strict();

/** forms.questions.move — after `after`; omitted or `null` moves it first. */
export interface FormsQuestionsMoveInput extends FormCommandContext {
  expectedVersion: number;
  after?: string | null;
}
export const FormsQuestionsMoveInputSchema: z.ZodType<FormsQuestionsMoveInput> = z.object({
  ...formCommandShape,
  expectedVersion: z.number().int().positive(),
  after: FormKeySchema.nullable().optional(),
}).strict();

/** forms.transition — open (also reopen), close, cancel (§5). */
export interface FormsTransitionInput extends FormCommandContext {
  expectedVersion: number;
  to: 'open' | 'closed' | 'cancelled';
  reason?: string;
}
export const FormsTransitionInputSchema: z.ZodType<FormsTransitionInput> = z.object({
  ...formCommandShape,
  expectedVersion: z.number().int().positive(),
  to: z.enum(['open', 'closed', 'cancelled']),
  reason: cpString(1, 1000).optional(),
}).strict();

/**
 * forms.responses.save — upsert the caller's draft (partial validation).
 * `amendOf` names the submitted revision being edited (needed only under
 * `unlimited`; per_member/single find it). `responseVersion` guards the draft.
 */
export interface FormsResponsesSaveInput extends FormCommandContext {
  answers: FormAnswers;
  amendOf?: string;
  responseVersion?: number;
}
export const FormsResponsesSaveInputSchema: z.ZodType<FormsResponsesSaveInput> = z.object({
  ...formCommandShape,
  answers: FormAnswersSchema,
  amendOf: z.string().uuid().optional(),
  responseVersion: z.number().int().positive().optional(),
}).strict();

/**
 * forms.responses.discard — delete the caller's own draft on the form.
 * Idempotent: no draft answers {discarded: false}.
 */
export interface FormsResponsesDiscardInput extends FormCommandContext {
  responseVersion?: number;
}
export const FormsResponsesDiscardInputSchema: z.ZodType<FormsResponsesDiscardInput> = z.object({
  ...formCommandShape,
  responseVersion: z.number().int().positive().optional(),
}).strict();

/** forms.responses.submit — full validation, store, message, delivery row. */
export interface FormsResponsesSubmitInput extends FormCommandContext {
  answers?: FormAnswers;
  amendOf?: string;
  responseVersion?: number;
}
export const FormsResponsesSubmitInputSchema: z.ZodType<FormsResponsesSubmitInput> = z.object({
  ...formCommandShape,
  answers: FormAnswersSchema.optional(),
  amendOf: z.string().uuid().optional(),
  responseVersion: z.number().int().positive().optional(),
}).strict();

// -- Views (advisor ruling W1-R1: one shape, owned here, mirrored by the UI) --

/** What `internal.form_snapshot` freezes at submit. */
export const FormSnapshotSchema = z.object({
  structureVersion: z.number().int().positive(),
  sections: z.array(FormSectionRowSchema),
  questions: z.array(FormQuestionRowSchema),
});
export type FormSnapshot = z.infer<typeof FormSnapshotSchema>;

export const FormDeliveryStatusSchema = z.enum(['pending', 'delivered', 'spawned', 'cancelled']);
export type FormDeliveryStatus = z.infer<typeof FormDeliveryStatusSchema>;

export const FormDeliveryViewSchema = z.object({
  workSessionId: z.string(),
  status: FormDeliveryStatusSchema,
  spawnedSessionId: z.string().nullable(),
  lastError: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  createdAt: z.string(),
});
export type FormDeliveryView = z.infer<typeof FormDeliveryViewSchema>;

export const FormResponseStatusSchema = z.enum(['draft', 'submitted']);
export type FormResponseStatus = z.infer<typeof FormResponseStatusSchema>;

export const FormResponseViewSchema = z.object({
  id: z.string(),
  formId: z.string(),
  respondentId: z.string(),
  /** Display name, resolved server-side. */
  respondentName: z.string().nullable(),
  status: FormResponseStatusSchema,
  revision: z.number().int().positive(),
  supersedesId: z.string().nullable(),
  lineageKey: z.string(),
  isCurrent: z.boolean(),
  structureVersion: z.number().int().positive(),
  answers: FormAnswersSchema,
  questionsSnapshot: FormSnapshotSchema.nullable(),
  /** The delivery message (jump to the timeline). */
  messageId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  submittedAt: z.string().nullable(),
  version: z.number().int().positive(),
  /** [] for drafts. */
  deliveries: z.array(FormDeliveryViewSchema),
});
export type FormResponseView = z.infer<typeof FormResponseViewSchema>;

/** forms.responses.list / forms.responses.mine: a keyset page. */
export const FormResponsePageSchema = z.object({
  items: z.array(FormResponseViewSchema),
  nextCursor: z.string().nullable(),
});
export type FormResponsePage = z.infer<typeof FormResponsePageSchema>;
