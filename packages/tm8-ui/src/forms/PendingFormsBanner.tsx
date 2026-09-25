/**
 * The pending-forms banner at the top of a session panel (decision 11).
 *
 * It lists the forms this session asked the viewer to answer and opens each
 * one's Fill view INLINE: the same #730 FillTab over the same forms port the
 * form panel uses, so validation, autosave and submit behave the same way. A
 * submitted form drops out of the next `forms.pendingForSessions` answer, so
 * the item, and then the banner, disappears.
 *
 * It also says when answers are QUEUED for this session (R4): a queued answer
 * waits until the session runs again. "Resume now" is offered only when the
 * host wires a resume for this panel, which it does only for a session that
 * has ended. The server still decides whether this viewer may resume it.
 */
import { useEffect, useState } from 'react';
import { Timestamp } from '../kit';
import { FillTab } from './FillTab';
import {
  answersQueuedText,
  formsWaitingText,
  usePendingForms,
  usePendingFormsStore,
  type FormPendingItem,
  type PendingFormsStore,
} from './pending';
import { errorText, useQuestionnaire, type QuestionnaireDetail } from './useQuestionnaire';
import './questionnaire.css';
import './pending-forms.css';

export function PendingFormsBanner({
  sessionId,
  onResume,
  resuming = false,
}: {
  sessionId: string;
  /** Resume this session. Absent ⇒ the queued line says so, with no button. */
  onResume?: () => void;
  resuming?: boolean;
}) {
  const store = usePendingFormsStore();
  const pending = usePendingForms(sessionId);
  const [openId, setOpenId] = useState<string | null>(null);
  if (!store || !pending || (pending.total === 0 && pending.queued === 0)) return null;

  const hidden = pending.total - pending.forms.length;
  return (
    <section className="pf-banner" data-testid="pending-forms-banner" aria-label="Forms waiting on you">
      {pending.total > 0 ? (
        <>
          <div className="pf-banner__head">{formsWaitingText(pending.total)}</div>
          <ul className="pf-banner__list">
            {pending.forms.map((item) => (
              <PendingFormRow
                key={item.formId}
                item={item}
                store={store}
                open={openId === item.formId}
                onToggle={() => setOpenId((id) => (id === item.formId ? null : item.formId))}
              />
            ))}
          </ul>
          {hidden > 0 ? <p className="pf-banner__meta">and {hidden} more</p> : null}
        </>
      ) : null}
      {pending.queued > 0 ? (
        <div className="pf-banner__queued" data-testid="pending-forms-queued">
          <span>
            {answersQueuedText(pending.queued)}: delivered when the session resumes.
          </span>
          {onResume ? (
            <button type="button" className="pn-btn" onClick={onResume} disabled={resuming}>
              {resuming ? 'Resuming…' : 'Resume now'}
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function PendingFormRow({
  item, store, open, onToggle,
}: {
  item: FormPendingItem;
  store: PendingFormsStore;
  open: boolean;
  onToggle(): void;
}) {
  return (
    <li className="pf-banner__item" data-testid="pending-form" data-form-id={item.formId}>
      <div className="pf-banner__row">
        <span className="pf-banner__title" title={item.title}>{item.title}</span>
        <span className="pf-banner__meta">
          {item.questionCount} question{item.questionCount === 1 ? '' : 's'}
          {item.draft ? ' · draft saved' : ''}
          {item.openedAt ? <> · <Timestamp at={item.openedAt} /></> : null}
        </span>
        <button
          type="button"
          className={`pn-btn${open ? '' : ' pn-btn--primary'}`}
          aria-expanded={open}
          onClick={onToggle}
        >
          {open ? 'Hide' : item.draft ? 'Continue' : 'Answer'}
        </button>
      </div>
      {open ? <InlineFill formId={item.formId} version={item.version} store={store} /> : null}
    </li>
  );
}

/** Loads the form's detail, then renders the questionnaire's Fill view against it. */
function InlineFill({ formId, version, store }: { formId: string; version: number; store: PendingFormsStore }) {
  const [detail, setDetail] = useState<QuestionnaireDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    store.source.formDetail(formId).then(
      (d) => { if (live) { setDetail(d); setError(null); } },
      (e: unknown) => { if (live) setError(errorText(e)); },
    );
    return () => { live = false; };
    // A newer form version (a structure edit) re-reads the questions.
  }, [store, formId, version]);

  if (error) return <p className="pf-banner__error" role="alert">{error}</p>;
  if (!detail) return <p className="qn-muted">Loading…</p>;
  return <InlineQuestionnaire detail={detail} store={store} />;
}

function InlineQuestionnaire({ detail, store }: { detail: QuestionnaireDetail; store: PendingFormsStore }) {
  const q = useQuestionnaire(detail);
  // Save, discard and submit are private writes with no space event for the
  // store to see; the port says the form changed, and the store re-asks.
  useEffect(() => q.port.subscribe(detail.id, () => store.refresh()), [q.port, detail.id, store]);
  if (!q.form) return <p className="qn-muted">This form’s questions didn’t load.</p>;
  return (
    <div className="pf-banner__fill qn" data-testid="pending-form-fill">
      {q.error ? <p className="fq__issues" role="alert">{q.error}</p> : null}
      {q.loading ? <p className="qn-muted">Loading…</p> : <FillTab q={q} />}
    </div>
  );
}
