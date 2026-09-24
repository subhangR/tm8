/**
 * The generic pieces every tab shares. None of them knows a question type:
 * `QuestionField` and `AnswerView` resolve an entry in the UI registry and
 * hand it a config/answer the contract's schemas parsed.
 */
import { useId, type ReactNode } from 'react';
import {
  formAnswersEqual,
  type FormAnswerIssue,
  type FormAnswers,
  type FormQuestionRow,
  type FormSectionRow,
  type FormStatus,
} from '@tm8/contract';
import { Markdown, Pill, Timestamp, type PillTone } from '../kit';
import { parseAnswer, resolveQuestion } from './question-types';
import type { FormDeliveryStatus, FormDeliveryView, FormResponseView } from './seam';

// ---------------------------------------------------------------------------
// Chips
// ---------------------------------------------------------------------------

const STATUS_CHIP: Record<FormStatus, { tone: PillTone; word: string }> = {
  draft: { tone: 'idle', word: 'Draft' },
  open: { tone: 'run', word: 'Open' },
  closed: { tone: 'info', word: 'Closed' },
  cancelled: { tone: 'block', word: 'Cancelled' },
};

export function FormStatusChip({ status }: { status: FormStatus }) {
  const chip = STATUS_CHIP[status];
  return <Pill tone={chip.tone} dot="solid">{chip.word}</Pill>;
}

/** `pending` reads as "queued" (W2 may split out an in-flight state). */
export const DELIVERY_CHIP: Record<FormDeliveryStatus, { tone: PillTone; word: string }> = {
  delivered: { tone: 'run', word: 'Delivered' },
  pending: { tone: 'wait', word: 'Queued' },
  spawned: { tone: 'info', word: 'Spawned' },
  cancelled: { tone: 'idle', word: 'Cancelled' },
};

export function DeliveryChip({ status }: { status: FormDeliveryStatus }) {
  const chip = DELIVERY_CHIP[status];
  return (
    <span data-testid="delivery-chip" data-status={status}>
      <Pill tone={chip.tone}>{chip.word}</Pill>
    </span>
  );
}

