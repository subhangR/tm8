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
  initialTab,
  onOpenEntity,
}: {
  detail: Pick<EntityDetail, 'id' | 'title' | 'version' | 'content'> & Partial<Pick<EntityDetail, 'capabilities'>>;
  /** Absent: Build for an editor opening a draft (nothing to fill yet), else Fill. */
  initialTab?: QuestionnaireTab;
  /** Opens another entity (a delivery's spawned session). */
  onOpenEntity?: (id: string) => void;
}) {
  const q = useQuestionnaire(detail);
  // §6: structure and lifecycle are the author's or an admin's. Absent
  // capabilities mean not permitted, the contract's rule.
  const canEdit = detail.capabilities?.canEdit === true;
  // A list row's content carries `status` too, so this holds before the detail loads.
  const draft = (detail.content as { status?: unknown } | null | undefined)?.status === 'draft';
  const [tab, setTab] = useState<QuestionnaireTab>(initialTab ?? (canEdit && draft ? 'build' : 'fill'));
  const base = useId();
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
  // Only the loaded pages are counted: the list API carries no total.
  const shown = `${count}${q.hasMore ? '+' : ''}`;

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
          {content.questions.length} question{content.questions.length === 1 ? '' : 's'} · {shown} response{count === 1 && !q.hasMore ? '' : 's'}
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
            {t.id === 'responses' && count > 0 ? <span className="qn-tab__count">{shown}</span> : null}
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
