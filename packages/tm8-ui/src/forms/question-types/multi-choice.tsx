/**
 * multi_choice — checkboxes, an optional write-in, and the min/max bounds
 * stated up front. Answer: `{values[], other?}`.
 */
import { useState } from 'react';
import { ChosenOption, OptionText, OtherText } from './options';
import { OtherAnswers, SummaryBars, optionBars } from './summary';
import { defineQuestionUI, type AnswerOf, type ConfigOf, type QuestionInputProps, type SummaryAnswer, type SummaryProps } from './types';

type C = ConfigOf<'multi_choice'>;
type A = AnswerOf<'multi_choice'>;

function bounds(config: C): string | null {
  const { minSelected: min, maxSelected: max } = config;
  if (min !== undefined && max !== undefined) return min === max ? `Pick ${min}` : `Pick ${min}–${max}`;
  if (min !== undefined && min > 0) return `Pick at least ${min}`;
  if (max !== undefined) return `Pick up to ${max}`;
  return null;
}

function MultiChoiceInput({ id, labelledBy, describedBy, config, value, onChange, disabled, invalid }: QuestionInputProps<C, A>) {
  const [focused, setFocused] = useState<string | null>(null);
  const values = value?.values ?? [];
  const other = value?.other;

  const emit = (nextValues: string[], nextOther: string | undefined) => {
    // Keep option order: selection order carries no meaning (the contract compares as a set).
    const ordered = config.options.map((o) => o.value).filter((v) => nextValues.includes(v));
    if (ordered.length === 0 && nextOther === undefined) onChange(null);
    else onChange(nextOther === undefined ? { values: ordered } : { values: ordered, other: nextOther });
  };
  const hint = bounds(config);

  return (
    <div
      id={id}
      className="fq-choice"
      role="group"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
    >
      {hint ? <span className="fq-hint">{hint}</span> : null}
      {config.options.map((o) => {
        const checked = values.includes(o.value);
        return (
          <label key={o.value} className="fq-option" data-checked={checked || undefined}>
            <input
              type="checkbox"
              value={o.value}
              checked={checked}
              disabled={disabled}
              onFocus={() => setFocused(o.value)}
              onBlur={() => setFocused(null)}
              onChange={() => emit(checked ? values.filter((v) => v !== o.value) : [...values, o.value], other)}
            />
            <OptionText option={o} showHelp={focused === o.value || checked} />
          </label>
        );
      })}
      {config.allowOther ? (
        <>
          <label className="fq-option" data-checked={other !== undefined || undefined}>
            <input
              type="checkbox"
              checked={other !== undefined}
              disabled={disabled}
              onChange={() => emit(values, other === undefined ? '' : undefined)}
            />
            <span className="fq-option__text"><span className="fq-option__label">Other</span></span>
          </label>
          {other !== undefined ? (
            <input
              className="fq-text"
              aria-label="Other answer"
              value={other}
              disabled={disabled}
              placeholder="Your answer"
              onChange={(e) => emit(values, e.target.value)}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** One bar per option, as a share of those who answered (a respondent can pick several). */
function MultiChoiceSummary({ config, answers }: SummaryProps<C, A>) {
  const counts = new Map<string, number>();
  const others: SummaryAnswer<string>[] = [];
  for (const a of answers) {
    for (const v of new Set(a.answer.values)) counts.set(v, (counts.get(v) ?? 0) + 1);
    if (a.answer.other !== undefined) others.push({ ...a, answer: a.answer.other });
  }
  return (
    <>
      <p className="qn-muted qn-summary__note">Respondents could pick more than one.</p>
      <SummaryBars bars={optionBars(config.options, counts, others.length, config.allowOther)} of={answers.length} />
      <OtherAnswers items={others} />
    </>
  );
}

export const multiChoiceUI = defineQuestionUI<C, A>({
  Input: MultiChoiceInput,
  Answer: ({ config, answer }) =>
    answer.values.length === 0 && answer.other === undefined ? (
      <span className="fq-answer__none">None selected</span>
    ) : (
      <span className="fq-answer__list">
        {answer.values.map((v) => <ChosenOption key={v} options={config.options} value={v} />)}
        {answer.other !== undefined ? <OtherText text={answer.other} /> : null}
      </span>
    ),
  recommended: (config) => {
    const values = config.options.filter((o) => o.recommended).map((o) => o.value);
    return values.length > 0 ? { values: config.maxSelected ? values.slice(0, config.maxSelected) : values } : null;
  },
  Summary: MultiChoiceSummary,
});
