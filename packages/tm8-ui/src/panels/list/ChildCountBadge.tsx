/**
 * THE SUB-ENTITY COUNT, ON THE LEADING ICON'S CORNER — the pattern the session
 * tile established (`pn-agent__kids`), given to every tree anatomy so a parent
 * row says "there are N under me" in the same place whatever its kind.
 *
 * Its parent must be the icon slot and must be `position: relative`; the pill
 * is positioned, not laid out, so it never moves the title.
 *
 * Decorative by design: the row's disclosure control already names the count
 * in its accessible label ("Expand X, 3 children"), so a second announcement
 * here would only double it. A row with no children renders NOTHING rather
 * than a zero — having no sub-entities is not a count of them.
 */
export function ChildCountBadge({ count, expanded }: { count: number; expanded?: boolean }) {
  if (count <= 0) return null;
  return (
    <span
      className="lp__kids"
      aria-hidden
      data-testid="child-count"
      /* Only the Workspace browser's lead icon passes it: filled when open,
         outline when shut. Absent ⇒ no attribute, the pill as before. */
      data-expanded={expanded === undefined ? undefined : expanded ? 'true' : 'false'}
    >
      {/* The lead-icon subscript (R37) caps at 99+; the classic pill is unchanged. */}
      {expanded !== undefined && count > 99 ? '99+' : count}
    </span>
  );
}
