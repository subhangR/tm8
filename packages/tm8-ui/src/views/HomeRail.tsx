/**
 * HomeRail — the unified Home's icon rail (task 01a00932 R4).
 *
 * ENTITIES ONLY: every row is a collection kind; there are no view rows here
 * ("there is no code and shit in the rails, only entities" — reporter ruling,
 * 2026-08-16). The rows come from `homeRailGroups()` — the same registry
 * table the list header's kind switcher flattens — so the rail and the
 * switcher cannot disagree about the population; only the arrangement
 * (visual grouping) differs. Clicking a row IS the switcher: one `onSelect`,
 * one root state, one route.
 *
 * ANATOMY: collapsed by default at 72px, each mark keeping its word beneath
 * it — the #269 ruling ("collapsed keeps the word") applied to this rail;
 * an icon-only strip identifiable only by hovering is the arrangement that
 * ruling exists to prevent. Expanded, rows widen to icon-beside-word with
 * the group labels as eyebrows.
 *
 * THE COLLAPSE FLAG IS THE HOST'S, NOT THIS COMPONENT'S (task 01a00ac2).
 * It used to live here as its own `usePanelFlag('home-rail-collapsed')`.
 * That stopped working the moment column A became resizable: `HomeView`'s
 * width solver has to subtract this rail's width before it can tell whether
 * A + B still fit beside C, and 72-vs-172 is the difference between "beside"
 * and "overlay" on a laptop. Two `usePanelFlag` hooks on one key would each
 * hold their own `useState` and drift apart on the first toggle, so the flag
 * is READ ONCE in the host and handed down. The storage key is unchanged.
 */
import { KindIcon, type HomeRailGroup } from '../domain';

export interface HomeRailProps {
  groups: readonly HomeRailGroup[];
  /** The active KIND root, or null while Chats is the root (no rail row is
   *  active then — chats live in the list header, not the rail). */
  activeKind: string | null;
  onSelect(kind: string): void;
  /** Owned by `HomeView` — see the docblock. */
  collapsed: boolean;
  onToggleCollapsed(): void;
}

export function HomeRail({ groups, activeKind, onSelect, collapsed, onToggleCollapsed }: HomeRailProps) {
  return (
    <nav
      className={`hr-rail${collapsed ? ' hr-rail--collapsed' : ''}`}
      aria-label="Entity lists"
      data-testid="home-rail"
      data-collapsed={collapsed ? 'true' : 'false'}
    >
      <div className="hr-rail__scroll">
        {groups.map((group) => (
          <div key={group.id} className="hr-rail__group" role="group" aria-label={group.label}>
            {!collapsed ? <span className="hr-rail__eyebrow">{group.label}</span> : null}
            {group.kinds.map((config) => (
              <button
                key={config.kind}
                type="button"
                className="hr-rail__row"
                aria-current={config.kind === activeKind ? 'true' : undefined}
                title={config.labelPlural}
                onClick={() => onSelect(config.kind)}
              >
                <span className="hr-rail__glyph" aria-hidden>
                  <KindIcon kind={config.kind} />
                </span>
                <span className="hr-rail__label">{config.labelPlural}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
      <button
        type="button"
        className="hr-rail__toggle"
        aria-expanded={!collapsed}
        title={collapsed ? 'Expand the rail' : 'Collapse the rail'}
        onClick={onToggleCollapsed}
      >
        <span aria-hidden>{collapsed ? '»' : '«'}</span>
      </button>
    </nav>
  );
}
