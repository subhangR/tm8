/**
 * MODEL ON TOP, EFFORT UNDERNEATH — one popover, not a fourth control.
 *
 *   🔍 Search models            (only when the list is long)
 *   ANTHROPIC
 *    Opus 5.5        [1M]   ✓    one row per model; the 1M-context variant is
 *    Opus 5          [1M]        an inline toggle on its base row, not a row
 *   OPENAI
 *    GPT 6.1 Sol
 *   ───────────────────────
 *   Effort              High
 *   ●━━━━━━━━━━◉──────○          a draggable slider over the stops THIS model
 *   Low  Medium  High  Max       accepts; notches snap, labels click, arrows step
 *   slower · deeper reasoning
 *
 * Effort is a property of the model: the stops come from the catalog's
 * `efforts`, and a model that declares none shows why instead of a slider.
 * The trigger reads `Opus 5.5 1M · High ▾`.
 *
 * The rows come from `coordinatorModelChoices` or `workerModelChoices`, so a
 * codex model in the coordinator slot is LISTED, disabled, with the reason —
 * the lists are different and the difference must be visible.
 */
import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { LaunchModelEffort } from '@tm8/contract';
import type { ChatModelOption } from '../types';
import { ComposerIcon } from './ComposerIcons';
import { ComposerPopover } from './ComposerPopover';
import { EFFORT_LABELS, effortAvailability, shortModelLabel, type ModelChoice } from './composer-model';

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

/** Past this many rows the list grows a search box. */
const SEARCH_AT = 8;
const LONG_CONTEXT = '[1m]';

/** One drawn row: a base model and, when the catalog has it, its 1M variant. */
interface ModelRow {
  base: ModelChoice;
  long: ModelChoice | null;
  provider: string;
}

function rowsOf(choices: readonly ModelChoice[], models: readonly ChatModelOption[]): ModelRow[] {
  const byId = new Map(choices.map((choice) => [choice.id, choice]));
  const rows: ModelRow[] = [];
  for (const choice of choices) {
    // A variant whose base is listed rides on the base's row.
    if (choice.id.endsWith(LONG_CONTEXT) && byId.has(choice.id.slice(0, -LONG_CONTEXT.length))) continue;
    const long = byId.get(`${choice.id}${LONG_CONTEXT}`) ?? null;
    const provider = models.find((model) => model.model === choice.id)?.provider ?? 'other';
    rows.push({ base: choice, long, provider: provider.toLowerCase() });
  }
  return rows;
}

/**
 * `Claude Opus 5.5 (1M)` → `Opus 5.5`: the row name, with the 1M pill beside
 * it, and without a leading provider word its section header already says.
 */
function rowName(choice: ModelChoice, provider = ''): string {
  const name = shortModelLabel(choice.label.replace(/\s*\(1M\)\s*$/i, ''));
  return provider && name.toLowerCase().startsWith(`${provider} `) ? name.slice(provider.length + 1) : name;
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
  className,
  testId,
}: ModelEffortPickerProps) {
  const selected = models.find((model) => model.model === value);
  const selectedChoice = choices.find((choice) => choice.id === value);
  const availability = effortAvailability(selected);
  const effortWord = effort && availability.stops.includes(effort) ? EFFORT_LABELS[effort].short : null;
  const shortLabel = shortModelLabel(selectedChoice?.label ?? selected?.label ?? (value || '—'));

  return (
    <ComposerPopover
      label={label}
      testId={testId}
      disabled={disabled}
      disabledReason={disabledReason}
      className={className}
      title={selected ? `${selected.label}${effortWord ? ` · ${effortWord}` : ''}` : undefined}
      menuHeight={420}
      menuWidth={300}
      fitViewport
      trigger={<>
        <span className="tch-pop__value">{shortLabel}</span>
        {effortWord ? <span className="tch-pop__sub">· {effortWord}</span> : null}
        <ComposerIcon name="chevronDown" size={14} className="tch-pick__caret" />
      </>}
    >
      {() => (
        <ModelMenu
          label={label}
          models={models}
          choices={choices}
          value={value}
          onChange={onChange}
          effort={effort}
          onEffortChange={onEffortChange}
          disabled={disabled}
          {...(disabledReason ? { disabledReason } : {})}
          testId={testId}
        />
      )}
    </ComposerPopover>
  );
}

