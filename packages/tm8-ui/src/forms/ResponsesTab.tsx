/**
 * RESPONSES — the current responses two ways (a Summary / Individual toggle,
 * Summary first): every question across the loaded responses
 * (ResponsesSummary.tsx), or a table and one response's detail: its answers,
 * its revision chain and each delivery's status (§7.3), with prev/next
 * between respondents. Both read the same loaded pages; "Load more" reads the
 * next. Drafts never appear here: a draft reaches only its respondent
 * (decision 10).
 */
import { useEffect, useId, useState } from 'react';
import { Timestamp } from '../kit';
import { AnswerList, DeliveryChip, DeliveryNote, RevisionHistory, answeredCount } from './parts';
import { ResponsesSummary } from './ResponsesSummary';
import { redeliverFor, type FormResponseView, type FormState, type FormsPort } from './seam';
import { errorText, type Questionnaire } from './useQuestionnaire';

export type ResponsesView = 'summary' | 'individual';

const VIEWS: { id: ResponsesView; word: string }[] = [
  { id: 'summary', word: 'Summary' },
  { id: 'individual', word: 'Individual' },
];

export function ResponsesTab({ q }: { q: Questionnaire }) {
  const { form, responses } = q;
  const [view, setView] = useState<ResponsesView>('summary');
  const [openId, setOpenId] = useState<string | null>(null);
  const base = useId();
  if (!form || !responses) return null;
  if (responses.length === 0) {
    return <p className="qn-muted" data-testid="responses-empty">No responses yet.</p>;
  }
  return (
    <div className="qn-responses">
      <div className="qn-seg" role="tablist" aria-label="Response views">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            role="tab"
            id={`${base}-view-${v.id}`}
            aria-controls={`${base}-viewpanel-${v.id}`}
            aria-selected={view === v.id}
            className="qn-seg__btn"
            onClick={() => setView(v.id)}
          >
            {v.word}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${base}-viewpanel-${view}`} aria-labelledby={`${base}-view-${view}`}>
        {view === 'summary'
          ? <ResponsesSummary form={form} responses={responses} hasMore={q.hasMore} />
          : <Individual q={q} form={form} responses={responses} openId={openId} setOpenId={setOpenId} />}
        <LoadMore q={q} shown={responses.length} />
      </div>
    </div>
  );
}

/** "N shown · Load more" while the server has another page. */
function LoadMore({ q, shown }: { q: Questionnaire; shown: number }) {
  if (!q.hasMore) return null;
  return (
    <div className="qn-more" data-testid="responses-more">
      <span className="qn-muted">{shown} shown</span>
      <button type="button" className="pn-btn" disabled={q.loadingMore} onClick={() => void q.loadMore()}>
        {q.loadingMore ? 'Loading more…' : 'Load more'}
      </button>
    </div>
  );
}

function Individual({
  q, form, responses, openId, setOpenId,
}: {
  q: Questionnaire;
  form: FormState;
  responses: FormResponseView[];
  openId: string | null;
  setOpenId(id: string | null): void;
}) {
  const at = responses.findIndex((r) => r.id === openId);
  const open = responses[at];
  if (open) {
    const prev = responses[at - 1];
    const next = responses[at + 1];
    return (
      <ResponseDetail
        key={open.id}
        form={form}
        response={open}
        port={q.port}
        onBack={() => setOpenId(null)}
        onSettled={() => void q.reload()}
        nav={{
          at: at + 1,
          of: responses.length,
          more: q.hasMore,
          ...(prev ? { onPrev: () => setOpenId(prev.id) } : {}),
          ...(next ? { onNext: () => setOpenId(next.id) } : {}),
        }}
      />
    );
  }

  const total = form.content.questions.length;
  return (
    <table className="qn-table" data-testid="responses-table">
      <thead>
        <tr>
          <th scope="col">Respondent</th>
          <th scope="col">Submitted</th>
          <th scope="col">Rev</th>
          <th scope="col">Answered</th>
          <th scope="col">Delivery</th>
        </tr>
      </thead>
      <tbody>
        {responses.map((r) => {
          const questions = r.questionsSnapshot?.questions ?? form.content.questions;
          return (
            <tr key={r.id} data-testid={`response-row-${r.id}`}>
              <td>
                <button type="button" className="qn-link" onClick={() => setOpenId(r.id)}>
                  {r.respondentName ?? r.respondentId}
                </button>
              </td>
              <td><Timestamp at={r.submittedAt} /></td>
              <td>{r.revision}</td>
              <td>{answeredCount(questions, r.answers)}/{r.questionsSnapshot?.questions.length ?? total}</td>
              <td>
                {r.deliveries.length > 0
                  ? r.deliveries.map((d) => <DeliveryChip key={d.workSessionId} delivery={d} />)
                  : <span className="qn-muted">—</span>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

interface DetailNav {
  /** 1-based position among the loaded responses. */
  at: number;
  of: number;
  /** More responses exist past the loaded ones. */
  more: boolean;
  onPrev?: () => void;
  onNext?: () => void;
}

function ResponseDetail({
  form, response, port, onBack, onSettled, nav,
}: {
  form: FormState;
  response: FormResponseView;
  port: FormsPort;
  onBack(): void;
  onSettled(): void;
  nav: DetailNav;
}) {
  const [history, setHistory] = useState<FormResponseView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    port.revisions(form.id, response.lineageKey)
      .then((h) => { if (live) setHistory(h); })
      .catch((e: unknown) => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, [port, form.id, response.lineageKey, response.id]);

  return (
    <div className="qn-detail" data-testid="response-detail">
      <div className="qn-bar">
        <button type="button" className="pn-btn pn-btn--quiet" onClick={onBack}>← All responses</button>
        <nav className="qn-pager" aria-label="Respondents">
          <button type="button" className="pn-btn pn-btn--quiet" disabled={!nav.onPrev} onClick={nav.onPrev}>‹ Previous</button>
          <span className="qn-muted" data-testid="response-position">
            {nav.at} of {nav.of}{nav.more ? ' loaded' : ''}
          </span>
          <button type="button" className="pn-btn pn-btn--quiet" disabled={!nav.onNext} onClick={nav.onNext}>Next ›</button>
        </nav>
      </div>
      <h3 className="qn-detail__title">{response.respondentName ?? response.respondentId}</h3>
      <p className="qn-muted">
        Revision {response.revision} · submitted <Timestamp at={response.submittedAt} />
      </p>
      {response.deliveries.map((d) => (
        <DeliveryNote key={d.workSessionId} delivery={d} redeliver={redeliverFor(port, response.id)} onSettled={onSettled} />
      ))}
      <AnswerList
        response={response}
        fallbackSections={form.content.sections}
        fallbackQuestions={form.content.questions}
        previous={history?.find((h) => h.id === response.supersedesId)?.answers}
      />
      {error ? <p className="fq__issues" role="alert">{error}</p> : null}
      {history && history.length > 1 ? (
        <RevisionHistory history={history} fallbackSections={form.content.sections} fallbackQuestions={form.content.questions} />
      ) : null}
    </div>
  );
}
