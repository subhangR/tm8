/**
 * The shape of one UI question-type entry. The config and answer types are
 * the CONTRACT's (`FORM_QUESTION_TYPES[type].configSchema/answerSchema`
 * outputs), never restated here.
 */
import type { ComponentType } from 'react';
import type { FORM_QUESTION_TYPES } from '@tm8/contract';

type Defs = typeof FORM_QUESTION_TYPES;

/** The parsed config of a contract type (defaults applied). */
export type ConfigOf<T extends keyof Defs> = Defs[T]['configSchema']['_output'];
/** The parsed answer of a contract type. */
export type AnswerOf<T extends keyof Defs> = Defs[T]['answerSchema']['_output'];

export interface QuestionInputProps<C, A> {
  /** DOM id for the control (the question's label points at it). */
  id: string;
  /** The question title's element id, for groups that label themselves. */
  labelledBy: string;
  /** The help / issue ids, for `aria-describedby`. */
  describedBy?: string;
  config: C;
  /** `null` = unanswered. */
  value: A | null;
  /** Emit `null` when the answer becomes empty. */
  onChange(next: A | null): void;
  disabled?: boolean;
  invalid?: boolean;
}

export interface AnswerRendererProps<C, A> {
  config: C;
  answer: A;
}

/** One respondent's parsed answer, for a question's summary across responses. */
export interface SummaryAnswer<A> {
  responseId: string;
  respondent: string;
  answer: A;
}

export interface SummaryProps<C, A> {
  config: C;
  /** The answered responses only (never empty); unanswered ones are counted by the caller. */
  answers: readonly SummaryAnswer<A>[];
}

export interface QuestionTypeUI<C, A> {
  /** The respondent's control. */
  Input: ComponentType<QuestionInputProps<C, A>>;
  /** A submitted answer, read-only (Fill after submit, Responses, history). */
  Answer: ComponentType<AnswerRendererProps<C, A>>;
  /** "Accept recommended": the answer the recommended options make, or null. */
  recommended?(config: C): A | null;
  /**
   * Every loaded response's answer at once (Responses → Summary). Absent ⇒
   * the answers are listed, each by `Answer`, under its respondent.
   */
  Summary?: ComponentType<SummaryProps<C, A>>;
}

export function defineQuestionUI<C, A>(entry: QuestionTypeUI<C, A>): QuestionTypeUI<C, A> {
  return entry;
}
