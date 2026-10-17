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

/**
 * THE SAME SUBSCRIPT, AS THE DISCLOSURE — for a row whose leading icon is
 * already a control of its own (the task's status dot is its state picker),
 * so the icon cannot also be the button. The count is the toggle there, in the
 * same corner it is drawn in on every other row (task 01a14b92).
 */
export function ChildCountToggle({
  count,
  expanded,
  rowTitle,
  onToggle,
}: {
  count: number;
  expanded: boolean;
  rowTitle: string;
  onToggle: () => void;
}) {
  if (count <= 0) return null;
  return (
    <button
      type="button"
      className="lp__kids lp__kids--toggle"
      data-testid="child-count"
      data-expanded={expanded ? 'true' : 'false'}
      aria-label={`${expanded ? 'Collapse' : 'Expand'} ${rowTitle}, ${count} ${count === 1 ? 'child' : 'children'}`}
      aria-expanded={expanded}
      title={`${expanded ? 'Hide' : 'Show'} ${count} ${count === 1 ? 'child' : 'children'}`}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      {count > 99 ? '99+' : count}
    </button>
  );
}
