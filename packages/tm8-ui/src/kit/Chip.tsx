import type { ReactNode } from 'react';

/**
 * Chip (Z1) — kind glyph + name, bordered, clickable (T0-1 detail-panel edge
 * chips: "⑂ PR #212", "▤ Layout spec", "▣ forge"). Hover-preview (Z2 card)
 * and drag behavior arrive with the shell — this is only the visual atom.
 */
export function Chip({
  glyph,
  onClick,
  children,
  title,
}: {
  glyph?: ReactNode;
  onClick?: () => void;
  children: ReactNode;
  title?: string;
}) {
  /* `glyph` is a NODE, not a character: kind marks are drawn (domain/KindIcon)
     because twenty text glyphs cannot stay distinct at this size. A string
     still works and still renders — the callers that pass a text mark for a
     non-kind thing did not have to change. */
  return (
    <button type="button" className="kit-chip" onClick={onClick} title={title}>
      {glyph ? (
        <span aria-hidden className="kit-chip__glyph">
          {glyph}
        </span>
      ) : null}
      {children}
    </button>
  );
}
