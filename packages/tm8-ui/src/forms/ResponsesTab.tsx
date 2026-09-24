/**
 * RESPONSES — the current responses as a table, and one response's detail:
 * its answers, its revision chain and each delivery's status (§7.3). Drafts
 * never appear here: a draft reaches only its respondent (decision 10).
 */
import { useEffect, useState } from 'react';
import { Timestamp } from '../kit';
import { AnswerList, DeliveryChip, DeliveryNote, RevisionHistory, answeredCount } from './parts';
import type { FormResponseView, FormState, FormsPort } from './seam';
import { errorText, type Questionnaire } from './useQuestionnaire';

export function ResponsesTab({ q }: { q: Questionnaire }) {
  const { form, responses, port } = q;
  const [openId, setOpenId] = useState<string | null>(null);
  if (!form || !responses) return null;
  const open = responses.find((r) => r.id === openId);
  if (open) return <ResponseDetail form={form} response={open} port={port} onBack={() => setOpenId(null)} />;

  if (responses.length === 0) {
    return <p className="qn-muted" data-testid="responses-empty">No responses yet.</p>;
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
                  ? r.deliveries.map((d) => <DeliveryChip key={d.workSessionId} status={d.status} />)
                  : <span className="qn-muted">—</span>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function ResponseDetail({
  form, response, port, onBack,
}: {
  form: FormState;
  response: FormResponseView;
  port: FormsPort;
  onBack(): void;
}) {
  const [history, setHistory] = useState<FormResponseView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resumed, setResumed] = useState<Record<string, true>>({});

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
      </div>
      <h3 className="qn-detail__title">{response.respondentName ?? response.respondentId}</h3>
      <p className="qn-muted">
        Revision {response.revision} · submitted <Timestamp at={response.submittedAt} />
      </p>
      {response.deliveries.map((d) => (
        <DeliveryNote
          key={d.workSessionId}
          delivery={d}
          resumeState={resumed[d.workSessionId] ? 'requested' : 'idle'}
          onResume={() => {
            void port.resumeDelivery(response.id, d.workSessionId);
            setResumed((r) => ({ ...r, [d.workSessionId]: true }));
          }}
        />
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
