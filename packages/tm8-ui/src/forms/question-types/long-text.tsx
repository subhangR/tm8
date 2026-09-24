/** long_text — markdown, with a Write / Preview toggle. Answer: `{text}`. */
import { useState } from 'react';
import { formTextLength } from '@tm8/contract';
import { Markdown } from '../../kit';
import { defineQuestionUI, type AnswerOf, type ConfigOf, type QuestionInputProps } from './types';

type C = ConfigOf<'long_text'>;
type A = AnswerOf<'long_text'>;

function LongTextInput({ id, describedBy, config, value, onChange, disabled, invalid }: QuestionInputProps<C, A>) {
  const [preview, setPreview] = useState(false);
  const text = value?.text ?? '';
  return (
    <div className="fq-textfield fq-textfield--long">
      <div className="fq-mdbar">
        <button type="button" className="fq-mdbar__btn" aria-pressed={!preview} onClick={() => setPreview(false)}>Write</button>
        <button type="button" className="fq-mdbar__btn" aria-pressed={preview} onClick={() => setPreview(true)}>Preview</button>
        <span className="fq-count" aria-hidden>
          {formTextLength(text)}/{config.maxLength}{config.minLength ? ` · min ${config.minLength}` : ''}
        </span>
      </div>
      {preview ? (
        <div className="fq-mdpreview">
          {text ? <Markdown source={text} className="pn-prose" /> : <span className="fq-answer__none">Nothing to preview</span>}
        </div>
      ) : (
        <textarea
          id={id}
          className="fq-textarea"
          rows={5}
          value={text}
          placeholder={config.placeholder ?? 'Markdown is supported'}
          disabled={disabled}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          onChange={(e) => onChange(e.target.value === '' ? null : { text: e.target.value })}
        />
      )}
    </div>
  );
}

export const longTextUI = defineQuestionUI<C, A>({
  Input: LongTextInput,
  Answer: ({ answer }) => <Markdown source={answer.text} className="pn-prose fq-answer__md" />,
});
