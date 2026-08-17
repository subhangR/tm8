/**
 * MenuRail — the space menu, rendered from per-space `MenuConfig` DATA
 * (RULING H, LLD §4.1). There is no hard-coded menu chrome here: exactly three
 * row grammars, each chosen by the SHAPE of the data, never by a ref literal.
 *
 *   1. Group header — `MenuGroup.label`. Label only, never clickable.
 *   2. Plain row    — a `MenuItem` without children (view ref or kind ref).
 *   3. Caret row    — a VIEW item WITH children (≤8, depth exactly ≤1). The row
 *                     click opens the view; the caret alone toggles the leaves.
 *
 * Width is DISCRETE — two values, never a continuum (02-LAYOUT §1, WLT §6).
 * Collapsed renders the icon with its WORD underneath, which is why every view
 * and kind ref must still carry a glyph; a ref that cannot be presented fails
 * the config closed rather than rendering a blank row.
 *
 * Provenance: row grammar + measurements from the T1-1 "Menu rail grammar"
 * canvas (the dedicated rail frame); the unified server rows and the two
 * footers from T0-1. Colors always resolve through tokens (D5).
 */
import { useState, type ReactNode } from 'react';
import type { MenuConfig, MenuItem, MenuLeaf, MenuViewRef } from '@tm8/contract';
import { REASONS } from '../domain';
import { VectorIcon } from '../kit';
import type { CollectionMode, GroupByKey } from '../domain';
import { VIEW_PRESENTATION } from './menu-resolve';
import { MENU_COLLAPSED, MENU_EXPANDED } from './geometry';

/** What a menu ref needs in order to be drawn. */
export interface RefPresentation {
  label: string;
  /**
   * The row's mark. A NODE, not a character: kinds and views are both drawn
   * (`KindIcon` / `VectorIcon`) because the collapsed rail leads with the mark
   * and gives it most of the row — near-identical text glyphs stopped being a
   * cosmetic problem the moment the icon became the row's dominant feature.
   */
  icon: ReactNode;
  /** Optional trailing count, e.g. Tasks `18`. */
  badge?: string | number;
  /** Optional live count — renders as the green `● n` treatment. */
  live?: number;
  /**
   * How many of `badge` the viewer has not seen yet.
   *
   * DELIBERATELY NOT FOLDED INTO `live`. Green `● n` means RUNNING throughout
   * this product (live sessions, voice participants) — a fact about the world.
   * Unseen is a fact about THIS VIEWER's relationship to the rows, so it gets
   * its own quieter treatment and never competes with the live dot. Sessions
   * are the row that would otherwise have to choose between them, and it
   * carries both.
   */
  unseen?: number;
}

/**
 * A live entity row inserted beneath a menu group. Channels use this seam: the
 * group label remains grammar 1 (plain text), while every actual channel is a
 * real navigation row carrying its unread and working counts.
 *
 * Kept generic so the rail still knows no entity kind. The host supplies the
 * kind alongside the id and the domain registry supplies the presentation.
 */
export interface MenuEntityRow extends RefPresentation {
  id: string;
  kind: string;
  parentId?: string | null;
}

export interface MenuDynamicGroup {
  /** Dynamic rows replace authored items for Channels; other groups may append. */
  replaceConfiguredItems?: boolean;
  items: readonly MenuEntityRow[];
  emptyLabel?: string;
}

/**
 * Kind refs resolve through the DOMAIN REGISTRY, injected. Shell never maps a
 * kind literal itself: §15.2 makes that a build failure, and the registry is
 * the single behavior authority for all kinds (§10.2.3).
 */
export type KindPresenter = (ref: string) => RefPresentation | null;

export type MenuTarget =
  | { type: 'view'; ref: MenuViewRef }
  /**
   * `mode` is the kind screen's LAYOUT — route state the shell holds so the
   * panel's switcher survives navigation (§1.1). The rail never sets it; it
   * rides along so switching kinds and switching layout are one target shape.
   */
  | {
      type: 'kind';
      ref: string;
      mode?: CollectionMode;
      /**
       * The BOARD's grouping choice (W3) — route state exactly like `mode`,
       * held by the shell so a grouped board is shareable and survives
       * reload. The rail never sets it; `routes/q.ts` carries it as
       * `q.groupBy` (`workStatus` | `assignee` | `axis:<name>`).
       */
      groupBy?: GroupByKey;
    }
  | { type: 'entity'; ref: string; kind: string };

