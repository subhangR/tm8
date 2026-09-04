import type { ReactNode } from 'react';

/**
 * Chip (Z1) — kind glyph + name, bordered, clickable (T0-1 detail-panel edge
 * chips: "⑂ PR #212", "▤ Layout spec", "▣ forge"). Hover-preview (Z2 card)
 * and drag behavior arrive with the shell — this is only the visual atom.
 *
 * `disabledReason` is the honest disabled API: setting it marks the chip
 * `aria-disabled`, surfaces the reason as the tooltip, and makes the click
 * inert. There is deliberately no bare `disabled` prop — a dead control with
 * no stated reason is the silent-dead problem the honesty kit exists to end.
 */
export function Chip({
  glyph,
  onClick,
  children,
  title,
  disabledReason,
}: {
  glyph?: ReactNode;
  onClick?: () => void;
  children: ReactNode;
  title?: string;
  /** Set ⇒ aria-disabled, tooltip carries the reason, onClick never fires. */
  disabledReason?: string;
}) {
  const disabled = disabledReason !== undefined;
  /* `glyph` is a NODE, not a character: kind marks are drawn (domain/KindIcon)
     because twenty text glyphs cannot stay distinct at this size. A string
     still works and still renders — the callers that pass a text mark for a
     non-kind thing did not have to change. */
  return (
    <button
      type="button"
      className="kit-chip"
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
      title={disabled ? disabledReason : title}
    >
      {glyph ? (
        <span aria-hidden className="kit-chip__glyph">
          {glyph}
        </span>
      ) : null}
      {children}
    </button>
  );
}
