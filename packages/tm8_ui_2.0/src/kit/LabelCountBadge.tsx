/**
 * LabelCountBadge — the house-law badge for a noun paired with a quantity.
 *
 * "The name beats the count" is an ORDER OF YIELDING, not an exemption. Both
 * children shrink; the count simply yields eight times faster, and the noun
 * gives way last and only down to `--kit-label-floor`. Exempting the noun
 * instead (`flex: none`) is what makes a name overflow its badge and paint
 * across the next column — worse than the ellipsis it was meant to avoid.
 *
 * Nothing is ever lost to clipping: both parts truncate with a visible
 * ellipsis rather than silently, and the root tooltip plus a visually-hidden
 * span keep the exact figure available to pointer and screen reader alike.
 *
 * Set `--kit-label-floor` on the host (e.g. `9ch`) to say how much of the noun
 * must survive on that surface. It defaults to 0 so short labels are never
 * padded out to a floor they do not need.
 */
export function LabelCountBadge({
  label,
  count,
  countTooltip,
  className,
}: {
  /** The noun. It yields the width budget last, never first. */
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