export interface ServerRailItem {
  id: string;
  label: string;
  local: boolean;
  reachability: 'checking' | 'online' | 'offline';
}

export interface MenuRailProps {
  config: MenuConfig;
  /** Discrete by law. */
  collapsed: boolean;
  onToggle(): void;
  /** Which row reads as current. */
  activeTarget?: MenuTarget | null;
  onNavigate(target: MenuTarget): void;
  presentKind: KindPresenter;
  /** Live rows keyed by MenuGroup.id, rendered directly beneath its cluster. */
  dynamicGroups?: Readonly<Record<string, MenuDynamicGroup | undefined>>;
  /**
   * The identity block at the rail's head — the single server ⋄ space control
   * (single-home ruling, 2026-08-14). A SLOT, not rendered props: the rail has
   * no business knowing how servers are listed, how a space switch resets nav
   * state, or what adding either looks like. `SpaceSwitcher` is the intended
   * occupant; left undefined the rail simply starts at the menu, so a rail
   * rendered without a host (the shell tests) is unchanged in behaviour.
   *
   * This slot RETIRED the in-rail server monogram rows and the add-server
   * footer: server identity was drawn twice (rail rows + tab-bar label) with a
   * purely decorative caret, and servers are a context you stand inside — a
   * profile — not a navigation destination, so they do not belong in a menu.
   */
  identitySlot?: ReactNode;
}

/**
 * The add-server reason is the REGISTRY's, not the rail's.
 *
 * This was a near-duplicate — the rail authored 'remote servers arrive in
 * Phase 2' beside `REASONS.addServerDeferred`, which additionally names what IS
 * wired. Two authored versions of one honesty sentence diverge silently: reword
 * one and the other quietly keeps saying something narrower. Importing the
 * canonical string makes the rail's control and the palette's disabled row for
 * the same feature identical BY CONSTRUCTION rather than by care (A1a's
 * finding; the same class as D34's copy-drift). `domain` is DAG-legal from
 * shell, and REASONS names no kind.
 */
export const ADD_SERVER_DISABLED_REASON = REASONS.addServerDeferred;

const sameTarget = (a: MenuTarget | null | undefined, b: MenuTarget): boolean =>
  !!a && a.type === b.type && a.ref === b.ref;

interface MenuEntityNode {
  row: MenuEntityRow;
  children: MenuEntityNode[];
}

/** Build the same parent/child channel tree Collab v2's navigation rendered. */
function entityTree(rows: readonly MenuEntityRow[]): MenuEntityNode[] {
  const ids = new Set(rows.map((row) => row.id));
  const children = new Map<string, MenuEntityRow[]>();
  const roots: MenuEntityRow[] = [];

  for (const row of rows) {
    if (!row.parentId || !ids.has(row.parentId) || row.parentId === row.id) {
      roots.push(row);
      continue;
    }
    const siblings = children.get(row.parentId) ?? [];
    siblings.push(row);
    children.set(row.parentId, siblings);
  }

  const build = (row: MenuEntityRow, ancestors: ReadonlySet<string>): MenuEntityNode => {
    if (ancestors.has(row.id)) return { row, children: [] };
    const next = new Set(ancestors);
    next.add(row.id);
    return {
      row,
      children: (children.get(row.id) ?? []).map((child) => build(child, next)),
    };
  };

  return roots.map((row) => build(row, new Set()));
}

/** Resolves an item/leaf to its presentation, or null when it cannot be drawn. */
function present(node: MenuItem | MenuLeaf, presentKind: KindPresenter): RefPresentation | null {
  if (node.type !== 'view') return presentKind(node.ref);
  const view = VIEW_PRESENTATION[node.ref];
  return view ? { label: view.label, icon: <VectorIcon paths={view.art} /> } : null;
}

