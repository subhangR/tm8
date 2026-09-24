/**
 * Shared option pieces for the choice types — a SHAPE (`FormOption`), not a
 * type switch, the same way the contract shares `FormOptionSchema`.
 */
import type { FormOption } from '@tm8/contract';
import { Pill } from '../../kit';

export function RecommendedBadge() {
  return <Pill tone="brand">Recommended</Pill>;
}

/** An option's label, its badge, and its help when it is focused or chosen. */
export function OptionText({ option, showHelp }: { option: FormOption; showHelp: boolean }) {
  return (
    <span className="fq-option__text">
      <span className="fq-option__label">
        {option.label}
        {option.recommended ? <RecommendedBadge /> : null}
      </span>
      {showHelp && option.help ? <span className="fq-option__help">{option.help}</span> : null}
    </span>
  );
}

/** A chosen option's label, for answer renderers. Unknown values show raw. */
export function ChosenOption({ options, value }: { options: readonly FormOption[]; value: string }) {
  const option = options.find((o) => o.value === value);
  return (
    <span className="fq-answer__option">
      {option ? option.label : value}
      {option?.recommended ? <RecommendedBadge /> : null}
    </span>
  );
}

export function OtherText({ text }: { text: string }) {
  return <span className="fq-answer__option fq-answer__option--other">Other: “{text}”</span>;
}
