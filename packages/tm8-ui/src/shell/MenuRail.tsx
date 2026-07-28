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
 * Width is DISCRETE — M ∈ {48, 220}, never a continuum (02-LAYOUT §1, WLT §6).
 * Collapsed renders icons only, which is why every view and kind ref must carry
 * a glyph; a ref that cannot be presented fails the config closed rather than
 * rendering a blank 48px row.
 *
 * Provenance: row grammar + measurements from the T1-1 "Menu rail grammar"
 * canvas (the dedicated rail frame); the unified server rows and the two
 * footers from T0-1. Colors always resolve through tokens (D5).
 */
import { useState } from 'react';
import type { MenuConfig, MenuItem, MenuLeaf, MenuViewRef } from '@tm8/contract';
import { REASONS } from '../domain';
import { VIEW_PRESENTATION } from './menu-resolve';
import { MENU_COLLAPSED, MENU_EXPANDED } from './geometry';

/** What a menu ref needs in order to be drawn. */
export interface RefPresentation {
  label: string;
  icon: string;
  /** Optional trailing count, e.g. Tasks `18`. */
  badge?: string | number;
  /** Optional live count — renders as the green `● n` treatment. */
  live?: number;
}

/**
 * Kind refs resolve through the DOMAIN REGISTRY, injected. Shell never maps a
 * kind literal itself: §15.2 makes that a build failure, and the registry is
 * the single behavior authority for all kinds (§10.2.3).
 */
export type KindPresenter = (ref: string) => RefPresentation | null;

export type MenuTarget = { type: 'view'; ref: MenuViewRef } | { type: 'kind'; ref: string };

export interface MenuRailProps {
  config: MenuConfig;
  /** Discrete by law. */
  collapsed: boolean;
  onToggle(): void;
  /** Which row reads as current. */
  activeTarget?: MenuTarget | null;
  onNavigate(target: MenuTarget): void;
  presentKind: KindPresenter;
  /**
   * R10 / RULING B: Phase 1 wires ONLY the implicit local server. The rail is
   * built per the T0-1 unified design, but the add-server affordance renders
   * DISABLED-WITH-REASON — never hidden, never faked (L6).
   */
  addServerReason?: string;
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

/** Resolves an item/leaf to its presentation, or null when it cannot be drawn. */
function present(node: MenuItem | MenuLeaf, presentKind: KindPresenter): RefPresentation | null {
  return node.type === 'view' ? VIEW_PRESENTATION[node.ref] ?? null : presentKind(node.ref);
}

/**
 * The COLLAPSED row's accessible name, composed from every part the row shows.
 *
 * An `aria-label` on a button REPLACES the accessible name computed from its
 * contents — so the moment the collapsed row carried one, every corner mark
 * inside it became invisible to assistive tech no matter what it rendered.
 * That is why the label is built from the parts rather than set to the bare
 * kind name (D31).
 *
 * The asymmetry is deliberate and follows C8/L10: `live` is a STATUS, so it
 * needs the WORD — "3 live", never a naked "3". `badge` is a QUANTITY, which is
 * complete on its own.
 */
function collapsedLabel(presentation: RefPresentation): string {
  const parts = [presentation.label];
  if (presentation.badge !== undefined) parts.push(String(presentation.badge));
  if (presentation.live !== undefined) parts.push(`${presentation.live} live`);
  return parts.join(', ');
}

export function MenuRail(props: MenuRailProps) {
  const { config, collapsed, activeTarget, onNavigate, presentKind } = props;
  // Which caret rows are open. The default follows the canvas: the shipped
  // Workspace row ships expanded.
  const [openRows, setOpenRows] = useState<Record<string, boolean>>({ workspace: true });

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
        {config.groups.map((group) => (
          <div key={group.id} className="shell-rail__group">
            {/* GRAMMAR 1 — group header. A label, and nothing else: not a
                button, not focusable, no click target (LLD §4.1). Collapsed,
                it degrades to the hairline divider the canvas draws. */}
            {collapsed ? (
              <div className="shell-rail__divider" role="separator" aria-label={group.label} />
            ) : (
              <div className="shell-rail__header kit-eyebrow">{group.label}</div>
            )}

            {group.items.map((item) => {
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
                    title={collapsed ? collapsedLabel(presentation) : undefined}
                    onClick={() => onNavigate(target)}
                  >
                    <span className="shell-rail__icon" aria-hidden="true">
                      {presentation.icon}
                    </span>
                    {!collapsed && <span className="shell-rail__label">{presentation.label}</span>}
                    {!collapsed && presentation.live !== undefined && (
                      <span className="shell-rail__live">
                        <span className="shell-rail__live-dot" aria-hidden="true" />
                        {presentation.live}
                        {/* The colour says "live"; C8/L10 requires the word too. */}
                        <span className="shell-vh"> live</span>
                      </span>
                    )}
                    {!collapsed && presentation.badge !== undefined && (
                      <span className="shell-rail__badge">{presentation.badge}</span>
                    )}
                    {/* Collapsed, counts survive as corner marks — the count is
                        information, so it degrades rather than disappearing.
                        Both marks are aria-hidden because the row's composed
                        aria-label already carries their values; leaving them
                        exposed would double-announce every count. */}
                    {collapsed && presentation.badge !== undefined && (
                      <span className="shell-rail__badge-corner" aria-hidden="true">
                        {presentation.badge}
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
                      groups (RULING E). Never rendered collapsed — a 48px rail
                      has no room to say what a leaf is. */}
                  {!collapsed &&
                    open &&
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
                          onClick={() => onNavigate(leafTarget)}
                        >
                          <span className="shell-rail__guide" aria-hidden="true" />
                          <span className="shell-rail__label">{leafPresentation.label}</span>
                          {leafPresentation.live !== undefined && (
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
                          {leafPresentation.badge !== undefined && (
                            <span className="shell-rail__badge">{leafPresentation.badge}</span>
                          )}
                        </button>
                      );
                    })}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* L6: the affordance is REAL and visibly refused, with the reason on it.
          A ghost may never advertise an action the facade cannot perform. */}
      {/* D28: aria-disabled and FOCUSABLE, never natively `disabled` — a native
          disabled control leaves the tab order, so a keyboard or screen-reader
          user can never reach it to learn WHY it is unavailable. That would make
          the reason unreachable to exactly the people L6 exists to serve. */}
      <button
        type="button"
        className="shell-rail__footer shell-rail__footer--disabled"
        aria-disabled="true"
        onClick={(event) => event.preventDefault()}
        // The reason rides the accessible name and the tooltip, NOT inline
        // text: a full sentence printed into a 220px rail wrapped to three
        // lines and collided with its own label (caught in the browser — jsdom
        // has no layout engine and reported this as passing). Same floor-
        // inversion class as D34: long copy in a fixed slot destroys the slot.
        aria-label={`Add server — ${props.addServerReason ?? ADD_SERVER_DISABLED_REASON}`}
        title={props.addServerReason ?? ADD_SERVER_DISABLED_REASON}
      >
        <span aria-hidden="true">＋</span>
        {!collapsed && <span className="shell-rail__footer-label">add server</span>}
      </button>

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
