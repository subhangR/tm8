import { useId, useState } from 'react';
import type { ContextBudgets, SpawnSelectionGroup } from '@tm8/contract';

import { contextBudgetsOverrun } from '../domain/launch';
import { LAUNCH_GROUP_LABEL, LAUNCH_SELECTION_GROUPS } from '../domain/launch-selection';

/** The schema's per-key bound (`ContextBudgetsSchema`): a number past it is refused by the node, so the input stops there. */
const BUDGET_MAX = 32_768;

export const BUDGET_OVERRIDE_HINT = 'Blank keeps the profile’s budget. This launch only — the profile is unchanged.';

/** The warning's words: what the budgets promise, against the room the prompt has. */
export function overrunWarning(over: { promised: number; room: number; over: number }): string {
  return `These budgets promise ${String(over.promised)} bytes, and the prompt has room for ${String(over.room)} beside its frame `
    + `(${String(over.over)} over). Launch still goes: spawn trims the prompt to its ceiling and records every drop.`;
}

/**
 * "Budget for this launch" (design 01a0d348 §10 Q5.4, I7) — a collapsed
 * disclosure with one byte input per group. A key a person fills rides
 * `execution.spawn` `contextBudgets` for this session only (the node records
 * it on the manifest); a blank key sends nothing and the profile's budget
 * holds.
 *
 * WARNS, NEVER BLOCKS: budgets that cannot fit the prompt beside its frame are
 * stated inline (the node's own check, `contextBudgetsOverrun`), and Launch
 * stays enabled — the node records them with a warning and trims.
 */
export function BudgetOverride({
  value,
  onChange,
  groups = LAUNCH_SELECTION_GROUPS,
  defaultOpen = false,
}: {
  value: ContextBudgets;
  onChange(next: ContextBudgets): void;
  groups?: readonly SpawnSelectionGroup[];
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = `lsel-budget-${useId()}`;
  const set = Object.values(value).filter((bytes) => bytes !== undefined).length;
  const overrun = contextBudgetsOverrun(value);

  const update = (group: SpawnSelectionGroup, raw: string) => {
    const next: ContextBudgets = { ...value };
    const trimmed = raw.trim();
    const bytes = trimmed === '' ? NaN : Number(trimmed);
    if (Number.isInteger(bytes) && bytes >= 0) next[group] = Math.min(bytes, BUDGET_MAX);
    else delete next[group];
    onChange(next);
  };

  return (
    <section className="ls__section lsel lsel-budget" data-testid="launch-budget-override" aria-label="Budget for this launch">
      <button
        type="button"
        className={`lsel__head lsel__head--toggle ${set > 0 ? 'lsel__head--edited' : ''}`}
        aria-expanded={open}
        aria-controls={bodyId}
        data-testid="launch-budget-toggle"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="ls__eyebrow">BUDGET FOR THIS LAUNCH</span>
        <span className="lsel__summary">
          {set === 0 ? 'the profile’s budgets' : `${String(set)} overridden`}
          {overrun ? ' · over the prompt’s room' : ''}
        </span>
        <span className="lsel__caret" aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>
      {open ? (
        <div id={bodyId} className="lsel__body lsel-budget__body">
          {groups.map((group) => (
            <label key={group} className="lsel-budget__row">
              <span className="ls__rowname">{LAUNCH_GROUP_LABEL[group]}</span>
              <input
                className="ls__search lsel-budget__input"
                type="number"
                inputMode="numeric"
                min={0}
                max={BUDGET_MAX}
                step={256}
                placeholder="profile’s"
                aria-label={`${LAUNCH_GROUP_LABEL[group]} budget in bytes for this launch`}
                data-testid={`launch-budget-${group}`}
                value={value[group] ?? ''}
                onChange={(event) => update(group, event.target.value)}
              />
              <span className="ls__rowsub">bytes</span>
            </label>
          ))}
          <p className="ls__rowsub">{BUDGET_OVERRIDE_HINT}</p>
        </div>
      ) : null}
      {overrun ? (
        <p className="ls__rowsub lsel-budget__warn" role="status" data-testid="launch-budget-warning">{overrunWarning(overrun)}</p>
      ) : null}
    </section>
  );
}
