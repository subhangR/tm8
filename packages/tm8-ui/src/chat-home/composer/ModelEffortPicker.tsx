/**
 * MODEL ON TOP, EFFORT UNDERNEATH — one popover, not a fourth control.
 *
 * Effort is a property of the model: the stops a model accepts come from the
 * catalog's `efforts`, and the dial is drawn over THAT list. A model that
 * declares none disables the dial with the reason. The trigger reads
 * `Sonnet 5 · deep` so the consequence (a latency/cost band) is what the
 * human sees, never a token number.
 *
 * The rows come from `coordinatorModelChoices` or `workerModelChoices`, so a
 * codex model in the coordinator slot is LISTED, disabled, with the reason —
 * the lists are different and the difference must be visible.
 */
import type { LaunchModelEffort } from '@tm8/contract';
import type { ChatModelOption } from '../types';
import { ComposerPopover } from './ComposerPopover';
import { EFFORT_LABELS, effortAvailability, type ModelChoice } from './composer-model';

export interface ModelEffortPickerProps {
  label: string;
  models: readonly ChatModelOption[];
  choices: readonly ModelChoice[];
  value: string;
  onChange: (model: string) => void;
  effort: LaunchModelEffort | null;
  onEffortChange: (effort: LaunchModelEffort) => void;
  disabled?: boolean;
  disabledReason?: string;
  /** Draw the trigger without the `Model` word — a crew row already has a column for it. */
  compact?: boolean;
  className?: string;
  testId: string;
}

export function ModelEffortPicker({
  label,
  models,
  choices,
  value,
  onChange,
  effort,
  onEffortChange,
  disabled = false,
  disabledReason,
  compact = false,
  className,
  testId,
}: ModelEffortPickerProps) {
  const selected = models.find((model) => model.model === value);
  const selectedChoice = choices.find((choice) => choice.id === value);
  const availability = effortAvailability(selected);
  const effortWord = effort && availability.stops.includes(effort) ? EFFORT_LABELS[effort].short : null;
  const shortLabel = selectedChoice?.label ?? selected?.label ?? (value || '—');

  return (
    <ComposerPopover
      label={label}
      testId={testId}
      disabled={disabled}
      disabledReason={disabledReason}
      className={className}
      title={selected ? `${selected.label}${effortWord ? ` · ${effortWord}` : ''}` : undefined}
      menuHeight={340}
      menuWidth={280}
      trigger={<>
        <span className="tch-pop__value">{compact ? shortLabel : shortLabel}</span>
        {effortWord ? <span className="tch-pop__sub">· {effortWord}</span> : null}
        <span className="tch-pick__caret" aria-hidden>▾</span>
      </>}
    >
      {() => (
        <div className="tch-modelmenu">
          <div role="listbox" aria-label={`${label} models`} className="tch-modelmenu__list">
            {choices.length === 0 ? (
              <p className="tch-pickmenu__note">No model is available from the launch catalog.</p>
            ) : null}
            {choices.map((choice) => (
              <button
                key={choice.id}
                type="button"
                role="option"
                className="tch-pickmenu__opt"
                data-testid={`${testId}-${choice.id}`}
                aria-selected={choice.id === value}
                aria-disabled={choice.disabledReason ? true : undefined}
                title={choice.disabledReason}
                onClick={() => { if (!choice.disabledReason) onChange(choice.id); }}
              >
                <span className="tch-pickmenu__text">
                  <span className="tch-pickmenu__name">{choice.label}</span>
                  {choice.disabledReason ? (
                    <span className="tch-pickmenu__hint tch-pickmenu__hint--why">{choice.disabledReason}</span>
                  ) : choice.hint ? (
                    <span className="tch-pickmenu__hint">{choice.hint}</span>
                  ) : null}
                </span>
                <span className="tch-pickmenu__mark" aria-hidden>{choice.id === value ? '✓' : ''}</span>
              </button>
            ))}
          </div>
          <div
            className="tch-effort"
            role="radiogroup"
            aria-label="Reasoning effort"
            aria-disabled={availability.disabledReason ? true : undefined}
            data-testid={`${testId}-effort`}
          >
            <span className="tch-effort__label">Effort</span>
            {availability.disabledReason ? (
              <span className="tch-effort__why" role="note">{availability.disabledReason}</span>
            ) : (
              <span className="tch-effort__stops">
                {availability.stops.map((stop) => (
                  <button
                    key={stop}
                    type="button"
                    role="radio"
                    aria-checked={stop === effort}
                    className="tch-effort__stop"
                    data-testid={`${testId}-effort-${stop}`}
                    title={EFFORT_LABELS[stop].band}
                    onClick={() => onEffortChange(stop)}
                  >
                    {EFFORT_LABELS[stop].short}
                  </button>
                ))}
              </span>
            )}
            {effort && !availability.disabledReason ? (
              <span className="tch-effort__band">{EFFORT_LABELS[effort].band}</span>
            ) : null}
          </div>
        </div>
      )}
    </ComposerPopover>
  );
}
