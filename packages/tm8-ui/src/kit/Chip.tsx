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
  glyph?: string;
  onClick?: () => void;
  children: ReactNode;
  title?: string;
}) {
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
