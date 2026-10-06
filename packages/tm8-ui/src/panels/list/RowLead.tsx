import type { ReactNode } from 'react';
import type { PillTone } from '../../kit';
import { KindIcon } from '../../domain';
import { ChildCountBadge } from './ChildCountBadge';

/**
 * THE ROW'S LEADING ICON AS ITS DISCLOSURE (`rowLead="icon"`, the Workspace
 * browser only). One slot replaces the chevron and the status mark on every
 * anatomy: the kind icon tinted by the status tone (or the session's agent
 * tile), with the child count as a subscript on its corner.
 *
 * WITH CHILDREN IT IS THE EXPAND BUTTON, and the only control that changes
 * expansion; its click never reaches the row, so it never opens a tab.
 * Without children it is decoration, and a click on it falls through to the
 * row and opens it.
 */
export function RowLead({
  icon,
  rowTitle,
  tooltip,
  childCount,
  expanded,
  onToggle,
  badge = true,
}: {
  icon: ReactNode;
  rowTitle: string;
  /** Names the status and the kind ("In progress · Task"), the old status mark's tooltip. */
  tooltip?: string | undefined;
  childCount: number;
  expanded: boolean;
  onToggle?: (() => void) | undefined;
  /** False when the icon draws its own count (the session's agent tile). */
  badge?: boolean;
}) {
  const kids = childCount > 0 && onToggle !== undefined;
  const count = badge ? <ChildCountBadge count={childCount} expanded={expanded} /> : null;
  if (!kids) {
    return (
      <span className="lp-lead" title={tooltip}>
        {icon}
        {count}
      </span>
    );
  }
  return (
    <button
      type="button"
      className="lp-lead lp-lead--toggle"
      data-lead-toggle
      aria-label={`${expanded ? 'Collapse' : 'Expand'} ${rowTitle}, ${childCount} ${childCount === 1 ? 'child' : 'children'}`}
      aria-expanded={expanded}
      title={`${expanded ? 'Hide' : 'Show'} ${childCount} ${childCount === 1 ? 'child' : 'children'}${tooltip ? ` · ${tooltip}` : ''}`}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
    >
      {icon}
      {count}
    </button>
  );
}

/** The kind's own icon, tinted by the status tone the dot used to carry. */
export function ToneKindIcon({
  kind,
  tone,
  hollow,
  streaming,
}: {
  kind: string;
  tone: PillTone | string | null;
  hollow: boolean;
  streaming: boolean;
}) {
  return (
    <span
      className={`lp-lead__kind${tone ? ` lp-lead__kind--${tone}` : ''}`}
      data-hollow={hollow || undefined}
      data-streaming={streaming || undefined}
      aria-hidden
    >
      <KindIcon kind={kind} size={18} />
    </span>
  );
}

/** The lead icon's tooltip: the status, then the kind ("In progress · Task"). */
export function leadTooltip(status: string | null | undefined, noun: string): string {
  if (!status) return noun;
  const word = status.replace(/_/g, ' ');
  return `${word.charAt(0).toUpperCase()}${word.slice(1)} · ${noun}`;
}
