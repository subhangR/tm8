import { useId } from 'react';

import { REFERENCES_OFF_NOTE, SKILL_BYTES_NOTE } from './useJevSuggestions';

/** The groups a launch budgets in bytes. */
export type BudgetMeterGroup = 'memories' | 'skills' | 'references' | 'teammates';

export const METER_NULL_BUDGET_COPY = 'takes what the prompt has left';
/** Lane A's words, so the hook and the meter cannot drift. */
export const METER_INDEX_OFF_COPY = REFERENCES_OFF_NOTE;
export const METER_SKILL_TOOLTIP = SKILL_BYTES_NOTE;
/**
 * What spawn does with a group over its budget (coordinator, 2026-09-26) —
 * it depends on the context index and the group, so the meter says the one
 * that applies. What happens, not attitude.
 */
export const METER_OVER_MEMORIES_COPY =
  'Over budget is allowed. At launch the lowest-ranked memories collapse to a one-line entry the agent can open; each one is recorded.';
export const METER_OVER_INDEX_COPY =
  'Over budget is allowed. At launch the lowest-ranked entries lose their description first, then drop; each cut is recorded.';
export const METER_OVER_INDEX_OFF_COPY =
  'With the context index off, this budget isn’t enforced at launch; the whole prompt is still capped at 32 KiB.';

export function meterOverCopy(group: BudgetMeterGroup, contextIndex: 'on' | 'off' | null): string {
  if (contextIndex === 'off') return METER_OVER_INDEX_OFF_COPY;
  return group === 'memories' ? METER_OVER_MEMORIES_COPY : METER_OVER_INDEX_COPY;
}

/** `300 B`, `1.2 KB`, `12 KB` — the prompt's size in words a person reads. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const kb = bytes / 1024;
  return `${kb < 10 ? kb.toFixed(1) : String(Math.round(kb))} KB`;
}

const GROUP_WORD: Record<BudgetMeterGroup, string> = {
  memories: 'Memories',
  skills: 'Skills',
  references: 'References',
  teammates: 'Teammates',
};

/**
 * BUDGET METER — one group's "used / budget" prompt bytes. Reusable: the Jev
 * panel, LaunchSheet and the Run popup mount the same one.
 *
 * It never shows bytes that do not reach the prompt: with the context index
 * off, references are only linked names, so the meter says that instead of a
 * number (memory bytes stay real — they are whole entries either way). A null
 * budget is not "unlimited", it is "takes what the prompt has left", and it
 * says so. Over budget is SHOWN, never refused: a hand tick past the budget is
 * the person's choice, and the meter says what spawn will do with it.
 */
export function BudgetMeter({ group, usedBytes, budget, count, contextIndex, compact }: {
  group: BudgetMeterGroup;
  /** Null: the bytes are not known (a surface without measured rows) — the meter shows the count only, never invented bytes. */
  usedBytes: number | null;
  budget: number | null;
  /** How many rows are ticked; shown beside the bytes, and alone when the bytes are unknown. */
  count?: number;
  /** Null before any answer said which: treated as on. */
  contextIndex: 'on' | 'off' | null;
  /** Drop the group word, for a meter that sits under its own heading. */
  compact?: boolean;
}) {
  const noteId = useId();
  const label = compact ? null : <span className="jev-meter__group">{GROUP_WORD[group]}</span>;
  const tooltip = group === 'skills' ? METER_SKILL_TOOLTIP : undefined;
  const counted = count === undefined ? null : <span className="jev-meter__count">{count} ticked</span>;
  const tip = tooltip ? <span className="jev-meter__tip" aria-label={tooltip} role="img">ⓘ</span> : null;

  if (group === 'references' && contextIndex === 'off') {
    return (
      <div className="jev-meter jev-meter--off" data-testid={`jev-meter-${group}`} data-meter="index-off">
        {label}
        {counted}
        <span className="jev-meter__text">{METER_INDEX_OFF_COPY}</span>
      </div>
    );
  }

  if (usedBytes === null) {
    return (
      <div className="jev-meter" data-testid={`jev-meter-${group}`} data-meter="count-only" title={tooltip}>
        {label}
        {counted}
        <span className="jev-meter__text">
          {budget === null ? METER_NULL_BUDGET_COPY : `budget ${formatBytes(budget)}`}
        </span>
        {tip}
      </div>
    );
  }

  if (budget === null) {
    return (
      <div className="jev-meter" data-testid={`jev-meter-${group}`} data-meter="no-budget" title={tooltip}>
        {label}
        {counted}
        <span className="jev-meter__text">
          {formatBytes(usedBytes)} · {METER_NULL_BUDGET_COPY}
        </span>
        {tip}
      </div>
    );
  }

  const over = usedBytes > budget;
  const fill = budget === 0 ? (usedBytes > 0 ? 100 : 0) : Math.min(100, (usedBytes / budget) * 100);
  return (
    <div
      className={`jev-meter ${over ? 'jev-meter--over' : ''}`}
      data-testid={`jev-meter-${group}`}
      data-meter={over ? 'over' : 'within'}
      title={tooltip}
    >
      {label}
      {counted}
      <span
        className="jev-meter__bar"
        role="meter"
        aria-label={`${GROUP_WORD[group]} prompt bytes`}
        aria-valuemin={0}
        aria-valuemax={budget}
        aria-valuenow={Math.min(usedBytes, budget)}
        aria-valuetext={`${formatBytes(usedBytes)} of ${formatBytes(budget)}${over ? ', over budget' : ''}`}
        aria-describedby={over ? noteId : undefined}
      >
        <span className="jev-meter__fill" style={{ width: `${String(fill)}%` }} />
      </span>
      <span className="jev-meter__text">
        {formatBytes(usedBytes)} / {formatBytes(budget)}
      </span>
      {tip}
      {over ? (
        <span className="jev-meter__over" id={noteId} data-testid={`jev-meter-${group}-over`}>
          Over budget by {formatBytes(usedBytes - budget)}. {meterOverCopy(group, contextIndex)}
        </span>
      ) : null}
    </div>
  );
}
