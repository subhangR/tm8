/**
 * LabelCountBadge — the house-law badge for a noun paired with a quantity.
 *
 * The label is the durable information and never participates in shrinking.
 * The count is the expendable tail: CSS may clip it all the way to zero when
 * the host is narrow, while the root tooltip keeps the complete quantity
 * available. This lets rails, cards and list headings share one width policy
 * instead of each re-inventing a badge that crowds out its own name.
 */
export function LabelCountBadge({
  label,
  count,
  countTooltip,
  className,
}: {
  /** The noun. It always wins the width budget. */
  label: string;
  /** The expendable quantity rendered after the noun. */
  count: string | number;
  /** Defaults to `"<label>: <count>"` and remains when the count clips away. */
  countTooltip?: string;
  /** Optional host layout hook; the priority classes always remain present. */
  className?: string;
}) {
  const cls = ['kit-label-count', className ?? ''].filter(Boolean).join(' ');
  return (
    <span className={cls} title={countTooltip ?? `${label}: ${count}`}>
      <span className="kit-label-count__label">{label}</span>
      <span className="kit-label-count__quantity" aria-hidden="true">
        {count}
      </span>
      <span className="kit-sr-only">{`, ${count}`}</span>
    </span>
  );
}
