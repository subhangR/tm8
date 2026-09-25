/**
 * single_choice — radio or dropdown (`config.display`), with an optional
 * write-in (`allowOther`). Answer: `{value}` or `{other}`.
 */
import { useState } from 'react';
import { ChosenOption, OptionText, OtherText } from './options';
import { OtherAnswers, SummaryBars, optionBars } from './summary';
import { defineQuestionUI, type AnswerOf, type ConfigOf, type QuestionInputProps, type SummaryAnswer, type SummaryProps } from './types';

type C = ConfigOf<'single_choice'>;
type A = AnswerOf<'single_choice'>;

/** The dropdown's write-in entry. A NUL cannot be an option value an agent sent. */
const OTHER = '\u0000other';

function SingleChoiceInput({ id, labelledBy, describedBy, config, value, onChange, disabled, invalid }: QuestionInputProps<C, A>) {
  const [focused, setFocused] = useState<string | null>(null);
  const chosen = value && 'value' in value ? value.value : null;
  const other = value && 'other' in value ? value.other : null;

  const otherInput = other !== null ? (
    <input
      className="fq-text"
      aria-label="Other answer"
      value={other}
      disabled={disabled}
      placeholder="Your answer"
      onChange={(e) => onChange({ other: e.target.value })}
    />
  ) : null;

  if (config.display === 'dropdown') {
    const selected = chosen ?? (other !== null ? OTHER : '');
    const help = config.options.find((o) => o.value === chosen)?.help;
    return (
      <div className="fq-choice">
        <select
          id={id}
          className="fq-select"
          value={selected}
          disabled={disabled}
          aria-labelledby={labelledBy}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          onChange={(e) => {
            const v = e.target.value;
            if (v === '') onChange(null);
            else if (v === OTHER) onChange({ other: other ?? '' });
            else onChange({ value: v });
          }}
        >
          <option value="">Choose…</option>
          {config.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}{o.recommended ? ' (recommended)' : ''}
            </option>
          ))}
          {config.allowOther ? <option value={OTHER}>Other…</option> : null}
        </select>
        {help ? <span className="fq-option__help">{help}</span> : null}
        {otherInput}
      </div>
    );
  }

  return (
    <div
      id={id}
      className="fq-choice"
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
    >
      {config.options.map((o) => (
        <label key={o.value} className="fq-option" data-checked={chosen === o.value || undefined}>
          <input
            type="radio"
            name={id}
            value={o.value}
            checked={chosen === o.value}
            disabled={disabled}
            onFocus={() => setFocused(o.value)}
            onBlur={() => setFocused(null)}
            onChange={() => onChange({ value: o.value })}
          />
          <OptionText option={o} showHelp={focused === o.value || chosen === o.value} />
        </label>
      ))}
      {config.allowOther ? (
        <label className="fq-option" data-checked={other !== null || undefined}>
          <input
            type="radio"
            name={id}
            checked={other !== null}
            disabled={disabled}
            onChange={() => onChange({ other: other ?? '' })}
          />
          <span className="fq-option__text"><span className="fq-option__label">Other</span></span>
        </label>
      ) : null}
      {otherInput}
    </div>
  );
}

/** One bar per option (% of those who answered), then the write-ins. */
function SingleChoiceSummary({ config, answers }: SummaryProps<C, A>) {
  const counts = new Map<string, number>();
  const others: SummaryAnswer<string>[] = [];
  for (const a of answers) {
    if ('value' in a.answer) counts.set(a.answer.value, (counts.get(a.answer.value) ?? 0) + 1);
    else others.push({ ...a, answer: a.answer.other });
  }
  return (
    <>
      <SummaryBars bars={optionBars(config.options, counts, others.length, config.allowOther)} of={answers.length} />
      <OtherAnswers items={others} />
    </>
  );
}

export const singleChoiceUI = defineQuestionUI<C, A>({
  Input: SingleChoiceInput,
  Answer: ({ config, answer }) =>
    'value' in answer ? <ChosenOption options={config.options} value={answer.value} /> : <OtherText text={answer.other} />,
  recommended: (config) => {
    const option = config.options.find((o) => o.recommended);
    return option ? { value: option.value } : null;
  },
  Summary: SingleChoiceSummary,
});
