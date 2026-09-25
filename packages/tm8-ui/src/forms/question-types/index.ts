/**
 * THE UI QUESTION-TYPE REGISTRY (FORMS-DESIGN §4, W1 frontend).
 *
 * Each contract type is ONE entry here: one input component and one answer
 * renderer (plus, for choice types, what "accept recommended" picks, and for
 * counted types a `Summary` across responses). Nothing
 * else in the UI switches on a question type — `QuestionField` and
 * `AnswerView` only look an entry up, and the config/answer they hand it are
 * parsed by the CONTRACT registry's schemas.
 *
 * ADDING A TYPE (after its contract entry and SQL arm exist): one file in this
 * directory and one row below. The mapped type makes a missing row a compile
 * error, and `question-types.test.ts` checks the keys against
 * `FORM_QUESTION_TYPE_NAMES` at runtime.
 */
import { formQuestionTypeDef, type FormQuestionType } from '@tm8/contract';
import { longTextUI } from './long-text';
import { multiChoiceUI } from './multi-choice';
import { scaleUI } from './scale';
import { shortTextUI } from './short-text';
import { singleChoiceUI } from './single-choice';
import type { AnswerOf, ConfigOf, QuestionTypeUI } from './types';

export const QUESTION_TYPE_UI: { readonly [T in FormQuestionType]: QuestionTypeUI<ConfigOf<T>, AnswerOf<T>> } = {
  single_choice: singleChoiceUI,
  multi_choice: multiChoiceUI,
  short_text: shortTextUI,
  long_text: longTextUI,
  scale: scaleUI,
};

/**
 * One question, resolved: its UI entry plus its config and (optionally) an
 * answer parsed by the contract's schemas. `null` when the type is unknown or
 * the stored config/answer does not parse — callers fall back to raw JSON.
 */
export interface ResolvedQuestion {
  ui: QuestionTypeUI<unknown, unknown>;
  config: unknown;
  label: string;
}

export function resolveQuestion(type: string, config: unknown): ResolvedQuestion | null {
  const def = formQuestionTypeDef(type);
  const ui = Object.prototype.hasOwnProperty.call(QUESTION_TYPE_UI, type)
    ? (QUESTION_TYPE_UI as unknown as Record<string, QuestionTypeUI<unknown, unknown>>)[type]
    : undefined;
  if (!def || !ui) return null;
  const parsed = def.configSchema.safeParse(config ?? {});
  return parsed.success ? { ui, config: parsed.data, label: def.label } : null;
}

/** An answer shaped by the type's contract schema, or null. */
export function parseAnswer(type: string, answer: unknown): unknown {
  if (answer === null || answer === undefined) return null;
  const parsed = formQuestionTypeDef(type)?.answerSchema.safeParse(answer);
  return parsed?.success ? parsed.data : null;
}

export type { AnswerRendererProps, QuestionInputProps, QuestionTypeUI, SummaryAnswer, SummaryProps } from './types';
