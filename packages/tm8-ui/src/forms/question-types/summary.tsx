/**
 * Shared summary pieces for the counted types — SHAPES (a bar per bucket, a
 * list of write-ins), not a type switch, the same way `options.tsx` shares
 * `FormOption`. Every bar carries its count and percentage as text; the fill
 * is decoration.
 */
import { RecommendedBadge } from './options';
import type { SummaryAnswer } from './types';

export interface SummaryBar {
  key: string;
  label: string;
  count: number;
  recommended?: boolean;
}

/** `count` of `of`, as a whole percentage (0 when there is nothing to divide). */
export const percentOf = (count: number, of: number) => (of > 0 ? Math.round((count / of) * 100) : 0);

export function SummaryBars({ bars, of }: { bars: readonly SummaryBar[]; of: number }) {
  return (
    <ul className="qn-bars">
      {bars.map((b) => {
        const pct = percentOf(b.count, of);
        return (
          <li key={b.key} className="qn-bars__row" data-testid={`summary-bar-${b.key}`}>
            <span className="qn-bars__label">
              {b.label}
              {b.recommended ? <RecommendedBadge /> : null}
            </span>
            <span className="qn-bars__track" aria-hidden>
              <span className="qn-bars__fill" style={{ width: `${pct}%` }} />
            </span>
            <span className="qn-bars__value">{b.count} · {pct}%</span>
          </li>
        );
      })}
    </ul>
  );
}

/** The write-ins behind an "Other" bar, each under its respondent. */
export function OtherAnswers({ items }: { items: readonly SummaryAnswer<string>[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="qn-roll qn-roll--other" aria-label="Other answers">
      {items.map((o) => (
        <li key={o.responseId} className="qn-roll__item">
          <span className="qn-roll__who">{o.respondent}</span>
          <span className="qn-roll__answer">“{o.answer}”</span>
        </li>
      ))}
    </ul>
  );
}

/** Option bars in config order, then any value the options no longer name, then "Other". */
export function optionBars(
  options: readonly { value: string; label: string; recommended?: boolean }[],
  counts: ReadonlyMap<string, number>,
  others: number,
  allowOther: boolean,
): SummaryBar[] {
  const bars: SummaryBar[] = options.map((o) => ({
    key: o.value, label: o.label, count: counts.get(o.value) ?? 0, recommended: o.recommended === true,
  }));
  const known = new Set(options.map((o) => o.value));
  for (const [value, count] of counts) if (!known.has(value)) bars.push({ key: value, label: value, count });
  if (allowOther || others > 0) bars.push({ key: '__other', label: 'Other', count: others });
  return bars;
}