/** The one line a delivery state owes the reader beyond its chip (§7.3). */
export function DeliveryNote({
  delivery,
  onResume,
  resumeState,
}: {
  delivery: FormDeliveryView;
  onResume?: () => void;
  resumeState?: 'idle' | 'requested';
}) {
  let text: ReactNode = null;
  switch (delivery.status) {
    case 'pending':
      text = 'Answer saved; will be delivered when the session resumes.';
      break;
    case 'spawned':
      text = delivery.spawnedSessionId ? `Delivered to a new session (${delivery.spawnedSessionId}).` : 'Delivered to a new session.';
      break;
    case 'cancelled':
      text = `Not delivered: the session is gone${delivery.lastError ? ` (${delivery.lastError})` : ''}. The answer is stored.`;
      break;
    default:
      text = 'Delivered to the requesting session.';
  }
  return (
    <div className="qn-delivery" data-testid="delivery-note">
      <DeliveryChip status={delivery.status} />
      <span className="qn-delivery__text">{text}</span>
      {delivery.status === 'pending' && onResume ? (
        resumeState === 'requested' ? (
          <span className="qn-muted">Resume requested (delivery wiring lands in W3).</span>
        ) : (
          <button type="button" className="pn-btn" onClick={onResume}>Resume now</button>
        )
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

export interface QuestionGroup {
  section: FormSectionRow | null;
  questions: FormQuestionRow[];
}

/** Unsectioned questions first, then one group per section, each in position order. */
export function groupBySection(sections: readonly FormSectionRow[], questions: readonly FormQuestionRow[]): QuestionGroup[] {
  const ordered = [...questions].sort((a, b) => a.position - b.position);
  const known = new Set(sections.map((s) => s.key));
  const groups: QuestionGroup[] = [];
  const loose = ordered.filter((q) => !q.section || !known.has(q.section));
  if (loose.length > 0) groups.push({ section: null, questions: loose });
  for (const section of [...sections].sort((a, b) => a.position - b.position)) {
    groups.push({ section, questions: ordered.filter((q) => q.section === section.key) });
  }
  return groups;
}

export function SectionHeading({ section }: { section: FormSectionRow }) {
  return (
    <div className="qn-section">
      <h3 className="qn-section__title">{section.title}</h3>
      {section.help ? <Markdown source={section.help} className="pn-prose qn-section__help" /> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One question, as an input
// ---------------------------------------------------------------------------

export function QuestionField({
  question,
  value,
  onChange,
  issues = [],
  disabled,
}: {
  question: FormQuestionRow;
  value: unknown;
  onChange(next: unknown): void;
  issues?: readonly FormAnswerIssue[];
  disabled?: boolean;
}) {
  const base = useId();
  const titleId = `${base}-t`;
  const inputId = `${base}-i`;
  const helpId = `${base}-h`;
  const issueId = `${base}-e`;
  const resolved = resolveQuestion(question.type, question.config);
  const describedBy = [question.help ? helpId : null, issues.length ? issueId : null].filter(Boolean).join(' ') || undefined;
  const Input = resolved?.ui.Input;
  return (
    <div className="fq" data-testid={`question-${question.key}`} data-invalid={issues.length > 0 || undefined}>
      <div className="fq__head">
        <label id={titleId} htmlFor={inputId} className="fq__title">{question.title}</label>
        <span className="fq__req">{question.required ? 'Required' : 'Optional'}</span>
      </div>
      {question.help ? (
        <div id={helpId}><Markdown source={question.help} className="pn-prose fq__help" /></div>
      ) : null}
      {Input && resolved ? (
        <Input
          id={inputId}
          labelledBy={titleId}
          describedBy={describedBy}
          config={resolved.config}
          value={parseAnswer(question.type, value)}
          onChange={onChange}
          disabled={disabled}
          invalid={issues.length > 0}
        />
      ) : (
        <p className="qn-muted">This question's type ({question.type}) cannot be shown here.</p>
      )}
      {issues.length > 0 ? (
        <ul id={issueId} className="fq__issues" role="alert">
          {issues.map((i) => <li key={`${i.code}:${i.message}`}>{i.code === 'required' ? 'An answer is required.' : i.message}</li>)}
        </ul>
      ) : null}
    </div>
  );
}

/** Every question, grouped under its section heading (decision 5). */
export function QuestionFields({
  sections,
  questions,
  answers,
  onChange,
  issues = [],
  disabled,
}: {
  sections: readonly FormSectionRow[];
  questions: readonly FormQuestionRow[];
  answers: FormAnswers;
  onChange(key: string, next: unknown): void;
  issues?: readonly FormAnswerIssue[];
  disabled?: boolean;
}) {
  return (
    <div className="qn-fields">
      {groupBySection(sections, questions).map((group) => (
        <section key={group.section?.key ?? '§'} className="qn-group">
          {group.section ? <SectionHeading section={group.section} /> : null}
          {group.questions.map((q) => (
            <QuestionField
              key={q.key}
              question={q}
              value={answers[q.key] ?? null}
              onChange={(next) => onChange(q.key, next)}
              issues={issues.filter((i) => i.key === q.key)}
              disabled={disabled}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Answers, read-only
// ---------------------------------------------------------------------------

export function AnswerView({ question, answer }: { question: FormQuestionRow; answer: unknown }) {
  if (answer === null || answer === undefined) return <span className="fq-answer__none">No answer</span>;
  const resolved = resolveQuestion(question.type, question.config);
  const parsed = parseAnswer(question.type, answer);
  if (!resolved || parsed === null) return <code className="fq-answer__raw">{JSON.stringify(answer)}</code>;
  const Answer = resolved.ui.Answer;
  return <Answer config={resolved.config} answer={parsed} />;
}

/** A response's answers under the questions it answered (its snapshot when it has one). */
export function AnswerList({
  response,
  fallbackSections,
  fallbackQuestions,
  previous,
}: {
  response: Pick<FormResponseView, 'answers' | 'questionsSnapshot'>;
  fallbackSections: readonly FormSectionRow[];
  fallbackQuestions: readonly FormQuestionRow[];
  /** The revision before this one: changed answers get a marker. */
  previous?: FormAnswers;
}) {
  const sections = response.questionsSnapshot?.sections ?? fallbackSections;
  const questions = response.questionsSnapshot?.questions ?? fallbackQuestions;
  return (
    <div className="qn-answers">
      {groupBySection(sections, questions).map((group) => (
        <section key={group.section?.key ?? '§'} className="qn-group">
          {group.section ? <SectionHeading section={group.section} /> : null}
          <dl className="qn-answers__list">
            {group.questions.map((q) => {
              const changed = previous !== undefined && !formAnswersEqual(q, response.answers[q.key], previous[q.key]);
              return (
                <div key={q.key} className="qn-answers__row" data-testid={`answer-${q.key}`} data-changed={changed || undefined}>
                  <dt className="qn-answers__q">
                    {q.title}
                    {changed ? <span className="qn-changed">Changed</span> : null}
                  </dt>
                  <dd className="qn-answers__a"><AnswerView question={q} answer={response.answers[q.key]} /></dd>
                </div>
              );
            })}
          </dl>
        </section>
      ))}
    </div>
  );
}

export function changedCount(
  questions: readonly FormQuestionRow[],
  answers: FormAnswers,
  previous: FormAnswers,
): number {
  return questions.filter((q) => !formAnswersEqual(q, answers[q.key], previous[q.key])).length;
}

/** Revision history, newest first, each expandable, with "Changed (n)" against its predecessor. */
export function RevisionHistory({
  history,
  fallbackSections,
  fallbackQuestions,
}: {
  history: readonly FormResponseView[];
  fallbackSections: readonly FormSectionRow[];
  fallbackQuestions: readonly FormQuestionRow[];
}) {
  if (history.length === 0) return null;
  const ordered = [...history].sort((a, b) => b.revision - a.revision);
  return (
    <div className="qn-history" data-testid="revision-history">
      <h4 className="qn-subhead">Revision history</h4>
      <ol className="qn-history__list">
        {ordered.map((r) => {
          const prev = history.find((h) => h.id === r.supersedesId);
          const questions = r.questionsSnapshot?.questions ?? fallbackQuestions;
          const changed = prev ? changedCount(questions, r.answers, prev.answers) : null;
          return (
            <li key={r.id} className="qn-history__item" data-testid={`revision-${r.revision}`}>
              <details>
                <summary className="qn-history__summary">
                  <span className="qn-history__rev">Revision {r.revision}</span>
                  <Timestamp at={r.submittedAt} className="qn-muted" />
                  {r.isCurrent ? <Pill tone="brand">Current</Pill> : null}
                  <span className="qn-muted">{changed === null ? 'First answer' : `Changed (${changed})`}</span>
                </summary>
                <AnswerList
                  response={r}
                  fallbackSections={fallbackSections}
                  fallbackQuestions={fallbackQuestions}
                  previous={prev?.answers}
                />
              </details>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Answers present on questions (unknown keys and nulls do not count). */
export function answeredCount(questions: readonly FormQuestionRow[], answers: FormAnswers): number {
  return questions.filter((q) => answers[q.key] !== null && answers[q.key] !== undefined).length;
}

/** Drop unanswered keys: the server stores `{ [key]: Answer }`, nulls add nothing. */
export function compactAnswers(answers: FormAnswers): FormAnswers {
  const out: FormAnswers = {};
  for (const [k, v] of Object.entries(answers)) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

export function Notice({ tone, title, children, testId }: { tone: 'info' | 'wait' | 'block' | 'idle'; title: string; children?: ReactNode; testId?: string }) {
  return (
    <div className={`qn-notice qn-notice--${tone}`} role="status" data-testid={testId}>
      <strong className="qn-notice__title">{title}</strong>
      {children ? <div className="qn-notice__body">{children}</div> : null}
    </div>
  );
}
