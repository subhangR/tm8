/**
 * THE shared fixture for form-answer validation parity.
 *
 * Two validators must agree on every case here: the contract's
 * `validateFormAnswers` (packages/contract/test/forms.test.ts) and SQL's
 * `internal.validate_form_answers_against`
 * (packages/server/test/db/forms-parity.pg.test.ts, which runs BOTH against
 * each case and compares them to each other as well as to `expect`).
 *
 * A verdict is the sorted list of `key:code`. Messages are free text and are
 * not compared.
 *
 * Adding a question type adds its cases here: at least one valid answer, one
 * of each issue code its arm can return, and its config bounds.
 */

export interface FormParityQuestion {
  key: string;
  type: string;
  title: string;
  required?: boolean;
  config: Record<string, unknown>;
}

export interface FormAnswerParityCase {
  name: string;
  final: boolean;
  answers: unknown;
  expect: string[];
}

export interface FormConfigParityCase {
  name: string;
  type: string;
  config: unknown;
  /** Sorted issue codes; [] = valid. */
  expect: string[];
}

export const PARITY_QUESTIONS: FormParityQuestion[] = [
  { key: 'sc', type: 'single_choice', title: 'Pick one', config: {
    options: [{ value: 'x', label: 'Ex' }, { value: 'y', label: 'Why', recommended: true }] } },
  { key: 'sco', type: 'single_choice', title: 'Pick one or write in', required: false, config: {
    options: [{ value: 'x', label: 'Ex' }, { value: 'y', label: 'Why' }], allowOther: true, display: 'dropdown' } },
  { key: 'mc', type: 'multi_choice', title: 'Pick one or two', config: {
    options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }, { value: 'c', label: 'C' }],
    minSelected: 1, maxSelected: 2 } },
  { key: 'mco', type: 'multi_choice', title: 'Pick any', required: false, config: {
    options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], allowOther: true } },
  { key: 'st', type: 'short_text', title: 'Short', config: { maxLength: 5 } },
  { key: 'stp', type: 'short_text', title: 'Code', required: false, config: { pattern: '[a-z]+-[0-9]{2}' } },
  { key: 'lt', type: 'long_text', title: 'Long', required: false, config: { minLength: 3, maxLength: 10 } },
  { key: 'sc5', type: 'scale', title: 'Rate', config: {} },
  { key: 'sc0', type: 'scale', title: 'Rate 0-10', required: false, config: { min: 0, max: 10, minLabel: 'No', maxLabel: 'Yes' } },
];

const BASE = {
  sc: { value: 'x' },
  mc: { values: ['a'] },
  st: { text: 'abc' },
  sc5: { number: 3 },
};

const withAnswer = (patch: Record<string, unknown>) => ({ ...BASE, ...patch });
const final = (name: string, answers: unknown, expect: string[]): FormAnswerParityCase =>
  ({ name, final: true, answers, expect });
const draft = (name: string, answers: unknown, expect: string[]): FormAnswerParityCase =>
  ({ name, final: false, answers, expect });

