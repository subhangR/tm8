/**
 * FILL — the respondent's view (FORMS-DESIGN §10, decisions 6 and 8).
 *
 * Open form, nothing submitted: the questions, with autosave to a draft,
 * "Accept recommended" and client validation from the contract registry.
 * Submitted: the member's answers, their delivery, the revision history and
 * "Edit & resubmit" (allowAmend, default on). While the submit is on the
 * wire its button spins and reads "Submitting…"; the delivery that follows
 * reads "Delivering…" for its grace window (delivery.ts). Draft / closed /
 * cancelled forms say so instead of offering inputs that would be refused.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { validateFormAnswers, type FormAnswerIssue, type FormAnswers } from '@tm8/contract';
import { Timestamp } from '../kit';
import {
  AnswerList,
  DeliveryNote,
  Notice,
  QuestionFields,
  RevisionHistory,
  compactAnswers,
} from './parts';
import { resolveQuestion } from './question-types';
import { FormsPortError, redeliverFor, type FormResponseView, type FormState, type FormsPort } from './seam';
import { errorText, type Questionnaire } from './useQuestionnaire';

/** Idle time before a change is saved as a draft. */
export const AUTOSAVE_MS = 800;

type Editing = { supersedesId: string | null } | null;

export function FillTab({ q }: { q: Questionnaire }) {
  const { form, mine, port } = q;
  const [editing, setEditing] = useState<Editing>(null);
  /** Bumped by "Reload" after a conflict: remounts the form from the server's state. */
  const [generation, setGeneration] = useState(0);
  if (!form || !mine) return null;
  const { status, settings } = form.content;

  if (status === 'draft') {
    return (
      <Notice tone="idle" title="Not open yet" testId="fill-draft">
        This form is a draft, so it can’t be answered yet. The author can preview it in Build and open it from there.
      </Notice>
    );
  }

  const readOnly = status !== 'open';
  const closedNotice = status === 'closed' ? (
    <Notice tone="info" title="Closed" testId="fill-closed">
      This form no longer takes answers{form.content.closedAt ? <> (closed <Timestamp at={form.content.closedAt} />)</> : null}.
    </Notice>
  ) : status === 'cancelled' ? (
    <Notice tone="block" title="Cancelled" testId="fill-cancelled">
      The requester cancelled this form. Nothing more will be delivered.
    </Notice>
  ) : null;

  // A draft on the server always wins: the member left mid-edit and came back.
  const target: Editing = !readOnly && mine.draft
    ? { supersedesId: mine.draft.supersedesId }
    : !readOnly ? editing : null;

  if (target || (!mine.current && !readOnly)) {
    const supersedesId = target?.supersedesId ?? null;
    const amendOf = supersedesId ? mine.history.find((r) => r.id === supersedesId) ?? mine.current : null;
    const initial = mine.draft?.answers ?? amendOf?.answers ?? {};
    return (
      <FillForm
        key={`${supersedesId ?? 'new'}:${form.content.structureVersion}:${generation}`}
        form={form}
        port={port}
        initial={initial}
        draft={mine.draft}
        supersedesId={supersedesId}
        amendOfRevision={amendOf?.revision ?? null}
        onSubmitted={async () => {
          q.markSubmitted();
          await q.reload();
          setEditing(null);
        }}
        onCancel={mine.current ? async () => {
          if (mine.draft) await port.discardDraft(form.id, mine.draft);
          await q.reload();
          setEditing(null);
        } : null}
        onReload={async () => {
          await Promise.all([q.reload(), q.refetchForm()]);
          setGeneration((g) => g + 1);
        }}
      />
    );
  }

  return (
    <div className="qn-fill" data-testid="fill-submitted">
      {closedNotice}
      {mine.current ? (
        <SubmittedView
          form={form}
          current={mine.current}
          history={mine.history}
          since={q.deliverySince(mine.current)}
          port={port}
          onSettled={q.followDeliveries}
          canAmend={!readOnly && settings.allowAmend}
          amendOff={!readOnly && !settings.allowAmend}
          canSubmitAnother={!readOnly && settings.responses === 'unlimited'}
          onEdit={() => setEditing({ supersedesId: mine.current!.id })}
          onAnother={() => setEditing({ supersedesId: null })}
        />
      ) : (
        <p className="qn-muted" data-testid="fill-no-answer">You didn’t answer this form.</p>
      )}
    </div>
  );
}

