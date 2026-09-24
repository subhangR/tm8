/** short_text — one line, a code-point counter, an optional pattern. Answer: `{text}`. */
import { formTextLength } from '@tm8/contract';
import { defineQuestionUI, type AnswerOf, type ConfigOf, type QuestionInputProps } from './types';

type C = ConfigOf<'short_text'>;
type A = AnswerOf<'short_text'>;

function ShortTextInput({ id, describedBy, config, value, onChange, disabled, invalid }: QuestionInputProps<C, A>) {
  const text = value?.text ?? '';
  return (
    <div className="fq-textfield">
      <input
        id={id}
        className="fq-text"
        value={text}
        placeholder={config.placeholder}
        disabled={disabled}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        onChange={(e) => onChange(e.target.value === '' ? null : { text: e.target.value })}
      />
      <span className="fq-count" aria-hidden>{formTextLength(text)}/{config.maxLength}</span>
    </div>
  );
}

export const shortTextUI = defineQuestionUI<C, A>({
  Input: ShortTextInput,
  Answer: ({ answer }) => <span className="fq-answer__text">{answer.text}</span>,
});
