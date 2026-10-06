/**
 * A GRAPH PAGE'S CONTROLS — the view switcher and the coherence-findings
 * chip, drawn in the design screen's action strip TOP section (Craft →
 * Designs, change list item 11). They were the old studio header's; the
 * header's blueprint and conversation pickers and Orchestrate are gone (D4:
 * a design is Run like any launchable entity).
 */
import type { ReactNode } from 'react';
import type { CoherenceFinding } from '@tm8/contract';
import type { CraftViewId, CraftViewOption } from './presentation';

/** One small mark per view, for the vertical strip where words do not fit. */
const VIEW_ART: Record<CraftViewId, string> = {
  flow: 'M2.5 5h3v6h-3zM10.5 3h3v4h-3zM10.5 9h3v4h-3zM5.5 8h2.5M8 5v6M8 5h2.5M8 11h2.5',
  lanes: 'M2.5 3.5h11M2.5 8h11M2.5 12.5h11M5 5.5h3M8.5 10h3',
  outline: 'M5.5 4h8M7.5 8h6M7.5 12h6M3 4h.5M5 8h.5M5 12h.5',
  table: 'M2.5 3.5h11v9h-11zM2.5 6.5h11M6.5 3.5v9',
};

export function ViewSwitcher({
  options,
  value,
  onChange,
  orientation = 'horizontal',
}: {
  options: readonly CraftViewOption[];
  value: CraftViewId;
  onChange(id: CraftViewId): void;
  /** Vertical draws a mark per view (the action strip); horizontal draws the words. */
  orientation?: 'horizontal' | 'vertical';
}) {
  if (options.length <= 1) return null;
  return (
    <div
      className={orientation === 'vertical' ? 'crf-views crf-views--vertical' : 'crf-views'}
      role="radiogroup"
      aria-label="Blueprint view"
      aria-orientation={orientation}
      data-testid="crf-views"
    >
      {options.map((option) => (
        <button
          type="button"
          key={option.id}
          role="radio"
          aria-checked={value === option.id}
          className="crf-views__opt"
          data-testid={`crf-view-${option.id}`}
          title={option.hint}
          {...(orientation === 'vertical' ? { 'aria-label': option.label, 'data-tip': option.label } : {})}
          onClick={() => onChange(option.id)}
          onKeyDown={(event) => {
            const [back, forward] = orientation === 'vertical' ? ['ArrowUp', 'ArrowDown'] : ['ArrowLeft', 'ArrowRight'];
            if (event.key !== back && event.key !== forward) return;
            event.preventDefault();
            /* Stops the strip's own ↑/↓ toolbar roving from also moving focus. */
            event.stopPropagation();
            const at = options.findIndex((o) => o.id === value);
            const next = options[(at + (event.key === forward ? 1 : -1) + options.length) % options.length]!;
            onChange(next.id);
            (event.currentTarget.parentElement?.querySelector(`[data-testid="crf-view-${next.id}"]`) as HTMLElement | null)?.focus();
          }}
          tabIndex={value === option.id ? 0 : -1}
        >
          {orientation === 'vertical' ? (
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
              <path d={VIEW_ART[option.id]} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            option.label
          )}
        </button>
      ))}
    </div>
  );
}

/** The findings count chip: worst severity colours it; the words say how many of each. */
export function FindingsChip({
  findings,
  onClick,
}: {
  findings: readonly CoherenceFinding[];
  onClick?: () => void;
}): ReactNode {
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;
  if (errors + warnings === 0) return null;
  const worst = errors > 0 ? 'error' : 'warning';
  const words = [errors ? `${errors} error${errors === 1 ? '' : 's'}` : '', warnings ? `${warnings} warning${warnings === 1 ? '' : 's'}` : '']
    .filter(Boolean).join(', ');
  return (
    <button type="button" className="crf-issues" data-severity={worst} data-testid="crf-issues" title={words} aria-label={words} onClick={onClick}>
      <span aria-hidden>!</span>
      {errors + warnings}
    </button>
  );
}