function ModelMenu({
  label,
  models,
  choices,
  value,
  onChange,
  effort,
  onEffortChange,
  disabled,
  disabledReason,
  testId,
}: Omit<ModelEffortPickerProps, 'compact' | 'className'> & { disabled: boolean }) {
  const [query, setQuery] = useState('');
  const rows = useMemo(() => rowsOf(choices, models), [choices, models]);
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? rows.filter((row) => `${row.base.label} ${row.provider}`.toLowerCase().includes(needle))
    : rows;
  const providers = [...new Set(shown.map((row) => row.provider))];
  const selected = models.find((model) => model.model === value);
  const availability = effortAvailability(selected);
  /* A locked picker must LOOK locked, and stay inert while open (a lock can
     flip while the menu is up — its own onChange failing). */
  const pick = (choice: ModelChoice) => { if (!disabled && !choice.disabledReason) onChange(choice.id); };

  return (
    <div className="tch-modelmenu">
      {rows.length > SEARCH_AT ? (
        <label className="tch-modelmenu__search">
          <ComposerIcon name="search" size={14} />
          <input
            type="search"
            placeholder="Search models"
            aria-label="Search models"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      ) : null}
      <div role="listbox" aria-label={`${label} models`} className="tch-modelmenu__list">
        {choices.length === 0 ? (
          <p className="tch-pickmenu__note">No model is available from the launch catalog.</p>
        ) : null}
        {choices.length > 0 && shown.length === 0 ? <p className="tch-pickmenu__note">No model matches.</p> : null}
        {providers.map((provider) => (
          <div key={provider} role="group" aria-label={provider}>
            <p className="tch-menu__heading">{provider}</p>
            {shown.filter((row) => row.provider === provider).map((row) => {
              const onLong = row.long !== null && value === row.long.id;
              const isSelected = value === row.base.id || onLong;
              const reason = row.base.disabledReason ?? (disabled ? disabledReason : undefined);
              return (
                <div
                  key={row.base.id}
                  role="option"
                  tabIndex={0}
                  className="tch-modelrow"
                  data-testid={`${testId}-${row.base.id}`}
                  aria-selected={isSelected}
                  aria-disabled={(disabled || row.base.disabledReason) ? true : undefined}
                  title={reason ?? row.base.label}
                  onClick={() => pick(onLong && row.long ? row.long : row.base)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      pick(onLong && row.long ? row.long : row.base);
                    }
                  }}
                >
                  <span className="tch-modelrow__name">{rowName(row.base, row.provider)}</span>
                  {/* The full reason is the row's tooltip; the row says it short. */}
                  {row.base.disabledReason ? <span className="tch-modelrow__why">chat: Claude Code only</span> : null}
                  {row.long ? (
                    <button
                      type="button"
                      className="tch-modelrow__ctx"
                      data-testid={`${testId}-${row.base.id}-1m`}
                      aria-pressed={onLong}
                      aria-label={`${rowName(row.base, row.provider)} with 1M context`}
                      title={onLong ? 'Using the 1M-context variant' : 'Switch to the 1M-context variant'}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (row.long) pick(onLong ? row.base : row.long);
                      }}
                    >
                      1M
                    </button>
                  ) : null}
                  <span className="tch-modelrow__mark" aria-hidden>
                    {isSelected ? <ComposerIcon name="check" size={14} /> : null}
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className="tch-effort" data-testid={`${testId}-effort`} aria-disabled={availability.disabledReason ? true : undefined}>
        <div className="tch-effort__head">
          <span className="tch-effort__label">Effort</span>
          <span className="tch-effort__now" data-testid={`${testId}-effort-now`}>
            {effort && !availability.disabledReason ? EFFORT_LABELS[effort].short : ''}
          </span>
        </div>
        {availability.disabledReason ? (
          <span className="tch-effort__why" role="note">{availability.disabledReason}</span>
        ) : (
          <EffortSlider stops={availability.stops} value={effort} onChange={onEffortChange} testId={`${testId}-effort`} />
        )}
      </div>
    </div>
  );
}

/**
 * THE DRAGGABLE EFFORT. A track with one notch per stop the model accepts,
 * filled up to the thumb. Dragging moves the thumb smoothly and the value to
 * the nearest notch as it goes (so the hint reads live); letting go settles
 * the thumb on that notch. Labels under the notches are clickable; the thumb
 * takes ← → ↑ ↓ Home End.
 */
export function EffortSlider({ stops, value, onChange, testId }: {
  stops: readonly LaunchModelEffort[];
  value: LaunchModelEffort | null;
  onChange: (effort: LaunchModelEffort) => void;
  testId: string;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const last = Math.max(1, stops.length - 1);
  const index = Math.max(0, value ? stops.indexOf(value) : 0);
  const at = drag ?? index / last;
  const current = stops[index];

  const fractionAt = (clientX: number) => {
    const box = track.current?.getBoundingClientRect();
    if (!box || box.width === 0) return index / last;
    return Math.min(1, Math.max(0, (clientX - box.left) / box.width));
  };
  const settle = (fraction: number) => {
    const next = stops[Math.round(fraction * last)];
    if (next && next !== value) onChange(next);
  };
  const step = (delta: number) => {
    const next = stops[Math.min(stops.length - 1, Math.max(0, index + delta))];
    if (next && next !== value) onChange(next);
  };

  if (stops.length === 1) {
    return <p className="tch-effort__hint">{EFFORT_LABELS[stops[0]!].band} · the only level this model offers</p>;
  }

  return (
    <>
      <div
        ref={track}
        className="tch-slider"
        data-dragging={drag !== null || undefined}
        onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture?.(event.pointerId);
          const fraction = fractionAt(event.clientX);
          setDrag(fraction);
          settle(fraction);
          event.currentTarget.querySelector<HTMLElement>('[role="slider"]')?.focus();
        }}
        onPointerMove={(event) => {
          if (drag === null) return;
          const fraction = fractionAt(event.clientX);
          setDrag(fraction);
          settle(fraction);
        }}
        onPointerUp={() => setDrag(null)}
        onPointerCancel={() => setDrag(null)}
      >
        <span className="tch-slider__rail" aria-hidden />
        <span className="tch-slider__fill" style={{ width: `${at * 100}%` }} aria-hidden />
        {stops.map((stop, i) => (
          <span
            key={stop}
            className="tch-slider__notch"
            data-passed={i <= index || undefined}
            style={{ left: `${(i / last) * 100}%` }}
            aria-hidden
          />
        ))}
        <span
          role="slider"
          tabIndex={0}
          className="tch-slider__thumb"
          style={{ left: `${at * 100}%` }}
          aria-label="Reasoning effort"
          aria-valuemin={0}
          aria-valuemax={stops.length - 1}
          aria-valuenow={index}
          aria-valuetext={current ? EFFORT_LABELS[current].short : undefined}
          data-testid={`${testId}-thumb`}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight' || event.key === 'ArrowUp') { event.preventDefault(); step(1); }
            else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') { event.preventDefault(); step(-1); }
            else if (event.key === 'Home') { event.preventDefault(); onChange(stops[0]!); }
            else if (event.key === 'End') { event.preventDefault(); onChange(stops[stops.length - 1]!); }
          }}
        />
      </div>
      <div className="tch-slider__labels">
        {stops.map((stop, i) => (
          <button
            key={stop}
            type="button"
            className="tch-slider__label"
            data-testid={`${testId}-${stop}`}
            aria-pressed={stop === value}
            style={{ left: `${(i / last) * 100}%` }}
            onClick={() => onChange(stop)}
          >
            {EFFORT_LABELS[stop].short}
          </button>
        ))}
      </div>
      {current ? <p className="tch-effort__hint" data-testid={`${testId}-hint`}>{EFFORT_LABELS[current].band}</p> : null}
    </>
  );
}
