/**
 * The `questionnaire` body block (FORMS-DESIGN §10): a form's panel body, with
 * Fill / Build / Responses tabs over one data hook. It reads the form's
 * structure from the entity detail and everything else through the forms
 * seam (`useFormsPort()`): the real port in production, a fixture port in
 * tests. It never imports a fixture itself.
 */
import { useId, useState } from 'react';
import type { EntityDetail } from '@tm8/contract';
import { Markdown, Pill } from '../kit';
import { BuildTab } from './BuildTab';
import { FillTab } from './FillTab';
import { FormStatusChip, FormsNavContext } from './parts';
import { ResponsesTab } from './ResponsesTab';
import { useQuestionnaire } from './useQuestionnaire';
import './questionnaire.css';

export type QuestionnaireTab = 'fill' | 'build' | 'responses';

const TABS: { id: QuestionnaireTab; word: string }[] = [
  { id: 'fill', word: 'Fill' },
  { id: 'build', word: 'Build' },
  { id: 'responses', word: 'Responses' },
];

export function QuestionnaireBlock({
  detail,
  initialTab = 'fill',
  onOpenEntity,
}: {
  detail: Pick<EntityDetail, 'id' | 'title' | 'version' | 'content'> & Partial<Pick<EntityDetail, 'capabilities'>>;
  initialTab?: QuestionnaireTab;
  /** Opens another entity (a delivery's spawned session). */
  onOpenEntity?: (id: string) => void;
}) {
  const q = useQuestionnaire(detail);
  const [tab, setTab] = useState<QuestionnaireTab>(initialTab);
  const base = useId();
  // §6: structure and lifecycle are the author's or an admin's. Absent
  // capabilities mean not permitted, the contract's rule.
  const canEdit = detail.capabilities?.canEdit === true;
  if (!q.form) {
    return q.detailError ? (
      <p className="fq__issues" role="alert" data-testid="questionnaire-unavailable">
        This form’s questions didn’t load: {q.detailError}
      </p>
    ) : (
      <p className="qn-muted">Loading the form…</p>
    );
  }
  const { content } = q.form;
  const count = q.responses?.length ?? 0;

  return (
    <FormsNavContext.Provider value={onOpenEntity ?? null}>
    <div className="qn" data-testid="questionnaire">
      <div className="qn-head">
        <FormStatusChip status={content.status} />
        {q.frozen ? (
          <span data-testid="frozen-chip" title="Questions froze at the first submitted response">
            <Pill tone="wait">Questions locked</Pill>
          </span>
        ) : null}
        <span className="qn-muted">
          {content.questions.length} question{content.questions.length === 1 ? '' : 's'} · {count} response{count === 1 ? '' : 's'}
        </span>
      </div>
      {content.description ? <Markdown source={content.description} className="pn-prose qn-description" /> : null}

      <div className="qn-tabs" role="tablist" aria-label="Form views">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            id={`${base}-tab-${t.id}`}
            aria-controls={`${base}-panel-${t.id}`}
            aria-selected={tab === t.id}
            className="qn-tab"
            onClick={() => setTab(t.id)}
          >
            {t.word}
            {t.id === 'responses' && count > 0 ? <span className="qn-tab__count">{count}</span> : null}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`${base}-panel-${tab}`} aria-labelledby={`${base}-tab-${tab}`} className="qn-panel">
        {q.error ? <p className="fq__issues" role="alert" data-testid="questionnaire-error">{q.error}</p> : null}
        {q.loading ? (q.error ? null : <p className="qn-muted">Loading…</p>) : (
          <>
            {tab === 'fill' ? <FillTab q={q} /> : null}
            {tab === 'build' ? <BuildTab q={q} canEdit={canEdit} /> : null}
            {tab === 'responses' ? <ResponsesTab q={q} /> : null}
          </>
        )}
      </div>
    </div>
    </FormsNavContext.Provider>
  );
}
