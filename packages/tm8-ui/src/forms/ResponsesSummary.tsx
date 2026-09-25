/**
 * RESPONSES → SUMMARY — every question, in section order, across the LOADED
 * current responses: a type's own `Summary` (counts, distribution) when its
 * registry entry has one, else each answer under its respondent.
 *
 * The questions are the responses' snapshots (they freeze at the first
 * submit, so they agree); should two disagree, questions are matched by KEY,
 * a question only one snapshot has is added, and an answer that no longer
 * parses under its question's type is counted, never rendered raw.
 */
import type { FormQuestionRow, FormSectionRow } from '@tm8/contract';
import { SectionHeading, groupBySection } from './parts';
import { parseAnswer, resolveQuestion, type SummaryAnswer } from './question-types';
import type { FormResponseView, FormState } from './seam';

interface SummaryStructure {
  sections: FormSectionRow[];
  questions: FormQuestionRow[];
}

/** The newest snapshot (the form's own structure without one), plus any key only an older snapshot has. */
export function summaryStructure(form: FormState, responses: readonly FormResponseView[]): SummaryStructure {
  const base = responses.find((r) => r.questionsSnapshot)?.questionsSnapshot ?? form.content;
  const sections = [...base.sections];
  const questions = [...base.questions];
  const keys = new Set(questions.map((q) => q.key));
  const sectionKeys = new Set(sections.map((s) => s.key));
  let position = Math.max(-1, ...questions.map((q) => q.position));
  for (const r of responses) {
    for (const s of r.questionsSnapshot?.sections ?? []) {
      if (!sectionKeys.has(s.key)) { sectionKeys.add(s.key); sections.push({ ...s, position: sections.length }); }
    }
    for (const q of r.questionsSnapshot?.questions ?? []) {
      if (!keys.has(q.key)) { keys.add(q.key); questions.push({ ...q, position: ++position }); }
    }
  }
  return { sections, questions };
}

export function ResponsesSummary({
  form, responses, hasMore,
}: {
  form: FormState;
  responses: readonly FormResponseView[];
  /** More current responses exist than are loaded: the summary says so. */
  hasMore: boolean;
}) {
  const { sections, questions } = summaryStructure(form, responses);
  const n = responses.length;
  return (
    <div className="qn-summary" data-testid="responses-summary">
      <p className="qn-muted qn-summary__scope" data-testid="summary-scope">
        {hasMore
          ? `Summary of the ${n} loaded responses. More exist: load them to include them.`
          : `Summary of all ${n} response${n === 1 ? '' : 's'}.`}
      </p>
      {groupBySection(sections, questions).map((group) => (
        <section key={group.section?.key ?? '§'} className="qn-group">
          {group.section ? <SectionHeading section={group.section} /> : null}
          {group.questions.map((q) => <QuestionSummary key={q.key} question={q} responses={responses} />)}
        </section>
      ))}
    </div>
  );
}

function QuestionSummary({ question, responses }: { question: FormQuestionRow; responses: readonly FormResponseView[] }) {
  const resolved = resolveQuestion(question.type, question.config);
  const answers: SummaryAnswer<unknown>[] = [];
  let unanswered = 0;
  let unreadable = 0;
  for (const r of responses) {
    const raw = r.answers[question.key];
    if (raw === null || raw === undefined) { unanswered += 1; continue; }
    const answer = parseAnswer(question.type, raw);
    if (answer === null) { unreadable += 1; continue; }
    answers.push({ responseId: r.id, respondent: r.respondentName ?? r.respondentId, answer });
  }
  const Summary = resolved?.ui.Summary;
  const Answer = resolved?.ui.Answer;

  let body;
  if (answers.length === 0) body = <p className="fq-answer__none">No answers yet.</p>;
  else if (!resolved || !Answer) body = <p className="qn-muted">This question’s type ({question.type}) cannot be summarised here.</p>;
  else if (Summary) body = <Summary config={resolved.config} answers={answers} />;
  else {
    body = (
      <ul className="qn-roll">
        {answers.map((a) => (
          <li key={a.responseId} className="qn-roll__item">
            <span className="qn-roll__who">{a.respondent}</span>
            <div className="qn-roll__answer"><Answer config={resolved.config} answer={a.answer} /></div>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="qn-summary__q" data-testid={`summary-${question.key}`}>
      <h4 className="qn-summary__title">{question.title}</h4>
      <p className="qn-muted qn-summary__meta" data-testid={`summary-${question.key}-counts`}>
        {answers.length} answered · {unanswered} unanswered
        {unreadable > 0 ? ` · ${unreadable} in a shape this question no longer reads` : ''}
      </p>
      {body}
    </div>
  );
}
