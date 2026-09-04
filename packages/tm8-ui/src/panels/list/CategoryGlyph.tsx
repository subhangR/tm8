/**
 * THE FOUR CATEGORY MARKS — ONE GLYPH FAMILY, BECAUSE THEY ARE ONE AXIS.
 *
 * `To Do · In Progress · Done · Cancelled` is a partition of a single axis, so
 * the row that draws it has to read as one control with four positions rather
 * than as four unrelated buttons. Four glyphs borrowed from four different
 * vocabularies — a clock, a spinner, a tick, a bin — would each be legible on
 * its own and would say nothing about the thing they share.
 *
 * So all four are the SAME 11px ring, differing only in what is inside it:
 * empty, half-filled, ticked, struck. That is the shape of the fact — the same
 * item moves around this ring — and it is why the marks are drawn here rather
 * than picked per tab at the call site.
 *
 * SVG IN A 16 VIEWBOX WITH `currentColor`, matching `MaestroTaskTile`'s
 * `ChevronRight`/`ChevronDown` and for the reason stated there: a typographic
 * glyph sits on its own font's baseline, so a row of them lands at four
 * different optical heights. A path in a square viewBox centres exactly, and
 * `currentColor` lets the active state be one colour declaration on the button.
 *
 * KEYED BY THE CLOSED UNION, EXHAUSTIVELY. `Record<StatusCategory, …>` means a
 * fifth category is a COMPILE ERROR here rather than a tab that silently draws
 * nothing — which is the failure mode a lookup with a fallback would have, and
 * the one that would survive review because the fallback looks careful.
 */
import type { ReactElement } from 'react';
import type { StatusCategory } from '@tm8/contract';

/** The shared ring. Every mark is this circle plus at most one path. */
const ring = (
  <circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
);

const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

const MARKS: Readonly<Record<StatusCategory, ReactElement>> = {
  /* Empty: nothing has happened to it yet. */
  to_do: <>{ring}</>,
  /* Half filled, and the fill is a real half-disc rather than a smaller circle
     clipped by opacity — at 16px a tinted circle and an empty one are the same
     mark to the eye at arm's length. */
  in_progress: (
    <>
      {ring}
      <path d="M8 2.5A5.5 5.5 0 0 1 8 13.5Z" fill="currentColor" />
    </>
  ),
  done: (
    <>
      {ring}
      <path d="M5.3 8.1L7.1 9.9L10.7 6.3" {...stroke} />
    </>
  ),
  /* Struck through, not crossed out with an ✕: an ✕ is the dismiss glyph this
     product already uses on chips and sheets, and reusing it for a lifecycle
     state would make a tab look like a way to close something. */
  cancelled: (
    <>
      {ring}
      <path d="M4.4 11.6L11.6 4.4" {...stroke} />
    </>
  ),
};

export function CategoryGlyph({ category }: { category: StatusCategory }) {
  return (
    <svg className="lp__tab-glyph" viewBox="0 0 16 16" aria-hidden focusable="false">
      {MARKS[category]}
    </svg>
  );
}
