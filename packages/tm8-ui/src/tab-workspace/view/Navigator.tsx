/**
 * THE MERGED LEFT NAVIGATOR — the icon rail and the list column in ONE column
 * (design doc 01a1465d-a2b7 §3A "Sidebar", §4, §5, §7, §8, §9 phase 1, §10;
 * approved change list 01a14695-6b54; task 01a1469f-94a7).
 *
 *   ┌ ＋ New task              c │▾ ┐   NavNew
 *   │ PINNED ▾                     │   NavPins (rows, or one folded strip)
 *   │  💬 Chats            •    2  │
 *   │ ▌☑ Tasks                 11  │
 *   │  ⋯ All kinds           l ;   │   NavAllKinds
 *   │ ──────────────────────────── │
 *   │ {slot}  — the kind's list,   │   the lower area, which scrolls
 *   │          or a framed screen's│
 *   │          own panel (§9)      │
 *   │ ──────────────────────────── │
 *   │ 🔔 3                  M  ⫶   │   NavFooter
 *   └──────────────────────────────┘
 *
 * TOP = WHERE, BOTTOM = WHAT'S IN IT (§2). That split is what makes the merge
 * hold outside Work: the top never changes, and the lower area is whatever the
 * mode's list is — Work's kind tree, or `AppFrame`'s `panel` (§9).
 *
 * BEHIND `tm8.ui.navigator` (`navigatorFlag.ts`). With the flag OFF neither
 * `TabWorkspaceView` nor `AppFrame` mounts this file and the old rail + browser
 * render as today; nothing here runs. OFF is the default.
 *
 * NOTHING IS FORKED FROM THE RAIL. The kind rows, the hold-to-pin, the
 * tooltips, the scroll hints, the kind-press routing and the ⌘\ listener are
 * `railParts.tsx` — the same code the rail mounts, in a different arrangement
 * (`variant="nav"` is a class, not a second button). `RailAttention` and
 * `RailUser` are mounted as they are; the footer only lays them out in a row.
 *
 * DEFAULTS SUBHANG HAS NOT CONFIRMED, each one line to change and each called
 * out in the close-out report:
 *   - `PINS_START_FOLDED = false` — the pinned section starts OPEN (§12 Q1).
 *   - Needs you stays in the FOOTER (§12 Q2, the Oct 7 ruling).
 *   - `EXPAND_ON_COLLAPSED_PIN = true` — a pin pressed while collapsed expands
 *     the column on that kind rather than peeking a flyout (§12 Q3).
 *   - All kinds is `l ;`, NOT ⌘K: ⌘K is the command palette (§12 Q4, settled
 *     by the task). Every kind is already a palette row (`GateApp`
 *     `paletteViews` maps `allKinds()`), so kinds stay searchable there.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useStore } from 'zustand';
import { KindIcon, allKinds, homeRootKinds, type KindConfig } from '../../domain';
import { VectorIcon } from '../../kit/VectorIcon';
import { useAnchoredPopover } from '../../kit/anchoredPopover';
import { useDismissable } from '../../panels/useDismissable';
import { browserSources } from '../adapters/browserSources';
import { getKindAdapter } from '../adapters/registry';
import { getRailStore, workspacePinnedKinds } from '../runtime/railStore';
import { useCustomKindsVersion } from '../../data/custom-kinds';
import { useShellFrame } from './context';
import { RAIL_COLLAPSE_ART, RAIL_EXPAND_ART } from './railArt';
import { RailAttention, RailUser } from './RailStatus';
import {
  KindButton,
  RailTip,
  SourceButton,
  useCollapseKey,
  useOpenKind,
  useScrollHints,
  useTogglePin,
  type Pinnable,
} from './railParts';
import { isRailCountKind, useRailCounts, type RailCounts } from './useRailCounts';
import './navigator.css';

/** §12 Q1: open teaches the kinds, folded gives the list ~180px back. */
const PINS_START_FOLDED = false;
/** §12 Q3: a collapsed pin press expands the column on that kind. */
const EXPAND_ON_COLLAPSED_PIN = true;