function SubmittedView({
  form, current, history, since, port, onSettled, canAmend, amendOff, canSubmitAnother, onEdit, onAnother,
}: {
  form: FormState;
  current: FormResponseView;
  history: FormResponseView[];
  /** When `current`'s delivery started, for the "Delivering…" grace window. */
  since: number | null;
  port: FormsPort;
  onSettled(): void;
  canAmend: boolean;
  amendOff: boolean;
  canSubmitAnother: boolean;
  onEdit(): void;
  onAnother(): void;
}) {
  return (
    <>
      <div className="qn-bar">
        <span className="qn-bar__lead">
          Submitted <Timestamp at={current.submittedAt} />
          {current.revision > 1 ? ` · revision ${current.revision}` : ''}
        </span>
        <span className="qn-bar__actions">
          {canSubmitAnother ? <button type="button" className="pn-btn" onClick={onAnother}>Submit another</button> : null}
          {canAmend ? <button type="button" className="pn-btn pn-btn--primary" onClick={onEdit}>Edit &amp; resubmit</button> : null}
        </span>
      </div>
      {amendOff ? <p className="qn-muted">This form doesn’t accept changes after submitting.</p> : null}
      {current.deliveries.map((d) => (
        <DeliveryNote key={d.workSessionId} delivery={d} since={since} redeliver={redeliverFor(port, current.id)} onSettled={onSettled} />
      ))}
      <AnswerList response={current} fallbackSections={form.content.sections} fallbackQuestions={form.content.questions} />
      {history.length > 1 ? (
        <RevisionHistory history={history} fallbackSections={form.content.sections} fallbackQuestions={form.content.questions} />
      ) : null}
    </>
  );
}

type SaveState = 'clean' | 'dirty' | 'saving' | 'saved' | 'invalid' | 'error' | 'blocked';

const SAVE_WORD: Record<SaveState, string> = {
  clean: '',
  dirty: 'Unsaved changes',
  saving: 'Saving…',
  saved: 'Draft saved',
  invalid: 'Not saved: fix the marked answers',
  error: 'Couldn’t save the draft',
  blocked: 'Not saved',
};

/** A refusal the member must act on before editing on (server error codes, mapped). */
type Blocker = 'draft_in_flight' | 'version_conflict';