export const ANSWER_CASES: FormAnswerParityCase[] = [
  // generic
  final('minimal valid', BASE, []),
  final('every question answered validly', withAnswer({
    sco: { other: 'hi' }, mco: { values: ['a'], other: 'z' }, stp: { text: 'ab-12' },
    lt: { text: 'hello' }, sc0: { number: 0 },
  }), []),
  final('nothing answered, final', {}, ['mc:required', 'sc5:required', 'sc:required', 'st:required']),
  draft('nothing answered, draft', {}, []),
  final('null is unanswered', withAnswer({ sc: null }), ['sc:required']),
  draft('null in a draft', withAnswer({ sc: null }), []),
  final('answers is an array', [], ['$:invalid_shape']),
  final('answers is a string', 'x', ['$:invalid_shape']),
  final('an answer that is not an object', withAnswer({ st: 'abc' }), ['st:invalid_shape']),
  final('an answer that is an array', withAnswer({ st: ['abc'] }), ['st:invalid_shape']),
  final('unknown key', withAnswer({ zz: { text: 'q' } }), ['zz:unknown_question']),
  draft('unknown key in a draft', { zz: {} }, ['zz:unknown_question']),

  // single_choice
  final('single: not an option', withAnswer({ sc: { value: 'q' } }), ['sc:not_an_option']),
  final('single: value and other', withAnswer({ sc: { value: 'x', other: 'y' } }), ['sc:invalid_shape']),
  final('single: value not a string', withAnswer({ sc: { value: 1 } }), ['sc:invalid_shape']),
  final('single: empty object', withAnswer({ sc: {} }), ['sc:invalid_shape']),
  final('single: write-in not allowed', withAnswer({ sc: { other: 'z' } }), ['sc:other_not_allowed']),
  final('single: write-in blank', withAnswer({ sco: { other: ' \t ' } }), ['sco:invalid_shape']),
  final('single: write-in too long', withAnswer({ sco: { other: 'w'.repeat(2001) } }), ['sco:too_long']),
  final('single: write-in at the limit', withAnswer({ sco: { other: 'w'.repeat(2000) } }), []),

  // multi_choice
  final('multi: nothing selected, required', withAnswer({ mc: { values: [] } }), ['mc:required']),
  draft('multi: nothing selected, draft', withAnswer({ mc: { values: [] } }), []),
  final('multi: nothing selected, optional', withAnswer({ mco: { values: [] } }), []),
  final('multi: too many', withAnswer({ mc: { values: ['a', 'b', 'c'] } }), ['mc:too_many']),
  final('multi: duplicates', withAnswer({ mc: { values: ['a', 'a'] } }), ['mc:invalid_shape']),
  final('multi: not an option', withAnswer({ mc: { values: ['a', 'z'] } }), ['mc:not_an_option']),
  final('multi: not an option AND too many', withAnswer({ mc: { values: ['a', 'z', 'b'] } }),
    ['mc:not_an_option', 'mc:too_many']),
  final('multi: write-in not allowed', withAnswer({ mc: { values: ['a'], other: 'x' } }), ['mc:other_not_allowed']),
  final('multi: write-in only', withAnswer({ mco: { values: [], other: 'x' } }), []),
  final('multi: write-in blank', withAnswer({ mco: { values: ['a'], other: '' } }), ['mco:invalid_shape']),
  final('multi: values not an array', withAnswer({ mc: { values: 'a' } }), ['mc:invalid_shape']),
  final('multi: values missing', withAnswer({ mc: { other: 'x' } }), ['mc:invalid_shape']),
  final('multi: a value not a string', withAnswer({ mc: { values: [1] } }), ['mc:invalid_shape']),
  final('multi: extra key', withAnswer({ mc: { values: ['a'], extra: 1 } }), ['mc:invalid_shape']),

  // short_text
  final('short: too long', withAnswer({ st: { text: 'abcdef' } }), ['st:too_long']),
  final('short: at the limit', withAnswer({ st: { text: 'abcde' } }), []),
  final('short: five emoji are five characters', withAnswer({ st: { text: '😀😀😀😀😀' } }), []),
  final('short: six emoji are too long', withAnswer({ st: { text: '😀😀😀😀😀😀' } }), ['st:too_long']),
  final('short: blank, required', withAnswer({ st: { text: '   ' } }), ['st:required']),
  draft('short: blank, draft', withAnswer({ st: { text: '   ' } }), []),
  final('short: NBSP is not blank', withAnswer({ st: { text: ' ' } }), []),
  final('short: newline inside', withAnswer({ st: { text: 'a\nb' } }), []),
  final('short: pattern matches', withAnswer({ stp: { text: 'xy-42' } }), []),
  final('short: pattern mismatch', withAnswer({ stp: { text: 'AB-12' } }), ['stp:pattern_mismatch']),
  final('short: pattern must match the whole text', withAnswer({ stp: { text: 'xab-12y' } }), ['stp:pattern_mismatch']),
  final('short: text not a string', withAnswer({ st: { text: 5 } }), ['st:invalid_shape']),
  final('short: extra key', withAnswer({ st: { text: 'a', b: 1 } }), ['st:invalid_shape']),

  // long_text
  final('long: too short', withAnswer({ lt: { text: 'ab' } }), ['lt:too_short']),
  final('long: too long', withAnswer({ lt: { text: '12345678901' } }), ['lt:too_long']),
  final('long: at the max', withAnswer({ lt: { text: '1234567890' } }), []),
  final('long: blank, optional', withAnswer({ lt: { text: '\n\t \r' } }), []),

  // scale
  final('scale: above range', withAnswer({ sc5: { number: 6 } }), ['sc5:out_of_range']),
  final('scale: below range', withAnswer({ sc5: { number: 0 } }), ['sc5:out_of_range']),
  final('scale: zero-based', withAnswer({ sc0: { number: 0 } }), []),
  final('scale: top of 0-10', withAnswer({ sc0: { number: 10 } }), []),
  final('scale: not an integer', withAnswer({ sc5: { number: 2.5 } }), ['sc5:invalid_shape']),
  final('scale: a string', withAnswer({ sc5: { number: '3' } }), ['sc5:invalid_shape']),
];