/**
 * The COLLAPSED row's accessible name, composed from every part the row shows.
 *
 * An `aria-label` on a button REPLACES the accessible name computed from its
 * contents — so the moment the collapsed row carried one, every corner mark
 * inside it became invisible to assistive tech no matter what it rendered.
 * That is why the label is built from the parts rather than set to the bare
 * kind name (D31). It survives the caption: the caption prints the NAME, while
 * the counts are still drawn as `aria-hidden` corner marks, so without this
 * composition the numbers would go back to being sighted-only.
 *
 * The asymmetry is deliberate and follows C8/L10: `live` is a STATUS, so it
 * needs the WORD — "3 live", never a naked "3". `badge` is a QUANTITY, which is
 * complete on its own.
 */
function collapsedLabel(presentation: RefPresentation): string {
  const parts = [presentation.label];
  // The TOTAL is still announced here even though it is no longer drawn: a
  // collapsed rail gives assistive tech no hover to reach `title` with, so
  // dropping it would remove the count from AT users only.
  if (presentation.badge !== undefined) parts.push(String(presentation.badge));
  if (presentation.live !== undefined) parts.push(`${presentation.live} live`);
  // Same C8/L10 rule as `live`: news is a STATUS, so it needs the word.
  if (presentation.unseen) parts.push(`${presentation.unseen} new`);
  return parts.join(', ');
}

/**
 * The rail's one number: WHAT IS NEW, not how much exists.
 *
 * IT USED TO DRAW THE TOTAL, AND THAT WAS THE WRONG NUMBER. A lifetime total
 * only ever grows, is identical on every visit, and cannot be acted on — the
 * rail read "Docs 61 / Sessions 50 / Tasks 38" and said the same thing forever.
 * Worse, before the 068 watermark almost every row was also unseen (93% of
 * entities had never been marked read), so each kind rendered its total twice:
 * once plain, once in bold.
 *
 * So the badge is now the UNSEEN count and nothing else, and a kind with
 * nothing new draws NO badge at all. A quiet rail is the correct rendering of
 * a quiet workspace; numbers appear when something actually changes, which is
 * what makes them worth looking at.
 *
 * THE TOTAL IS NOT DISCARDED, it is demoted: it rides in the row's `title`
 * (and in the collapsed accessible name), so "how many docs are there" is one
 * hover away without spending the rail's scarce numeric slot on a constant.
 *
 * One component for all three render sites (configured item, caret leaf,
 * dynamic entity row) because three hand-rolled copies is exactly how the
 * collapsed corner marks and the a11y wording drift apart.
 */
function CountBadge({ presentation }: { presentation: RefPresentation }) {
  const unseen = presentation.unseen ?? 0;
  // Nothing new ⇒ nothing drawn. Deliberately not `0`: a zero is visual noise
  // on every row of a caught-up workspace, and it reads as a state ("zero
  // docs") rather than as the absence of news.
  if (unseen <= 0) return null;
  return (
    <span className="shell-rail__badge shell-rail__badge--unseen">
      {unseen}
      <span className="shell-vh"> new</span>
    </span>
  );
}

/**
 * The hover text carrying what the badge no longer spends a slot on.
 *
 * Returns undefined when there is no total to report, so the attribute is
 * omitted rather than rendered empty.
 */
function countTitle(presentation: RefPresentation): string | undefined {
  if (presentation.badge === undefined) return undefined;
  const unseen = presentation.unseen ?? 0;
  return unseen > 0
    ? `${presentation.badge} ${presentation.label.toLowerCase()}, ${unseen} new`
    : `${presentation.badge} ${presentation.label.toLowerCase()}`;
}

function DynamicEntityRows({
  items,
  collapsed,
  activeTarget,
  onNavigate,
}: {
  items: readonly MenuEntityRow[];
  collapsed: boolean;
  activeTarget?: MenuTarget | null;
  onNavigate(target: MenuTarget): void;
}) {
  return entityTree(items).map((node) => (
    <DynamicEntityNode
      key={node.row.id}
      node={node}
      depth={0}
      collapsed={collapsed}
      activeTarget={activeTarget}
      onNavigate={onNavigate}
    />
  ));
}

