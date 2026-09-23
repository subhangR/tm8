/**
 * THE ONE RESERVED ⚙ SLOT. Mode-specific options live here for EVERY mode, so
 * no control appears or disappears when the mode changes — the row's frame
 * is fixed and only this slot's contents move. The badge counts values that
 * differ from their default; an untouched mode shows a bare gear.
 */
import type { ChatMode } from '@tm8/contract';
import { ComposerPopover } from './ComposerPopover';
import {
  MODE_OPTION_FIELDS,
  modeOptionValue,
  modeSpec,
  nonDefaultOptionCount,
  type ModeOptionValues,
} from './composer-model';

export interface ModeOptionsSlotProps {
  mode: ChatMode;
  values: ModeOptionValues | undefined;
  onChange: (values: ModeOptionValues) => void;
  disabled?: boolean;
  testId?: string;
}

export function ModeOptionsSlot({ mode, values, onChange, disabled = false, testId = 'tch-mode-options' }: ModeOptionsSlotProps) {
  const fields = MODE_OPTION_FIELDS[mode];
  const count = nonDefaultOptionCount(mode, values);
  const set = (key: string, value: string | boolean) => onChange({ ...(values ?? {}), [key]: value });
  return (
    <ComposerPopover
      label={`${modeSpec(mode).label} options`}
      testId={testId}
      badge={count}
      disabled={disabled}
      disabledReason="this thread's options were fixed when it started"
      title={`${modeSpec(mode).label} options${count ? ` · ${count} changed` : ''}`}
      menuWidth={280}
      trigger={<span className="tch-pop__gear" aria-hidden>⚙</span>}
    >
      {() => (
        <div className="tch-optform" data-mode={mode}>
          <p className="tch-optform__head">
            <b>{modeSpec(mode).label}</b> options
            <span className="tch-optform__reset">
              {count ? (
                <button type="button" className="tch-linkbtn" onClick={() => onChange({})}>reset</button>
              ) : (
                <span>defaults</span>
              )}
            </span>
          </p>
          {fields.map((field) => {
            const current = modeOptionValue(field, values);
            const changed = current !== field.default;
            const id = `${testId}-${field.key}`;
            return (
              <label key={field.key} className="tch-optform__row" data-changed={changed || undefined}>
                <span className="tch-optform__label">{field.label}</span>
                {field.kind === 'toggle' ? (
                  <input
                    type="checkbox"
                    data-testid={id}
                    checked={Boolean(current)}
                    onChange={(event) => set(field.key, event.target.checked)}
                  />
                ) : field.kind === 'choice' ? (
                  <select data-testid={id} value={String(current)} onChange={(event) => set(field.key, event.target.value)}>
                    {field.choices.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
                  </select>
                ) : (
                  <input
                    type="text"
                    data-testid={id}
                    value={String(current)}
                    placeholder={field.placeholder}
                    onChange={(event) => set(field.key, event.target.value)}
                  />
                )}
              </label>
            );
          })}
        </div>
      )}
    </ComposerPopover>
  );
}