/** ＋, on `VectorIcon`'s 16×16 grid, so it inherits the stroke weight. */
const PLUS_ART = ['M8 3.25v9.5', 'M3.25 8h9.5'];
/** The All-kinds ⋯ — three dots on the same grid. */
const MORE_ART = ['M4 8h.01', 'M8 8h.01', 'M12 8h.01'];

export interface NavigatorProps {
  /**
   * THE LOWER AREA (§9): the mode's own list. Work passes `<Browser/>`; a
   * framed screen passes its `panel` node. It scrolls inside itself — the
   * top and the footer never move.
   */
  slot: ReactNode;
  /**
   * WHAT COLLAPSED MEANS WHEN NOBODY HAS CHOSEN (`railStore.collapsed === null`).
   * Work passes false; Craft passes true, which is §9 phase 1 — the navigator
   * starts as the 48px strip and `CraftSidePanel` keeps its own column, so
   * Craft looks exactly as it does today. A ⌘\ anywhere writes a real boolean
   * and from then on the choice is the viewer's in every mode.
   */
  collapsedDefault?: boolean;
}

export function Navigator({ slot, collapsedDefault = false }: NavigatorProps) {
  const customKinds = useCustomKindsVersion();
  const { spaceId, currentKind, currentSource, selectSource, gate } = useShellFrame();
  const railStore = useMemo(() => getRailStore(spaceId), [spaceId]);
  const pins = useStore(railStore, (s) => s.pins);
  const storedCollapsed = useStore(railStore, (s) => s.collapsed);
  const storedFolded = useStore(railStore, (s) => s.pinsFolded);
  const collapsed = storedCollapsed ?? collapsedDefault;
  const folded = storedFolded ?? PINS_START_FOLDED;
  const [announcement, setAnnouncement] = useState('');
  const [allKindsOpen, setAllKindsOpen] = useState(false);
  const counts: RailCounts = useRailCounts();

  const navRef = useRef<HTMLElement>(null);
  const pinsRef = useRef<HTMLDivElement>(null);
  const pinned = useMemo(() => workspacePinnedKinds(pins), [pins, customKinds]);
  const pinnedSources = useMemo(() => browserSources().filter((source) => pins.includes(source.id)), [pins]);
  const more = useScrollHints(pinsRef, pinned.length);

  const openKind = useOpenKind();
  const togglePin = useTogglePin(navRef, setAnnouncement);
  const setCollapsed = useCallback(
    (next: boolean) => railStore.getState().setCollapsed(next),
    [railStore],
  );
  /* ⌘\ (§4, §7): it COLLAPSES the navigator now rather than widening the rail.
     The same listener the rail uses, so only one window handler ever exists. */
  useCollapseKey(useCallback(() => setCollapsed(!collapsed), [setCollapsed, collapsed]));
  useNavSlashSearch(navRef);

  /* A pin pressed while collapsed expands the column on that kind (§12 Q3). */
  const pressKind = useCallback(
    (kind: string) => {
      if (collapsed && EXPAND_ON_COLLAPSED_PIN) setCollapsed(false);
      openKind(kind);
    },
    [collapsed, setCollapsed, openKind],
  );

  /*
   * ↑/↓ MOVE BETWEEN PINS (§7). Focus only — the press is still Enter or
   * Space, which `useHold` owns. NOT a roving tabindex: every pin keeps its
   * place in the tab order, exactly as the rail's buttons do today, so this
   * adds a way to move and takes none away. (§7 also asks for the roving
   * variant, where Tab leaves the group in one press; that is not done and is
   * called out in the close-out.)
   */
  const onPinsArrow = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-kind], button[data-source]'));
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    event.preventDefault();
    rows[(at + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]?.focus();
  }, []);

  /*
   * `l ;` OPENS ALL KINDS. The keyboard controller emits `work.nav.kinds` and
   * `useWorkspaceKeys` clicks this button, as it does every other key — the
   * key path and the pointer path are the same control, never two handlers
   * that can disagree about what is open.
   */
  const allKindsBtn = useRef<HTMLButtonElement>(null);

  const kindRow = (config: KindConfig) => (
    <KindButton
      key={`pinned:${config.kind}`}
      config={config}
      placement="pinned"
      isPinned
      current={config.kind === currentKind}
      /* Collapsed or folded ⇒ icons only, which is what `expanded: false`
         already draws; the labelled row is the expanded one. */
      expanded={!collapsed && !folded}
      variant="nav"
      count={isRailCountKind(config.kind) ? counts[config.kind] : undefined}
      unseen={gate.data?.countsFor?.(config.kind)?.unseen}
      onSelect={pressKind}
      onTogglePin={togglePin}
    />
  );

  return (
    <nav
      ref={navRef}
      className="tws-nav tws-rail"
      aria-label="Navigator"
      data-testid="tws-nav"
      data-collapsed={collapsed || undefined}
      data-folded={folded || undefined}
    >
      <NavNew collapsed={collapsed} pinned={pinned} />

      <div className="tws-nav-where">
        {collapsed || folded ? null : (
          <button
            type="button"
            className="tws-nav-foldbtn"
            aria-expanded={!folded}
            aria-controls="tws-nav-pins"
            data-testid="tws-nav-fold"
            onClick={() => railStore.getState().setPinsFolded(true)}
          >
            <span className="tws-nav-eyebrow">Pinned</span>
            <span className="tws-nav-chevron" aria-hidden>
              ▾
            </span>
          </button>
        )}
        <div
          ref={pinsRef}
          id="tws-nav-pins"
          className="tws-nav-pins tws-rail-group"
          role="group"
          aria-label="Pinned"
          onKeyDown={onPinsArrow}
          data-testid="tws-nav-pins"
          data-more-above={more.above || undefined}
          data-more-below={more.below || undefined}
        >
          {pinned.map(kindRow)}
          {/*
            NON-ENTITY SOURCES (Project files) ONLY WHEN PINNED (§5): the rail
            gave them a section of their own under a hairline; here they are
            "a kind-like entry in All kinds" that can be pinned, so an unpinned
            one is not drawn. They keep the rail's own button, which already
            knows how to show one in the lower area.
          */}
          {pinnedSources.map((source) => (
            <SourceButton
              key={source.id}
              source={source}
              current={source.id === currentSource}
              expanded={!collapsed && !folded}
              variant="nav"
              onSelect={(id) => {
                if (collapsed && EXPAND_ON_COLLAPSED_PIN) setCollapsed(false);
                selectSource(id);
              }}
            />
          ))}
        </div>
        {/* FOLDED BACK OPEN: the strip's own control, so the fold is never a
            one-way door the eyebrow took away with it. */}
        {folded && !collapsed ? (
          <button
            type="button"
            className="tws-nav-unfold"
            aria-expanded={false}
            aria-controls="tws-nav-pins"
            aria-label="Show pinned labels"
            data-testid="tws-nav-unfold"
            onClick={() => railStore.getState().setPinsFolded(false)}
          >
            <span aria-hidden>▸</span>
          </button>
        ) : null}
        <NavAllKinds
          buttonRef={allKindsBtn}
          open={allKindsOpen}
          onOpenChange={setAllKindsOpen}
          collapsed={collapsed}
          folded={folded}
          pins={pins}
          onPick={(kind) => {
            if (collapsed && EXPAND_ON_COLLAPSED_PIN) setCollapsed(false);
            openKind(kind);
          }}
          onPickSource={(sourceId) => {
            if (collapsed && EXPAND_ON_COLLAPSED_PIN) setCollapsed(false);
            selectSource(sourceId);
          }}
          onTogglePin={togglePin}
        />
      </div>

      <hr className="tws-rail-rule tws-nav-rule" />

      {/* THE LOWER AREA. Hidden while collapsed: the 48px strip has no room
          for a list, and §4 says the strip is pins only. */}
      {collapsed ? null : (
        <div className="tws-nav-slot" data-testid="tws-nav-slot">
          {slot}
        </div>
      )}

      {/* The width resizer is the HOST's grid child, not ours: it is placed
          on the nav | content hairline by `grid-area`, which only a child of
          `.tws-root` can claim. */}
      <NavFooter collapsed={collapsed} onToggleCollapsed={() => setCollapsed(!collapsed)} />
      <span className="tws-sr-only" aria-live="polite" data-testid="tws-nav-live">
        {announcement}
      </span>
    </nav>
  );
}