function FillForm({
  form, port, initial, draft, supersedesId, amendOfRevision, onSubmitted, onCancel, onReload,
}: {
  form: FormState;
  port: FormsPort;
  initial: FormAnswers;
  draft: FormResponseView | null;
  supersedesId: string | null;
  amendOfRevision: number | null;
  onSubmitted(): Promise<void>;
  onCancel: (() => Promise<void>) | null;
  onReload(): Promise<void>;
}) {
  const { questions, sections } = form.content;
  const [answers, setAnswers] = useState<FormAnswers>(initial);
  const [attempted, setAttempted] = useState(false);
  const [save, setSave] = useState<SaveState>(draft ? 'saved' : 'clean');
  const [serverIssues, setServerIssues] = useState<FormAnswerIssue[]>([]);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<FormAnswers | null>(null);
  /** The save on the wire, if any: a submit waits for it, or the save would
      land after the submit and open a phantom amend draft of the new revision. */
  const inflight = useRef<Promise<unknown> | null>(null);
  /** The draft's version: every save and the submit send it (`responseVersion`). */
  const draftVersion = useRef<number | undefined>(draft?.version);
  const [blocker, setBlocker] = useState<Blocker | null>(null);

  /** A refusal → what the member sees; true when it was one we map. */
  const refusal = (e: unknown): boolean => {
    if (!(e instanceof FormsPortError)) return false;
    if (e.code === 'form_answers_invalid') {
      setServerIssues(e.issues);
      return true;
    }
    if (e.code === 'draft_in_flight' || e.code === 'version_conflict') {
      setBlocker(e.code);
      return true;
    }
    return false;
  };

  const flush = useCallback(async () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    const next = pending.current;
    pending.current = null;
    if (!next) return;
    if (validateFormAnswers(questions, next, { final: false }).length > 0) {
      setSave('invalid');
      return;
    }
    setSave('saving');
    const saving = port.saveDraft(form.id, {
      answers: next,
      supersedesId,
      ...(draftVersion.current ? { responseVersion: draftVersion.current } : {}),
    });
    inflight.current = saving;
    try {
      const saved = await saving;
      draftVersion.current = saved.version;
      setSave((s) => (s === 'saving' ? 'saved' : s));
    } catch (e) {
      const code = e instanceof FormsPortError ? e.code : null;
      setSave(refusal(e) ? (code === 'form_answers_invalid' ? 'invalid' : 'blocked') : 'error');
    } finally {
      if (inflight.current === saving) inflight.current = null;
    }
  }, [port, form.id, questions, supersedesId]);

  /** "Discard the other draft": clear the server's draft, then save this one. */
  const discardOther = async () => {
    setBlocker(null);
    try {
      await port.discardDraft(form.id);
      draftVersion.current = undefined;
      pending.current = compactAnswers(answersRef.current);
      await flush();
    } catch (e) {
      if (!refusal(e)) setSubmitError(errorText(e));
    }
  };

  // Leaving the tab mid-debounce still saves.
  useEffect(() => () => { void flush(); }, [flush]);

  const stopAutosave = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
  };

  const answersRef = useRef(answers);
  answersRef.current = answers;

  const change = (next: FormAnswers) => {
    setAnswers(next);
    setServerIssues([]);
    pending.current = compactAnswers(next);
    setSave('dirty');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), AUTOSAVE_MS);
  };

  // Live issues: shape and bounds always; `required` once a submit was tried.
  const issues = useMemo(() => {
    const local = validateFormAnswers(questions, compactAnswers(answers), { final: attempted });
    return [...local, ...serverIssues.filter((s) => !local.some((l) => l.key === s.key))];
  }, [questions, answers, attempted, serverIssues]);

  const recommended = useMemo(() => {
    const out: FormAnswers = {};
    for (const question of questions) {
      const resolved = resolveQuestion(question.type, question.config);
      const pick = resolved?.ui.recommended?.(resolved.config);
      if (pick) out[question.key] = pick as Record<string, unknown>;
    }
    return out;
  }, [questions]);
  const recommendable = Object.keys(recommended).filter((k) => answers[k] === undefined || answers[k] === null);

  const submit = async () => {
    setAttempted(true);
    const payload = compactAnswers(answers);
    const final = validateFormAnswers(questions, payload, { final: true });
    if (final.length > 0) {
      document.querySelector(`[data-testid="question-${final[0]!.key}"]`)?.scrollIntoView?.({ block: 'center' });
      return;
    }
    stopAutosave();
    setSubmitting(true);
    setSubmitError(null);
    try {
      await inflight.current?.catch(() => undefined);
      await port.submit(form.id, {
        answers: payload,
        supersedesId,
        ...(draftVersion.current ? { responseVersion: draftVersion.current } : {}),
      });
      await onSubmitted();
    } catch (e) {
      // A blocker has its own notice; everything else (field issues included) says why here.
      const blocked = refusal(e) && e instanceof FormsPortError && e.code !== 'form_answers_invalid';
      if (!blocked) setSubmitError(errorText(e));
      setSubmitting(false);
    }
  };

  return (
    <div className="qn-fill" data-testid="fill-form">
      {amendOfRevision !== null ? (
        <Notice tone="info" title={`Editing revision ${amendOfRevision}`}>
          Submitting makes revision {amendOfRevision + 1}; it is delivered again and your earlier answers stay in the history.
        </Notice>
      ) : null}
      {blocker === 'draft_in_flight' ? (
        <Notice tone="wait" title="Another draft is in flight" testId="fill-draft-in-flight">
          You have an unsent draft on this form for a different revision, so this one can’t be saved.{' '}
          <button type="button" className="pn-btn" onClick={() => void discardOther()}>Discard the other draft</button>
        </Notice>
      ) : null}
      {blocker === 'version_conflict' ? (
        <Notice tone="wait" title="This changed elsewhere" testId="fill-version-conflict">
          Your draft or the answer you’re editing changed since this page loaded (another tab, or a new revision).{' '}
          <button type="button" className="pn-btn" onClick={() => void onReload()}>Reload</button>
        </Notice>
      ) : null}
      <div className="qn-bar">
        <span className="qn-bar__lead qn-muted" data-testid="save-state" aria-live="polite">{SAVE_WORD[save]}</span>
        <span className="qn-bar__actions">
          {recommendable.length > 0 ? (
            <button
              type="button"
              className="pn-btn"
              onClick={() => change({ ...answers, ...Object.fromEntries(recommendable.map((k) => [k, recommended[k]!])) })}
            >
              Accept recommended
            </button>
          ) : null}
        </span>
      </div>
      <QuestionFields
        sections={sections}
        questions={questions}
        answers={answers}
        issues={issues}
        disabled={submitting}
        onChange={(key, next) => change({ ...answers, [key]: next as FormAnswers[string] })}
      />
      {submitError ? <p className="fq__issues" role="alert">{submitError}</p> : null}
      <div className="qn-bar qn-bar--foot">
        <span className="qn-bar__lead qn-muted">
          {attempted && issues.length > 0 ? `${new Set(issues.map((i) => i.key)).size} answer(s) need attention` : ''}
        </span>
        <span className="qn-bar__actions">
          {onCancel ? (
            <button type="button" className="pn-btn pn-btn--quiet" onClick={() => { stopAutosave(); void onCancel(); }}>
              Discard changes
            </button>
          ) : null}
          <button
            type="button"
            className="pn-btn pn-btn--primary qn-submit"
            disabled={submitting}
            aria-busy={submitting || undefined}
            onClick={() => void submit()}
          >
            {submitting ? <span className="qn-spinner" aria-hidden="true" /> : null}
            {amendOfRevision !== null
              ? (submitting ? 'Resubmitting…' : 'Resubmit')
              : (submitting ? 'Submitting…' : 'Submit')}
          </button>
        </span>
      </div>
    </div>
  );
}
