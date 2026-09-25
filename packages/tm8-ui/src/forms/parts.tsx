/**
 * The generic pieces every tab shares. None of them knows a question type:
 * `QuestionField` and `AnswerView` resolve an entry in the UI registry and
 * hand it a config/answer the contract's schemas parsed.
 */
import { createContext, useContext, useEffect, useId, useState, type ReactNode } from 'react';
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
import { DELIVERING_GRACE_MS, readDelivery, type DeliveryReading, type DeliveryState } from './delivery';
import { FormsPortError, type FormDeliveryView, type FormResponseView } from './seam';

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

/** Each real delivery state (delivery.ts) → its chip. The pulse is the kit's
    live marker (it holds still under `prefers-reduced-motion`). */
export const DELIVERY_CHIP: Record<DeliveryState, { tone: PillTone; word: string; dot?: 'pulse' }> = {
  delivering: { tone: 'info', word: 'Delivering…', dot: 'pulse' },
  queued: { tone: 'wait', word: 'Queued' },
  retrying: { tone: 'wait', word: 'Retrying' },
  redelivering: { tone: 'info', word: 'Sending to new session' },
  delivered: { tone: 'run', word: 'Delivered' },
  unverified: { tone: 'wait', word: 'Unverified' },
  spawned: { tone: 'info', word: 'New session' },
  cancelled: { tone: 'block', word: 'Not delivered' },
};

/**
 * A delivery's age against `since` (epoch ms; null ⇒ unknown), re-rendering
 * once when the "Delivering…" grace window runs out so the row falls back to
 * "Queued" on its own, with no response re-read.
 */
