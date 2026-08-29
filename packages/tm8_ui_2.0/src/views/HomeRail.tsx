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
import {
  entityNavigationLabel,
  type EntityNavigationGroup,
  KindIcon,
} from '../domain';
import { EntityNavigationMetrics } from '../navigation';

export interface HomeRailProps {
  groups: readonly EntityNavigationGroup[];
  /** The active KIND root, or null while Chats is the root (no rail row is
   *  active then — chats live in the list header, not the rail). */
  activeKind: string | null;
  onSelect(kind: string): void;
  /** Owned by `HomeView` — see the docblock. */
  collapsed: boolean;
  onToggleCollapsed(): void;
}

export function HomeRail({ groups, activeKind, onSelect, collapsed, onToggleCollapsed }: HomeRailProps) {
  const kindCount = groups.reduce((sum, group) => sum + group.items.length, 0);

  return (
    <nav
      className={`hr-rail${collapsed ? ' hr-rail--collapsed' : ''}`}
      aria-label="Entity lists"
      data-testid="home-rail"
      data-collapsed={collapsed ? 'true' : 'false'}
    >
      {!collapsed ? (
        <div className="hr-rail__mast k-hero k-accent-top">
          <span className="hr-rail__mast-label k-label">Browse</span>
          <span className="hr-rail__mast-count">{kindCount} entity types</span>
        </div>
      ) : null}
      <div className="hr-rail__scroll">
        {groups.map((group) => (
          <div
            key={group.id}
            className="hr-rail__group"
            role="group"
            aria-label={`${group.label}: ${group.description}`}
          >
            {!collapsed ? (
              <span className="hr-rail__grouphead">
                <span className="hr-rail__eyebrow">{group.label}</span>
                <EntityNavigationMetrics total={group.total} live={group.live} />
              </span>
            ) : null}
            {group.items.map((item) => (
              <button
                key={item.config.kind}
                type="button"
                className="hr-rail__row k-press"
                aria-current={item.config.kind === activeKind ? 'page' : undefined}
                aria-label={entityNavigationLabel(item)}
                title={entityNavigationLabel(item)}
                onClick={() => onSelect(item.config.kind)}
              >
                <span className="hr-rail__glyph" aria-hidden>
                  <KindIcon kind={item.config.kind} />
                </span>
                <span className="hr-rail__label">{item.config.labelPlural}</span>
                {/* ONE number per row — see the note in `HomePage`. Expanded,
                    this row used to carry a total AND an "N new" pill, and the
                    pair squeezed the word "Sessions" clean off its own row
                    (owner screenshot, 2026-08-29: `: 577 · 471 new · 17 live`).
                    A nav row that does not say what it is, is not a nav row. */}
                <EntityNavigationMetrics
                  total={item.counts?.total}
                  live={item.live}
                  className="hr-rail__metrics"
                />
              </button>
            ))}
          </div>
        ))}
      </div>
      <button
        type="button"
        className="hr-rail__toggle k-press"
        aria-expanded={!collapsed}
        aria-label={collapsed ? 'Expand the rail' : 'Collapse the rail'}
        title={collapsed ? 'Expand the rail' : 'Collapse the rail'}
        onClick={onToggleCollapsed}
      >
        {!collapsed ? <span className="hr-rail__toggle-label">Collapse</span> : null}
        <span aria-hidden>{collapsed ? '»' : '«'}</span>
      </button>
    </nav>
  );
}
