/**
 * THE ONE RESERVED ⚙ SLOT. Mode-specific options live here for EVERY mode, so
 * no control appears or disappears when the mode changes — the row's frame
 * is fixed and only this slot's contents move. The badge counts values that
 * differ from their default; an untouched mode shows a bare gear.
 */
import type { ChatMode } from '@tm8/contract';
import { ComposerPopover } from './ComposerPopover';
import { PickRow, SwitchRow, TextRow } from './MenuRows';
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
  const count = nonDefaultOptionCount(mode, values);
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
      {() => <ModeOptionsForm mode={mode} values={values} onChange={onChange} testId={testId} />}
    </ComposerPopover>
  );
}

/** The ⚙ form on its own, for a host that already owns the popover (the composer's settings). */
export function ModeOptionsForm({ mode, values, onChange, testId = 'tch-mode-options', title }: Omit<ModeOptionsSlotProps, 'disabled'> & {
  /** Replaces the `<mode> options` heading (the settings panel names roles, not modes). */
  title?: string;
}) {
  const fields = MODE_OPTION_FIELDS[mode];
  const count = nonDefaultOptionCount(mode, values);
  const set = (key: string, value: string | boolean) => onChange({ ...(values ?? {}), [key]: value });
  return (
    <div className="tch-optform" data-mode={mode}>
      <p className="tch-optform__head">
        {title ?? <><b>{modeSpec(mode).label}</b> options</>}
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
  );
}

/**
 * The mode's options as ⚙-panel rows: a choice is a pick row, a toggle a
 * switch, free text an inline field. No heading and no "defaults" note — the
 * values are the state.
 */
export function ModeOptionRows({ mode, values, onChange, testId = 'tch-mode-options' }: Omit<ModeOptionsSlotProps, 'disabled'>) {
  const set = (key: string, value: string | boolean) => onChange({ ...(values ?? {}), [key]: value });
  return (
    <>
      {MODE_OPTION_FIELDS[mode].map((field) => {
        const current = modeOptionValue(field, values);
        const id = `${testId}-${field.key}`;
        if (field.kind === 'toggle') {
          return <SwitchRow key={field.key} label={field.label} checked={Boolean(current)} onChange={(next) => set(field.key, next)} testId={id} />;
        }
        if (field.kind === 'choice') {
          return (
            <PickRow
              key={field.key}
              label={field.label}
              choices={field.choices.map((choice) => ({ id: choice, label: choice }))}
              value={String(current)}
              onPick={(next) => set(field.key, next)}
              testId={id}
            />
          );
        }
        return (
          <TextRow key={field.key} label={field.label} value={String(current)} placeholder={field.placeholder} onChange={(next) => set(field.key, next)} testId={id} />
        );
      })}
    </>
  );
}
