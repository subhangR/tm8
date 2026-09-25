/** scale — one button per point, min..max, end labels. Answer: `{number}`. */
import { SummaryBars } from './summary';
import { defineQuestionUI, type AnswerOf, type ConfigOf, type QuestionInputProps, type SummaryProps } from './types';

type C = ConfigOf<'scale'>;
type A = AnswerOf<'scale'>;

const points = (config: C) => Array.from({ length: config.max - config.min + 1 }, (_, i) => config.min + i);

function ScaleInput({ id, labelledBy, describedBy, config, value, onChange, disabled, invalid }: QuestionInputProps<C, A>) {
  return (
    <div className="fq-scale">
      <div
        id={id}
        className="fq-scale__points"
        role="radiogroup"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
      >
        {points(config).map((n) => (
          <button
            key={n}
            type="button"
            role="radio"
            className="fq-scale__point"
            aria-checked={value?.number === n}
            disabled={disabled}
            onClick={() => onChange({ number: n })}
          >
            {n}
          </button>
        ))}
      </div>
      {config.minLabel || config.maxLabel ? (
        <div className="fq-scale__labels">
          <span>{config.minLabel}</span>
          <span>{config.maxLabel}</span>
        </div>
      ) : null}
    </div>
  );
}

/** The distribution across min..max, with the end labels, and the average. */
function ScaleSummary({ config, answers }: SummaryProps<C, A>) {
  const average = answers.reduce((sum, a) => sum + a.answer.number, 0) / answers.length;
  const bars = points(config).map((n) => ({
    key: String(n),
    label: n === config.min && config.minLabel ? `${n} (${config.minLabel})`
      : n === config.max && config.maxLabel ? `${n} (${config.maxLabel})` : String(n),
    count: answers.filter((a) => a.answer.number === n).length,
  }));
  return (
    <>
      <p className="qn-summary__stat" data-testid="summary-average">
        Average <strong>{average.toFixed(1)}</strong> of {config.min}–{config.max}
      </p>
      <SummaryBars bars={bars} of={answers.length} />
    </>
  );
}

export const scaleUI = defineQuestionUI<C, A>({
  Input: ScaleInput,
  Answer: ({ config, answer }) => (
    <span className="fq-answer__scale">
      <span className="fq-answer__scale-dots" aria-hidden>
        {points(config).map((n) => <span key={n} data-on={n <= answer.number || undefined} />)}
      </span>
      <span>
        {answer.number} of {config.min}–{config.max}
        {config.minLabel || config.maxLabel ? ` (${config.minLabel ?? config.min} … ${config.maxLabel ?? config.max})` : ''}
      </span>
    </span>
  ),
  Summary: ScaleSummary,
});