function useDeliveryAge(since: number | null | undefined): number | null {
  const [, tick] = useState(0);
  const age = since == null ? null : Math.max(0, Date.now() - since);
  const inWindow = age !== null && age < DELIVERING_GRACE_MS;
  useEffect(() => {
    if (!inWindow || since == null) return;
    const timer = setTimeout(() => tick((n) => n + 1), Math.max(0, since + DELIVERING_GRACE_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [since, inWindow]);
  return age;
}

function DeliveryPill({ status, reading }: { status: FormDeliveryView['status']; reading: DeliveryReading }) {
  const chip = DELIVERY_CHIP[reading.state];
  return (
    <span data-testid="delivery-chip" data-status={status} data-state={reading.state} title={reading.reason ?? reading.error ?? undefined}>
      <Pill tone={chip.tone} dot={chip.dot}>{chip.word}</Pill>
    </span>
  );
}

export function DeliveryChip({
  delivery,
  since,
}: {
  delivery: Pick<FormDeliveryView, 'status' | 'attempts' | 'lastError'>;
  /** When the delivery started (`deliveryStart`); absent ⇒ no grace window. */
  since?: number | null;
}) {
  return <DeliveryPill status={delivery.status} reading={readDelivery(delivery, useDeliveryAge(since))} />;
}

/**
 * How a panel opens another entity (a spawned session). Provided by the
 * block's host; absent ⇒ the session id is shown as text.
 */
export const FormsNavContext = createContext<((id: string) => void) | null>(null);

const RESUME_LATENCY = 'Resuming can take a couple of minutes.';
const NO_REDELIVER = 'This node can’t re-send deliveries yet (it lacks forms.responses.redeliver).';

const REFUSAL_TEXT: Record<string, string> = {
  delivery_not_cancelled: 'That delivery is no longer cancelled',
  delivery_not_pending: 'That delivery is no longer queued',
  session_deleted: 'That session was deleted',
};

/**
 * One delivery's chip, the line it owes the reader (§7.3), and its door:
 * "Resume now" on a queued/retrying row, "Send to a new session" on a
 * cancelled one — both through `forms.responses.redeliver`, disabled with the
 * reason when the node lacks it. A fresh row inside the grace window reads
 * "Delivering…" and offers no door yet.
 */
export function DeliveryNote({
  delivery,
  since,
  redeliver,
  onSettled,
}: {
  delivery: FormDeliveryView;
  /** When the delivery started (`deliveryStart`); absent ⇒ no grace window. */
  since?: number | null;
  /** `port.redeliver` bound to this response; undefined ⇒ the op is missing. */
  redeliver?: (workSessionId: string, to: 'resume' | 'new_session') => Promise<void>;
  /** After an action (done or refused): re-read the responses. */
  onSettled?: () => void;
}) {
  const reading = readDelivery(delivery, useDeliveryAge(since));
  const openEntity = useContext(FormsNavContext);
  const [phase, setPhase] = useState<'idle' | 'busy' | 'done'>('idle');
  const [notice, setNotice] = useState<string | null>(null);
  /** The row's status when an action went through: once it has moved on and
      left `pending`, the row speaks for itself again ("Resume requested"
      beside "Delivered" would be stale, and a new door may be owed). */
  const [actedFrom, setActedFrom] = useState<FormDeliveryView['status'] | null>(null);
  const done = phase === 'done' && (delivery.status === actedFrom || delivery.status === 'pending');

  const act = async (to: 'resume' | 'new_session') => {
    if (!redeliver) return;
    setPhase('busy');
    setNotice(null);
    try {
      await redeliver(delivery.workSessionId, to);
      setActedFrom(delivery.status);
      setPhase('done');
      setNotice(to === 'resume' ? `Resume requested. ${RESUME_LATENCY}` : 'Sent to a new session.');
    } catch (e) {
      setPhase('idle');
      setNotice(e instanceof FormsPortError && e.code === 'delivery_refused'
        ? `${REFUSAL_TEXT[e.reason ?? ''] ?? e.message}; showing the latest.`
        : `Couldn’t re-send: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      onSettled?.();
    }
  };

  let text: ReactNode;
  switch (reading.state) {
    case 'delivering':
      text = <>Delivering to the requesting session…</>;
      break;
    case 'queued':
      text = <>Answer saved; it will be delivered when the session resumes. {RESUME_LATENCY}</>;
      break;
    case 'retrying':
      text = <>Delivery is being retried{delivery.attempts > 0 ? ` (attempt ${delivery.attempts})` : ''}{reading.error ? `: ${reading.error}` : ''}.</>;
      break;
    case 'redelivering':
      text = <>Sending to a new session (before: {reading.reason}).</>;
      break;
    case 'unverified':
      text = <>Sent, but the session didn’t confirm it arrived{reading.error ? ` (${reading.error})` : ''}.</>;
      break;
    case 'spawned':
      text = delivery.spawnedSessionId ? (
        <>Delivered to a new session:{' '}
          {openEntity ? (
            <button type="button" className="qn-link" data-testid="delivery-spawned-link" onClick={() => openEntity(delivery.spawnedSessionId!)}>
              open it
            </button>
          ) : <code>{delivery.spawnedSessionId}</code>}
        </>
      ) : 'Delivered to a new session.';
      break;
    case 'cancelled':
      text = <>Not delivered: {reading.reason}. The answer is stored.</>;
      break;
    default:
      text = 'Delivered to the requesting session.';
  }

  const action = reading.action === 'resume'
    ? { to: 'resume' as const, word: 'Resume now' }
    : reading.action === 'new_session'
      ? { to: 'new_session' as const, word: 'Send to a new session' }
      : null;

  return (
    <div className="qn-delivery" data-testid="delivery-note" data-state={reading.state}>
      <DeliveryPill status={delivery.status} reading={reading} />
      <span className="qn-delivery__text">
        {text}
        {reading.redeliveredFrom ? <span className="qn-muted"> Re-sent from an earlier delivery.</span> : null}
      </span>
      {action && !done ? (
        <button
          type="button"
          className="pn-btn"
          disabled={!redeliver || phase === 'busy'}
          title={redeliver ? undefined : NO_REDELIVER}
          data-testid={`delivery-${action.to}`}
          onClick={() => void act(action.to)}
        >
          {action.word}
        </button>
      ) : null}
      {notice && (phase !== 'done' || done) ? <span className="qn-muted" role="status">{notice}</span> : null}
      {action && !redeliver ? <span className="qn-muted">{NO_REDELIVER}</span> : null}
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
