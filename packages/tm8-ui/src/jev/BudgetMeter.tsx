import { useId } from 'react';

/** The groups a launch budgets in bytes. */
export type BudgetMeterGroup = 'memories' | 'skills' | 'references' | 'teammates';

export const METER_NULL_BUDGET_COPY = 'takes what the prompt has left';
export const METER_INDEX_OFF_COPY = 'not in the prompt while the context index is off';
export const METER_SKILL_TOOLTIP =
  'Skill bytes assume each skill is indexed, not native: whether a skill is native depends on the launch’s workdir, so a native skill may cost less than this.';
export const METER_OVER_COPY = 'Allowed — your ticks, your call. Spawn trims to the budget and records what it left out.';

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
 * the person's choice, and spawn trims and records it.
 */
export function BudgetMeter({ group, usedBytes, budget, contextIndex, compact }: {
  group: BudgetMeterGroup;
  usedBytes: number;
  budget: number | null;
  /** Null before any answer said which: treated as on. */
  contextIndex: 'on' | 'off' | null;
  /** Drop the group word, for a meter that sits under its own heading. */
  compact?: boolean;
}) {
  const noteId = useId();
  const label = compact ? null : <span className="jev-meter__group">{GROUP_WORD[group]}</span>;
  const tooltip = group === 'skills' ? METER_SKILL_TOOLTIP : undefined;

  if (group === 'references' && contextIndex === 'off') {
    return (
      <div className="jev-meter jev-meter--off" data-testid={`jev-meter-${group}`} data-meter="index-off">
        {label}
        <span className="jev-meter__text">{METER_INDEX_OFF_COPY}</span>
      </div>
    );
  }

  if (budget === null) {
    return (
      <div className="jev-meter" data-testid={`jev-meter-${group}`} data-meter="no-budget" title={tooltip}>
        {label}
        <span className="jev-meter__text">
          {formatBytes(usedBytes)} · {METER_NULL_BUDGET_COPY}
        </span>
        {tooltip ? <span className="jev-meter__tip" aria-label={tooltip} role="img">ⓘ</span> : null}
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
      {tooltip ? <span className="jev-meter__tip" aria-label={tooltip} role="img">ⓘ</span> : null}
      {over ? (
        <span className="jev-meter__over" id={noteId} data-testid={`jev-meter-${group}-over`}>
          Over budget by {formatBytes(usedBytes - budget)}. {METER_OVER_COPY}
        </span>
      ) : null}
    </div>
  );
}
