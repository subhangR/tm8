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
  /**
   * How many entities of this kind are OPEN (`to_do` + `in_progress`), or
   * `undefined` when that has not been read — see the badge docblock for why
   * those two must render differently. Optional so a host that has no counts
   * seam (a harness, a preview) mounts the rail unchanged.
   */
  openCountFor?: (kind: string) => number | undefined;
}

/**
 * THE RAIL'S NUMBER IS WHAT IS OPEN, and only what is open.
 *
 * A lifetime total is the number this rail must NOT draw — the menu rail
 * learned that the hard way (see `MenuRail`'s `CountBadge`): a total only ever
 * grows, reads the same on every visit, and cannot be acted on. "Open" moves
 * whenever anyone finishes anything, which is what makes it worth a glance.
 *
 * NOTHING and ZERO ARE DIFFERENT FACTS, and this is the whole reason the
 * accessor returns `number | undefined`:
 *
 *   - `undefined` — not read yet, or a node that cannot serve the aggregate.
 *     Draw NOTHING. A `0` here would be a claim we have not earned.
 *   - `0` — read, and genuinely nothing open. Also draw nothing, but for the
 *     opposite reason: a caught-up rail should be quiet, and fifteen zeroes
 *     down the left edge is noise that makes the real numbers harder to see.
 *
 * They render alike and mean differently, which is fine — neither is worth
 * pixels. What matters is that the DISTINCTION survives to here rather than
 * being flattened to `0` upstream, because the moment anyone wants to draw
 * "—" for unknown, the fact is still in hand.
 */
function OpenBadge({ count }: { count: number | undefined }) {
  if (count === undefined || count <= 0) return null;
  return <span className="hr-rail__badge">{count}</span>;
}

/**
 * The row's accessible name.
 *
 * AN EXPLICIT LABEL, not the text content, because the content computes to
 * "Tasks12 open" — adjacent inline spans concatenate with NO separator, so the
 * word and the number run together and the badge is announced as part of the
 * kind. Saying it outright also names the UNIT: "12" alone is a quantity of
 * nothing in particular, and "open" is the entire point of this number.
 *
 * The visible label stays the FIRST word of the accessible name, which is what
 * keeps voice control working (WCAG 2.5.3): "click Tasks" still matches.
 */
function rowLabel(labelPlural: string, count: number | undefined): string | undefined {
  return count === undefined || count <= 0 ? undefined : `${labelPlural}, ${count} open`;
}

/**
 * The hover text. Present only when there is a count to report, so the
 * attribute is omitted rather than rendered empty — and it names the number
 * even when it is ZERO, which the badge deliberately does not draw. "0 open"
 * on hover is the one place "I read it and there are none" is distinguishable
 * from "I never read it".
 */
function rowTitle(labelPlural: string, count: number | undefined): string {
  return count === undefined ? labelPlural : `${labelPlural} — ${count} open`;
}

export function HomeRail({ groups, activeKind, onSelect, collapsed, onToggleCollapsed, openCountFor }: HomeRailProps) {
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
            {group.kinds.map((config) => {
              const open = openCountFor?.(config.kind);
              return (
                <button
                  key={config.kind}
                  type="button"
                  className="hr-rail__row"
                  aria-current={config.kind === activeKind ? 'true' : undefined}
                  aria-label={rowLabel(config.labelPlural, open)}
                  title={rowTitle(config.labelPlural, open)}
                  onClick={() => onSelect(config.kind)}
                >
                  <span className="hr-rail__glyph" aria-hidden>
                    <KindIcon kind={config.kind} />
                  </span>
                  <span className="hr-rail__label">{config.labelPlural}</span>
                  {/* ONE badge element in BOTH states, not two conditionals.
                      The collapsed row is a column (mark over word) and the
                      expanded row is a line, so the badge only needs to move
                      — which CSS does. Rendering a separate corner mark would
                      be a second copy of the same number, and the menu rail's
                      docblock records exactly how those two copies drift. */}
                  <OpenBadge count={open} />
                </button>
              );
            })}
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
