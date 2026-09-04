import { useId, type ReactNode } from 'react';

/**
 * HOLLOW-VALUE — T1-4's second treatment.
 *
 * THE LAW, verbatim from the canvas: "Zero means measured-zero; dash means
 * not-measured." A stat with no measurement renders an em dash plus a
 * dotted-rule caption saying so. Rendering `0` for absent data is a lie of
 * precision — it claims a measurement that was never taken — and it is
 * exactly the lie D7.2 exists to forbid: presence is measured-empty on every
 * node, so "0 viewers" would assert we looked and found nobody, when in fact
 * nothing ever looked.
 *
 * The distinction is carried in the TYPE: `value === null` (or omitted) is
 * hollow; `value === 0` is a real zero and renders "0" with no caption.
 */

export function HollowStat({
  label,
  value,
  caption,
}: {
  /** Uppercase mono micro-label under the value. */
  label: string;
  /** `null`/omitted ⇒ hollow. `0` ⇒ a measured zero, rendered as 0. */
  value?: number | string | null;
  /** Why the value is hollow. Required when hollow; ignored otherwise. */
  caption?: string;
}) {
  const hollow = value === null || value === undefined;
  return (
    <span className="hon-stat" data-testid={hollow ? 'hollow-stat' : 'stat'}>
      <span className={hollow ? 'hon-stat__value hon-stat__value--hollow' : 'hon-stat__value'}>
        {hollow ? '—' : value}
      </span>
      <span className="hon-stat__label">{label}</span>
      {hollow && caption ? <span className="hon-stat__caption">{caption}</span> : null}
    </span>
  );
}

/**
 * Inline form — the panel-footer viewers case, where a tile will not fit but
 * the dash-not-zero law still applies. The reason rides on `title` and
 * `aria-describedby` rather than a caption line, so the footer keeps its
 * single-row geometry.
 */
export function HollowInline({
  caption,
  children,
}: {
  /** Why this is hollow — reachable by pointer (title) and by AT. */
  caption: string;
  /** Defaults to the em dash. Pass a unit phrase like `— viewing`. */
  children?: ReactNode;
}) {
  const id = useId();
  return (
    <>
      <span
        className="hon-hollow-inline"
        title={caption}
        aria-describedby={id}
        data-testid="hollow-inline"
      >
        {children ?? '—'}
      </span>
      {/* Visually redundant with `title`, but `title` alone is not reliably
          announced; this is the text AT actually reads. */}
      <span id={id} hidden>
        {caption}
      </span>
    </>
  );
}