function DynamicEntityNode({
  node,
  depth,
  collapsed,
  activeTarget,
  onNavigate,
}: {
  node: MenuEntityNode;
  depth: number;
  collapsed: boolean;
  activeTarget?: MenuTarget | null;
  onNavigate(target: MenuTarget): void;
}) {
  const { row } = node;
  const target: MenuTarget = { type: 'entity', ref: row.id, kind: row.kind };
  const active = sameTarget(activeTarget, target);
  const label = collapsedLabel(row);

  return (
    <>
      <button
        type="button"
        className={`shell-rail__row shell-rail__entity ${active ? 'shell-rail__row--active' : ''}`}
        data-entity-id={row.id}
        data-depth={depth}
        aria-current={active ? 'page' : undefined}
        aria-label={collapsed ? label : undefined}
        title={collapsed ? label : undefined}
        style={!collapsed && depth > 0 ? { paddingLeft: 12 + depth * 12 } : undefined}
        onClick={() => onNavigate(target)}
      >
        <span className="shell-rail__icon" aria-hidden="true">{row.icon}</span>
        {/* The label is drawn in BOTH states — beside the icon expanded, under
            it collapsed. The stylesheet turns the row into a column; nothing
            here branches on `collapsed` for the word itself. */}
        <span className="shell-rail__label">{row.label}</span>
        {!collapsed && row.live !== undefined && row.live > 0 ? (
          <span className="shell-rail__live">
            <span className="shell-rail__live-dot" aria-hidden="true" />
            {row.live}<span className="shell-vh"> live</span>
          </span>
        ) : null}
        {!collapsed && row.badge !== undefined && row.badge !== 0 ? (
          <span className="shell-rail__badge">{row.badge}</span>
        ) : null}
        {collapsed && row.badge !== undefined && row.badge !== 0 ? (
          <span className="shell-rail__badge-corner" aria-hidden="true">{row.badge}</span>
        ) : null}
        {collapsed && row.live !== undefined && row.live > 0 ? (
          <span className="shell-rail__live-corner" aria-hidden="true">{row.live}</span>
        ) : null}
      </button>
      {node.children.map((child) => (
        <DynamicEntityNode
          key={child.row.id}
          node={child}
          depth={depth + 1}
          collapsed={collapsed}
          activeTarget={activeTarget}
          onNavigate={onNavigate}
        />
      ))}
    </>
  );
}

