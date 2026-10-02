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
export function ChildCountBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="lp__kids" aria-hidden data-testid="child-count">
      {count}
    </span>
  );
}