const OPTS = [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }];
const ok = (name: string, type: string, config: unknown): FormConfigParityCase => ({ name, type, config, expect: [] });
const bad = (name: string, type: string, config: unknown): FormConfigParityCase =>
  ({ name, type, config, expect: ['invalid_config'] });

export const CONFIG_CASES: FormConfigParityCase[] = [
  ok('single: minimal', 'single_choice', { options: OPTS }),
  ok('single: everything', 'single_choice', {
    options: [{ value: 'x', label: 'X', help: 'h', recommended: true }, { value: 'y', label: 'Y' }],
    allowOther: true, display: 'dropdown' }),
  bad('single: one option', 'single_choice', { options: [{ value: 'x', label: 'X' }] }),
  bad('single: 51 options', 'single_choice', {
    options: Array.from({ length: 51 }, (_, i) => ({ value: `v${i}`, label: `L${i}` })) }),
  bad('single: duplicate values', 'single_choice', { options: [{ value: 'x', label: 'X' }, { value: 'x', label: 'Y' }] }),
  bad('single: two recommended', 'single_choice', {
    options: [{ value: 'x', label: 'X', recommended: true }, { value: 'y', label: 'Y', recommended: true }] }),
  bad('single: unknown key', 'single_choice', { options: OPTS, colour: 'red' }),
  bad('single: bad display', 'single_choice', { options: OPTS, display: 'grid' }),
  bad('single: allowOther not boolean', 'single_choice', { options: OPTS, allowOther: 'yes' }),
  bad('single: option unknown key', 'single_choice', { options: [{ value: 'x', label: 'X', icon: 'i' }, { value: 'y', label: 'Y' }] }),
  bad('single: empty label', 'single_choice', { options: [{ value: 'x', label: '' }, { value: 'y', label: 'Y' }] }),
  bad('single: option help too long', 'single_choice', {
    options: [{ value: 'x', label: 'X', help: 'h'.repeat(2001) }, { value: 'y', label: 'Y' }] }),
  bad('single: options missing', 'single_choice', {}),
  bad('single: config not an object', 'single_choice', []),
  ok('multi: several recommended', 'multi_choice', {
    options: [{ value: 'x', label: 'X', recommended: true }, { value: 'y', label: 'Y', recommended: true }] }),
  ok('multi: bounds', 'multi_choice', { options: OPTS, minSelected: 0, maxSelected: 2 }),
  bad('multi: min above max', 'multi_choice', { options: OPTS, minSelected: 2, maxSelected: 1 }),
  bad('multi: max zero', 'multi_choice', { options: OPTS, maxSelected: 0 }),
  bad('multi: min fractional', 'multi_choice', { options: OPTS, minSelected: 1.5 }),
  ok('short: minimal', 'short_text', {}),
  ok('short: everything', 'short_text', { placeholder: 'p', maxLength: 500, pattern: '[A-Z]{3}' }),
  bad('short: maxLength 501', 'short_text', { maxLength: 501 }),
  bad('short: bad pattern', 'short_text', { pattern: '(' }),
  bad('short: empty pattern', 'short_text', { pattern: '' }),
  bad('short: placeholder too long', 'short_text', { placeholder: 'p'.repeat(201) }),
  ok('long: minimal', 'long_text', {}),
  ok('long: bounds', 'long_text', { minLength: 10, maxLength: 20000 }),
  bad('long: min above max', 'long_text', { minLength: 11, maxLength: 10 }),
  bad('long: min above the default max', 'long_text', { minLength: 20001 }),
  bad('long: maxLength 20001', 'long_text', { maxLength: 20001 }),
  ok('scale: default', 'scale', {}),
  ok('scale: 0-10 with labels', 'scale', { min: 0, max: 10, minLabel: 'No', maxLabel: 'Yes' }),
  bad('scale: min 2', 'scale', { min: 2 }),
  bad('scale: max 11', 'scale', { max: 11 }),
  bad('scale: max 1', 'scale', { max: 1 }),
  bad('scale: label too long', 'scale', { minLabel: 'l'.repeat(101) }),
  { name: 'unknown type', type: 'nope', config: {}, expect: ['unknown_type'] },
];

/** `key:code`, sorted — the comparable verdict. */
export function verdict(issues: readonly { key?: string; code: string }[]): string[] {
  return issues.map((i) => (i.key === undefined ? i.code : `${i.key}:${i.code}`)).sort();
}