export function MenuRail(props: MenuRailProps) {
  const { config, collapsed, activeTarget, onNavigate, presentKind } = props;
  // Which caret rows are open. Revision 11 ships every caret CLOSED: the rail
  // is ~8 rows of intents, and the caret leaves are the one-click-deeper
  // classification rather than a thirty-row wall on first paint.
  const [openRows, setOpenRows] = useState<Record<string, boolean>>({});

  const width = collapsed ? MENU_COLLAPSED : MENU_EXPANDED;

  return (
    <nav
      className={`shell-rail ${collapsed ? 'shell-rail--collapsed' : 'shell-rail--expanded'}`}
      style={{ width }}
      aria-label="Space menu"
      data-testid="menu-rail"
      data-collapsed={collapsed}
    >
      <div className="shell-rail__scroll">
        {props.identitySlot ?? null}
        {config.groups.map((group) => (
          <div key={group.id} className="shell-rail__group" role="group" aria-label={group.label}>
            {/* GRAMMAR 1 — the group boundary. Revision 11 retired the printed
                eyebrow label: with six intent clusters of one or two rows each,
                a header above every row doubled the rail's height while saying
                what the row already says ("HOME" over "Home"). The label
                survives as the group's ACCESSIBLE name above and the boundary
                survives as spacing — and, collapsed, as the hairline the canvas
                draws, exactly as before. */}
            {collapsed ? (
              <div className="shell-rail__divider" role="separator" aria-label={group.label} />
            ) : null}

            {(props.dynamicGroups?.[group.id]?.replaceConfiguredItems ? [] : group.items).map((item) => {
              const presentation = present(item, presentKind);
              if (!presentation) return null;

              const target: MenuTarget = { type: item.type, ref: item.ref } as MenuTarget;
              const active = sameTarget(activeTarget, target);
              const children = item.type === 'view' ? item.children ?? [] : [];
              const hasChildren = children.length > 0;
              const open = openRows[item.ref] ?? false;

              return (
                <div key={item.ref}>
                  {/* GRAMMARS 2 & 3 differ only by the caret: a view item WITH
                      children gets one. The ROW still navigates in both cases
                      (RULING E: "row click = the composed view"). */}
                  <button
                    type="button"
                    className={`shell-rail__row ${active ? 'shell-rail__row--active' : ''}`}
                    aria-current={active ? 'page' : undefined}
                    aria-label={collapsed ? collapsedLabel(presentation) : undefined}
                    title={collapsed ? collapsedLabel(presentation) : countTitle(presentation)}
                    onClick={() => onNavigate(target)}
                  >
                    <span className="shell-rail__icon" aria-hidden="true">
                      {presentation.icon}
                    </span>
                    <span className="shell-rail__label">{presentation.label}</span>
                    {!collapsed && presentation.live !== undefined && (
                      <span className="shell-rail__live">
                        <span className="shell-rail__live-dot" aria-hidden="true" />
                        {presentation.live}
                        {/* The colour says "live"; C8/L10 requires the word too. */}
                        <span className="shell-vh"> live</span>
                      </span>
                    )}
                    {!collapsed && <CountBadge presentation={presentation} />}
                    {/* Collapsed, counts survive as corner marks — the count is
                        information, so it degrades rather than disappearing.
                        Both marks are aria-hidden because the row's composed
                        aria-label already carries their values; leaving them
                        exposed would double-announce every count. */}
                    {/* Collapsed, the corner mark is the UNSEEN count, matching
                        the expanded badge. It used to show the lifetime total,
                        which pinned a permanent two-digit number to a 48px
                        icon rail and never changed. */}
                    {collapsed && (presentation.unseen ?? 0) > 0 && (
                      <span
                        className="shell-rail__badge-corner shell-rail__badge-corner--unseen"
                        aria-hidden="true"
                      >
                        {presentation.unseen}
                      </span>
                    )}
                    {collapsed && presentation.live !== undefined && (
                      <span className="shell-rail__live-corner" aria-hidden="true">
                        {presentation.live}
                      </span>
                    )}
                    {!collapsed && hasChildren && (
                      // The caret is its own control INSIDE the row: expanding
                      // must not navigate, and navigating must not expand.
                      <span
                        role="button"
                        tabIndex={0}
                        className="shell-rail__caret"
                        aria-label={`${open ? 'Collapse' : 'Expand'} ${presentation.label}`}
                        aria-expanded={open}
                        onClick={(event) => {
                          event.stopPropagation();
                          setOpenRows((rows) => ({ ...rows, [item.ref]: !open }));
                        }}
                        onKeyDown={(event) => {
                          if (event.key !== 'Enter' && event.key !== ' ') return;
                          event.preventDefault();
                          event.stopPropagation();
                          setOpenRows((rows) => ({ ...rows, [item.ref]: !open }));
                        }}
                      >
                        {open ? '▾' : '▸'}
                      </span>
                    )}
                  </button>

                  {/* Leaves: pre-filtered Entity Views, one grammar across all
                      groups (RULING E).

                      THEY RENDER COLLAPSED TOO. The old rule was "never
                      rendered collapsed — a 48px rail has no room to say what a
                      leaf is", and that was survivable only while the rail
                      opened EXPANDED: collapsing was then a deliberate,
                      momentary act by someone who knew what they were hiding.
                      It stops being survivable the moment the rail starts
                      collapsed, because the shipped default hangs Tasks,
                      Sessions, Docs, Teammates, Memories, Artifacts, Loops and
                      Files off ONE caret row — eight of the rail's
                      destinations, unreachable on first paint.

                      The leaf keeps its icon, its word and the same composed
                      `aria-label` its parent row uses collapsed, and loses only
                      the guide line — the indent it has no room to draw. */}
                  {/* COLLAPSED SHOWS EVERY LEAF, regardless of the caret. The
                      caret control itself renders only expanded, so a closed
                      caret would strand its children entirely. `open` gates the
                      expanded rail only. */}
                  {(collapsed || open) &&
                    children.map((leaf) => {
                      const leafPresentation = present(leaf, presentKind);
                      if (!leafPresentation) return null;
                      const leafTarget: MenuTarget = { type: leaf.type, ref: leaf.ref } as MenuTarget;
                      const leafActive = sameTarget(activeTarget, leafTarget);
                      return (
                        <button
                          key={leaf.ref}
                          type="button"
                          className={`shell-rail__leaf ${leafActive ? 'shell-rail__leaf--active' : ''}`}
                          aria-current={leafActive ? 'page' : undefined}
                          aria-label={collapsed ? collapsedLabel(leafPresentation) : undefined}
                          title={collapsed ? collapsedLabel(leafPresentation) : countTitle(leafPresentation)}
                          onClick={() => onNavigate(leafTarget)}
                        >
                          {/* The guide is the indent that says "this belongs to
                              the row above". Collapsed there is no indent to
                              draw it against, and the rail reads as one centred
                              column — so the leaf shows its own icon instead. */}
                          {collapsed ? (
                            <span className="shell-rail__icon" aria-hidden="true">
                              {leafPresentation.icon}
                            </span>
                          ) : (
                            <span className="shell-rail__guide" aria-hidden="true" />
                          )}
                          <span className="shell-rail__label">{leafPresentation.label}</span>
                          {!collapsed && leafPresentation.live !== undefined && (
                            <span className="shell-rail__live">
                              <span className="shell-rail__live-dot" aria-hidden="true" />
                              {leafPresentation.live}
                              {/* Same C8/L10 obligation as the row above: the
                                  leaf's green dot is colour, and colour alone
                                  never carries status. Found by the row-level
                                  test, which caught this second instance. */}
                              <span className="shell-vh"> live</span>
                            </span>
                          )}
                          {!collapsed && <CountBadge presentation={leafPresentation} />}
                          {/* Collapsed, counts degrade to corner marks exactly
                              as the parent row's do — aria-hidden, because the
                              composed label above already carries the numbers. */}
                          {collapsed && (leafPresentation.unseen ?? 0) > 0 && (
                            <span
                              className="shell-rail__badge-corner shell-rail__badge-corner--unseen"
                              aria-hidden="true"
                            >
                              {leafPresentation.unseen}
                            </span>
                          )}
                          {collapsed && leafPresentation.live !== undefined && (
                            <span className="shell-rail__live-corner" aria-hidden="true">
                              {leafPresentation.live}
                            </span>
                          )}
                        </button>
                      );
                    })}
                </div>
              );
            })}

            {props.dynamicGroups?.[group.id] ? (
              props.dynamicGroups[group.id]!.items.length > 0 ? (
                <DynamicEntityRows
                  items={props.dynamicGroups[group.id]!.items}
                  collapsed={collapsed}
                  activeTarget={activeTarget}
                  onNavigate={onNavigate}
                />
              ) : !collapsed && props.dynamicGroups[group.id]!.emptyLabel ? (
                <div className="shell-rail__empty">{props.dynamicGroups[group.id]!.emptyLabel}</div>
              ) : null
            ) : null}
          </div>
        ))}
      </div>

      {/* The add-server affordance moved into the identity block's switcher
          (single-home ruling): adding a server is a context action, and it now
          lives beside the contexts it adds to. */}
      <button
        type="button"
        className="shell-rail__footer"
        onClick={props.onToggle}
        aria-label={collapsed ? 'Expand menu rail' : 'Collapse menu rail'}
        aria-expanded={!collapsed}
      >
        <span aria-hidden="true">{collapsed ? '⟩⟩' : '⟨⟨'}</span>
        {!collapsed && <span className="shell-rail__footer-label">collapse</span>}
        {!collapsed && <span className="shell-rail__footer-kbd">⌘\</span>}
      </button>
    </nav>
  );
}