/**
 * ＋ New (§5): `[＋ New {current kind}  c][▾]`, the FIRST thing in the column.
 * It replaces the list toolbar's `NewBox`, so the kind is chosen in ONE place
 * — the pins — and the ▾ is the door to every other creatable kind.
 *
 * A kind that cannot be created (Files, Commits, PRs, Worktrees) DIMS the
 * button with the registry's own reason in the tooltip rather than hiding it:
 * a verb that vanishes teaches the reader the feature does not exist.
 */
function NavNew({ collapsed, pinned }: { collapsed: boolean; pinned: readonly KindConfig[] }) {
  const { currentKind, createKind } = useShellFrame();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useDismissable(open, [wrap, menu], () => setOpen(false));

  /* Outside Work no kind is current (`currentKind === null`), so New names the
     first pin — the column's own top row — rather than a kind nothing on
     screen points at. */
  const kind = currentKind ?? pinned[0]?.kind ?? 'task';
  const adapter = getKindAdapter(kind);
  const disabledReason = adapter.creatable === true ? null : adapter.creatable.disabledReason;
  const noun = adapter.noun.toLowerCase();
  const label = `New ${noun}`;
  /* Every kind the registry can create, which is the ▾'s whole population. */
  const creatable = useMemo(
    () => allKinds().filter((config) => getKindAdapter(config.kind).creatable === true),
    [],
  );

  return (
    <div className="tws-nav-new" ref={wrap} role="group" aria-label="New" data-testid="tws-nav-new">
      <RailTip label={collapsed ? label : null} shortcut="c">
        <button
          type="button"
          className="tws-nav-new__main"
          aria-label={label}
          aria-disabled={disabledReason !== null || undefined}
          aria-keyshortcuts="c"
          title={disabledReason ?? label}
          data-testid="tws-nav-new-create"
          onClick={(event) => {
            if (disabledReason !== null) {
              event.preventDefault();
              return;
            }
            createKind(kind);
          }}
        >
          <span className="tws-nav-new__glyph" aria-hidden>
            <VectorIcon paths={PLUS_ART} size={16} strokeWidth={1.6} />
          </span>
          {collapsed ? null : (
            <>
              <span className="tws-nav-new__label">{label}</span>
              <kbd className="tws-nav-new__kbd" aria-hidden>
                c
              </kbd>
            </>
          )}
        </button>
      </RailTip>
      {collapsed ? null : (
        <button
          type="button"
          className="tws-nav-new__more"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="New — pick a kind"
          title="Pick a kind"
          data-testid="tws-nav-new-kinds"
          onClick={() => setOpen((value) => !value)}
        >
          <span aria-hidden>▾</span>
        </button>
      )}
      {open ? (
        <div ref={menu} className="tws-nav-menu" role="menu" aria-label="New" data-testid="tws-nav-new-menu">
          {creatable.map((config) => (
            <button
              key={config.kind}
              type="button"
              className="tws-nav-menu__row"
              role="menuitem"
              data-kind={config.kind}
              onClick={() => {
                setOpen(false);
                createKind(config.kind);
              }}
            >
              <KindIcon kind={config.kind} size={16} />
              <span>{config.label}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * ALL KINDS (§5): the last pin row, a popover grid of EVERY kind with a pin
 * toggle on each. It replaces the rail's long flat list of ~18 kinds and is
 * the visible way to pin — the 500ms hold stays as a shortcut for the people
 * who learned it, but it is no longer the only door.
 */
function NavAllKinds({
  buttonRef,
  open,
  onOpenChange,
  collapsed,
  folded,
  pins,
  onPick,
  onPickSource,
  onTogglePin,
}: {
  buttonRef: React.RefObject<HTMLButtonElement | null>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  collapsed: boolean;
  folded: boolean;
  pins: readonly string[];
  onPick: (kind: string) => void;
  onPickSource: (sourceId: string) => void;
  onTogglePin: (config: Pinnable) => boolean;
}) {
  const pop = useRef<HTMLDivElement>(null);
  useDismissable(open, [buttonRef, pop], () => onOpenChange(false));
  /* EVERY kind, the whole Home population — the same `homeRootKinds()` the
     rail's flat list drew, so nothing became unreachable in the merge — then
     the non-entity sources, which §5 makes kind-LIKE entries here. */
  const kinds = homeRootKinds();
  const sources = browserSources();
  const label = 'All kinds';
  /*
   * PLACED BESIDE THE COLUMN, CLAMPED TO THE VIEWPORT, by the same hook the
   * rail's Needs-you and account cards use. The first build opened it as a
   * plain absolutely-positioned box below the row: at 1440×900 the grid was
   * 605px tall from y=455 and ran ~160px off the bottom of the window, and it
   * covered the list it is a door to. jsdom cannot see either defect — both
   * were found in a screenshot, which is why this is a measured note and not
   * a style preference.
   */
  const style = useAnchoredPopover(
    open,
    () => {
      const rect = buttonRef.current?.getBoundingClientRect();
      if (!rect) return null;
      const column = buttonRef.current?.closest('.tws-nav')?.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, left: rect.left, right: column?.right ?? rect.right };
    },
    pop,
    { side: 'right', align: 'start', gap: 8 },
  );
  return (
    <div className="tws-nav-allkinds">
      <RailTip label={collapsed || folded ? label : null} shortcut="l ;">
        <button
          ref={buttonRef}
          type="button"
          className={`tws-rail-btn tws-rail-kind tws-nav-row tws-nav-allkinds__btn`}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={label}
          aria-keyshortcuts="l ;"
          data-testid="tws-nav-allkinds"
          onClick={() => onOpenChange(!open)}
        >
          <span className="tws-rail-icon">
            <VectorIcon paths={MORE_ART} size={16} strokeWidth={2} />
          </span>
          {collapsed || folded ? null : (
            <>
              <span className="tws-rail-label">{label}</span>
              <kbd className="tws-nav-new__kbd" aria-hidden>
                l ;
              </kbd>
            </>
          )}
        </button>
      </RailTip>
      {open ? (
        <div
          ref={pop}
          className="tws-nav-kindpop"
          role="dialog"
          aria-label={label}
          style={style}
          data-testid="tws-nav-allkinds-pop"
        >
          <div className="tws-nav-kindgrid">
            {kinds.map((config) => {
              const isPinned = pins.includes(config.kind);
              return (
                <div className="tws-nav-kindcell" key={config.kind}>
                  <button
                    type="button"
                    className="tws-nav-kindcell__open"
                    data-kind={config.kind}
                    onClick={() => {
                      onOpenChange(false);
                      onPick(config.kind);
                    }}
                  >
                    <KindIcon kind={config.kind} size={16} />
                    <span className="tws-nav-kindcell__name">{config.labelPlural}</span>
                  </button>
                  {/* THE VISIBLE PIN (§3A): a real toggle, not a 500ms hold
                      nobody discovers. It says which state it is in, so the
                      grid also reads as "what is on my column". */}
                  <button
                    type="button"
                    className="tws-nav-kindcell__pin"
                    aria-pressed={isPinned}
                    aria-label={`${isPinned ? 'Unpin' : 'Pin'} ${config.labelPlural}`}
                    data-pin={config.kind}
                    onClick={() => onTogglePin(config)}
                  >
                    <span aria-hidden>{isPinned ? '★' : '☆'}</span>
                  </button>
                </div>
              );
            })}
            {sources.map((source) => {
              const isPinned = pins.includes(source.id);
              return (
                <div className="tws-nav-kindcell" key={source.id}>
                  <button
                    type="button"
                    className="tws-nav-kindcell__open"
                    data-source={source.id}
                    onClick={() => {
                      onOpenChange(false);
                      onPickSource(source.id);
                    }}
                  >
                    <VectorIcon paths={source.art} size={16} />
                    <span className="tws-nav-kindcell__name">{source.label}</span>
                  </button>
                  <button
                    type="button"
                    className="tws-nav-kindcell__pin"
                    aria-pressed={isPinned}
                    aria-label={`${isPinned ? 'Unpin' : 'Pin'} ${source.label}`}
                    data-pin={source.id}
                    onClick={() => onTogglePin({ kind: source.id, labelPlural: source.label })}
                  >
                    <span aria-hidden>{isPinned ? '★' : '☆'}</span>
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The footer (§5): Needs you on the left, the account avatar and collapse on
 * the right. `RailAttention` and `RailUser` are the rail's own components,
 * mounted unchanged — Needs you stays where people learned it (Oct 7 ruling,
 * §12 Q2). Collapsed, the three stack as the rail's bottom group does.
 */
function NavFooter({
  collapsed,
  onToggleCollapsed,
}: {
  collapsed: boolean;
  onToggleCollapsed: () => void;
}) {
  const label = collapsed ? 'Expand navigator' : 'Collapse navigator';
  return (
    <div className="tws-nav-footer tws-rail-bottom" role="group" aria-label="Navigator controls">
      <RailAttention expanded={!collapsed} />
      <div className="tws-nav-footer__end">
        <RailUser expanded={false} />
        <RailTip label={label} shortcut="⌘\">
          <button
            type="button"
            className="tws-rail-btn tws-nav-collapse"
            aria-label={label}
            aria-keyshortcuts="Meta+\\"
            data-testid="tws-nav-collapse"
            onClick={onToggleCollapsed}
          >
            <span className="tws-rail-icon">
              <span className="tws-rail-disc" data-disc="expand">
                <VectorIcon paths={collapsed ? RAIL_EXPAND_ART : RAIL_COLLAPSE_ART} size={16} />
              </span>
            </span>
          </button>
        </RailTip>
      </div>
    </div>
  );
}

/**
 * `/` INSIDE THE NAVIGATOR, and why it is bound HERE rather than in the
 * keyboard contract.
 *
 * §7 asks for `/` to open the list's search. `keyboard/contract.ts` publishes
 * `/` as the command palette's GUARANTEED path (`palette.slash`) precisely
 * because ⌘K is browser-owned on Chrome Windows/Linux and on Firefox
 * everywhere, and its own comment rules out consuming `/` at the focus layer:
 * a focused list is the most common focus state in the app, so a focus-layer
 * `/` would leave the palette with no reachable binding on half the supported
 * matrix.
 *
 * So `/` is taken ONLY while focus is on a pin row or on All kinds — a
 * navigator-specific state that is never a focused list and never a text
 * field. The palette keeps `/` everywhere else, including in the list this
 * hook's search belongs to, and `f` (`list.search`) remains the guaranteed
 * path into that field from the list itself.
 */
export function useNavSlashSearch(root: { current: HTMLElement | null }): void {
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (!target?.closest('[data-testid="tws-nav-pins"], [data-testid="tws-nav-allkinds"]')) return;
      const search = el.querySelector<HTMLInputElement>('[data-testid="list-search"]');
      if (!search) return;
      event.preventDefault();
      event.stopPropagation();
      search.focus();
      search.select();
    };
    el.addEventListener('keydown', onKeyDown);
    return () => el.removeEventListener('keydown', onKeyDown);
  }, [root]);
}
