/**
 * Icon rail (Spec A §4, design log §3 + R36, task 01a1112a-c568).
 * Workstream A.
 *
 *   kinds face (default)            tools face (--pn-paper band)
 *   [Pinned kinds]  ── hairline      Needs you · Status
 *   [every kind, one flat list]      ⌘K · Inbox · Messages · Files · Git
 *                                    Design · Settings · Help
 *                                    account · »
 *   ── hairline                      ── hairline
 *   [⚙ Settings & tools]             [← Back to kinds]
 *
 * ONE SWITCH (Subhang, 2026-10-07): the bottom button swaps the column
 * between the two faces. The tools face keeps R39's three clusters, 12px
 * apart. Closed, the switch carries a dot while something needs you and the
 * current bar while the shell shows one of the tools.
 *
 * THE LIST IS THE HOME RAIL'S POPULATION, NOT ITS COMPONENT: `homeRootKinds()`
 * (the Home rail's groups, flattened in order) restricted to the Workspace
 * kinds (D7). NO GROUPS (task 01a11230): the Work / Library / Agents & People /
 * Code accordions are gone — every kind sits in one list, no headings, no
 * dividers. Pins and the expanded flag are the Workspace's own (`railStore`),
 * never Home's. A pinned kind moves up to Pinned and leaves the list; an
 * unpinned kind returns at the top of the list (`lifted`, newest first).
 *
 * A kind button IS the browser's kind control (click ⇒ `browsers.main.kind`);
 * a 500ms hold — pointer or Enter/Space — toggles its pin instead, and the
 * release that ends a hold never clicks.
 *
 * LIVE COUNTS (task 01a111a2-f9ad, design log R42) on four kinds only — Tasks,
 * Stories, Sessions, Chats (`useRailCounts`). Collapsed: a run-tinted corner
 * badge. Expanded: the number right-aligned in the row.
 */
import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { useStore } from 'zustand';
import { KindIcon, VIEW_ART, homeRailPinnedKinds, homeRootKinds, type KindConfig } from '../../domain';
import { VectorIcon } from '../../kit/VectorIcon';
import { getRailStore } from '../runtime/railStore';
import { isWorkspaceKind } from '../runtime/types';
import { useShellFrame } from './context';
import { railCountLabel, railKindLabel, isRailCountKind, useRailCounts, type RailCounts } from './useRailCounts';
import { RAIL_COLLAPSE_ART, RAIL_EXPAND_ART, RAIL_KINDS_ART } from './railArt';
import { useAttentionOptional } from '../../attention';
import { RailAttention, RailStatus } from './RailStatus';

const BOTTOM_GROUP_IDS = ['craft', 'settings', 'help'] as const;
const BOTTOM_ART: Record<(typeof BOTTOM_GROUP_IDS)[number], readonly string[]> = {
  craft: VIEW_ART.craft,
  settings: VIEW_ART.settings,
  help: VIEW_ART.help,
};

/**
 * THE SCREENS (Subhang, shell-alignment round 2): the desktop's other screens
 * live in the rail's bottom group, drawn while the rail is expanded. Their old
 * door, the top bar, is gone on the three-mode desktop.
 */
const SCREEN_VIEWS = [
  { ref: 'inbox', label: 'Inbox', art: VIEW_ART.inbox },
  { ref: 'messages', label: 'Messages', art: VIEW_ART.messages },
  { ref: 'files', label: 'Files', art: VIEW_ART.files },
  { ref: 'git', label: 'Git', art: VIEW_ART.git },
] as const;

/** How long a press must be held to toggle a pin, and how far it may drift. */
export const HOLD_MS = 500;
const HOLD_SLOP_PX = 6;
/** --pn-dur-fast hold + --pn-dur-fast fade after the ring completes (R36 §3). */
const RING_AFTER_MS = 240;
const FLASH_MS = 1200;

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

export function WorkspaceRail() {
  const { gate, spaceId, currentKind: browserKind, selectKind } = useShellFrame();
  const railStore = useMemo(() => getRailStore(spaceId), [spaceId]);
  const pins = useStore(railStore, (s) => s.pins);
  const lifted = useStore(railStore, (s) => s.lifted);
  const expanded = useStore(railStore, (s) => s.expanded);
  const [announcement, setAnnouncement] = useState('');
  /* Two faces (Subhang, 2026-10-07): the kinds by default; the bottom
     switch swaps in the settings and tools, on a darker band. */
  const [tools, setTools] = useState(false);
  const counts: RailCounts = useRailCounts();
  const attention = useAttentionOptional();
  const needsYou = attention && attention.status === 'ready' ? attention.counts().mine : 0;

  const pinned = useMemo(() => homeRailPinnedKinds(pins).filter((config) => isWorkspaceKind(config.kind)), [pins]);
  /* A pinned kind MOVES to Pinned and leaves the list; an unpinned one comes
     back at the TOP of the list, most recent first (Subhang, 2026-10-07). */
  const kinds = useMemo(() => {
    const rest = homeRootKinds().filter((config) => isWorkspaceKind(config.kind) && !pinned.some((p) => p.kind === config.kind));
    const rank = (kind: string) => {
      const i = lifted.indexOf(kind);
      return i < 0 ? lifted.length : i;
    };
    return rest.map((config, i) => ({ config, i })).sort((a, b) => rank(a.config.kind) - rank(b.config.kind) || a.i - b.i).map((x) => x.config);
  }, [pinned, lifted]);
  const railRef = useRef<HTMLElement>(null);
  const bottom = BOTTOM_GROUP_IDS.flatMap((id) => {
    const tab = gate.shellTabs.find((t) => t.id === id);
    return tab ? [{ id, label: tab.label }] : [];
  });

  const togglePin = useCallback(
    (config: KindConfig): boolean => {
      const rail = railRef.current;
      const hadFocus = !!rail && rail.contains(document.activeElement);
      const nowPinned = railStore.getState().togglePin(config.kind);
      setAnnouncement(`${nowPinned ? 'Pinned' : 'Unpinned'} ${config.labelPlural}`);
      /* The button moved sections and remounted: keyboard focus follows it. */
      if (hadFocus) {
        window.setTimeout(() => rail?.querySelector<HTMLElement>(`button[data-kind="${config.kind}"]`)?.focus(), 0);
      }
      return nowPinned;
    },
    [railStore],
  );
  const toggleExpanded = useCallback(() => railStore.getState().setExpanded(!railStore.getState().expanded), [railStore]);

  /* ⌘\ toggles the rail while the Workspace rail is mounted. Captured at the
     window so GateApp's own ⌘\ (the menu-rail flag, nothing drawn here) does
     not also fire. */
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== '\\' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      toggleExpanded();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [toggleExpanded]);

  const kindButton = (config: KindConfig, placement: 'pinned' | 'list') => (
    <KindButton
      key={`${placement}:${config.kind}`}
      config={config}
      placement={placement}
      isPinned={placement === 'pinned'}
      current={config.kind === browserKind}
      expanded={expanded}
      count={isRailCountKind(config.kind) ? counts[config.kind] : undefined}
      onSelect={selectKind}
      onTogglePin={togglePin}
    />
  );

  const expandLabel = expanded ? 'Collapse sidebar' : 'Expand sidebar';
  const screenCurrent = (ref: string) => gate.activeScreenRef === ref;
  const toolCurrent = (id: string) => gate.activeViewTabId === id || gate.activeScreenRef === id;
  const onToolScreen = SCREEN_VIEWS.some((s) => screenCurrent(s.ref)) || bottom.some((t) => toolCurrent(t.id));
  const switchLabel = tools ? 'Back to kinds' : 'Settings & tools';
  return (
    <nav
      ref={railRef}
      className="tws-rail"
      aria-label="Work rail"
      data-testid="tws-rail"
      data-rail-expanded={expanded || undefined}
      data-rail-mode={tools ? 'tools' : 'kinds'}
    >
      {tools ? (
        <div className="tws-rail-top tws-rail-tools" role="group" aria-label="Settings and tools" data-testid="tws-rail-tools">
          <div className="tws-rail-cluster" data-cluster="status">
            <RailAttention expanded={expanded} />
            <RailStatus expanded={expanded} />
          </div>
          <div className="tws-rail-cluster" data-cluster="tools">
            <RailTip label={expanded ? null : 'Command palette'} shortcut="⌘K">
              <button
                type="button"
                className="tws-rail-btn"
                aria-label="Command palette"
                aria-keyshortcuts="Meta+K"
                onClick={gate.openPalette}
              >
                <span className="tws-rail-icon">
                  <span className="tws-rail-kbd" aria-hidden>
                    ⌘K
                  </span>
                </span>
                {expanded ? <span className="tws-rail-label">Command palette</span> : null}
              </button>
            </RailTip>
            {SCREEN_VIEWS.map((screen) => (
              <ToolButton
                key={screen.ref}
                id={screen.ref}
                label={screen.label}
                art={screen.art}
                current={screenCurrent(screen.ref)}
                expanded={expanded}
                onClick={() => gate.navigateTo({ type: 'view', ref: screen.ref })}
              />
            ))}
            {bottom.map((tab) => (
              <ToolButton
                key={tab.id}
                id={tab.id}
                label={tab.label}
                art={BOTTOM_ART[tab.id]}
                current={toolCurrent(tab.id)}
                expanded={expanded}
                onClick={() => gate.onSelectViewTab(tab.id)}
              />
            ))}
          </div>
          <div className="tws-rail-cluster" data-cluster="account">
            {gate.accountSlot ? (
              <RailTip label={expanded ? null : 'Account'}>
                <div className="tws-rail-account">
                  {/* R12: the avatar-only trigger with its own accessible name;
                      the expanded rail adds the name beside it. */}
                  {isValidElement<{ compact?: boolean; compactName?: boolean }>(gate.accountSlot)
                    ? cloneElement(gate.accountSlot, { compact: true, compactName: expanded })
                    : gate.accountSlot}
                </div>
              </RailTip>
            ) : null}
            <RailTip label={expanded ? null : expandLabel} shortcut="⌘\">
              <button
                type="button"
                className="tws-rail-btn tws-rail-expand"
                aria-label={expandLabel}
                aria-keyshortcuts="Meta+\"
                data-testid="tws-rail-expand"
                onClick={toggleExpanded}
              >
                <span className="tws-rail-icon">
                  <VectorIcon paths={expanded ? RAIL_COLLAPSE_ART : RAIL_EXPAND_ART} size={18} />
                </span>
                {expanded ? <span className="tws-rail-label">{expandLabel}</span> : null}
              </button>
            </RailTip>
          </div>
        </div>
      ) : (
        <div className="tws-rail-top">
          {pinned.length > 0 ? (
            <>
              <div className="tws-rail-group" role="group" aria-label="Pinned" data-testid="tws-rail-pinned">
                {pinned.map((config) => kindButton(config, 'pinned'))}
              </div>
              <hr className="tws-rail-rule" />
            </>
          ) : null}
          <div className="tws-rail-group" role="group" aria-label="Kinds" data-testid="tws-rail-kinds">
            {kinds.map((config) => kindButton(config, 'list'))}
          </div>
        </div>
      )}
      <hr className="tws-rail-rule" />
      <div className="tws-rail-bottom">
        <RailTip label={expanded ? null : switchLabel}>
          <button
            type="button"
            className="tws-rail-btn tws-rail-switch"
            aria-label={switchLabel}
            aria-pressed={tools}
            aria-current={!tools && onToolScreen ? 'page' : undefined}
            data-testid="tws-rail-switch"
            onClick={() => setTools((t) => !t)}
          >
            <span className="tws-rail-icon">
              <VectorIcon paths={tools ? RAIL_KINDS_ART : VIEW_ART.settings} size={18} />
              {!tools && needsYou > 0 ? <span className="tws-rail-switch-dot" data-testid="tws-rail-switch-dot" aria-hidden /> : null}
            </span>
            {expanded ? <span className="tws-rail-label">{switchLabel}</span> : null}
          </button>
        </RailTip>
      </div>
      <span className="tws-sr-only" aria-live="polite" data-testid="tws-rail-live">
        {announcement}
      </span>
    </nav>
  );
}

/** A screen or shell tab in the tools rail: current while the shell shows it. */
function ToolButton({
  id,
  label,
  art,
  current,
  expanded,
  onClick,
}: {
  id: string;
  label: string;
  art: readonly string[];
  current: boolean;
  expanded: boolean;
  onClick(): void;
}) {
  return (
    <RailTip label={expanded ? null : label}>
      <button
        type="button"
        className="tws-rail-btn"
        aria-label={label}
        aria-current={current ? 'page' : undefined}
        data-rail-tool={id}
        onClick={onClick}
      >
        <span className="tws-rail-icon">
          <VectorIcon paths={art} size={18} />
        </span>
        {expanded ? <span className="tws-rail-label">{label}</span> : null}
      </button>
    </RailTip>
  );
}

interface KindButtonProps {
  config: KindConfig;
  placement: 'pinned' | 'list';
  /** The Pinned copy unpins; a list copy pins. */
  isPinned: boolean;
  current: boolean;
  expanded: boolean;
  /** The live count (R42); undefined on every kind but the four. */
  count: number | undefined;
  onSelect(kind: string): void;
  onTogglePin(config: KindConfig): boolean;
}

function KindButton({ config, placement, isPinned, current, expanded, count, onSelect, onTogglePin }: KindButtonProps) {
  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (flashTimer.current) window.clearTimeout(flashTimer.current);
  }, []);
  const hold = useHold(
    () => {
      const nowPinned = onTogglePin(config);
      /* Reduced motion draws no ring; the tooltip says what happened. */
      if (prefersReducedMotion()) {
        setFlash(nowPinned ? 'Pinned' : 'Unpinned');
        if (flashTimer.current) window.clearTimeout(flashTimer.current);
        flashTimer.current = window.setTimeout(() => setFlash(null), FLASH_MS);
      }
    },
    () => onSelect(config.kind),
  );
  const verb = isPinned ? 'hold to unpin' : 'hold to pin';
  /* Expanded rails suppress tooltips except the hold hint. */
  const label = railKindLabel(config.kind, config.labelPlural, count);
  const shown = railCountLabel(count);
  const tip = expanded ? verb.charAt(0).toUpperCase() + verb.slice(1) : `${label} · ${verb}`;
  return (
    <RailTip label={tip} flash={flash}>
      <button
        type="button"
        className="tws-rail-btn tws-rail-kind"
        aria-label={label}
        aria-description={verb}
        aria-current={current ? 'true' : undefined}
        data-kind={config.kind}
        data-placement={placement}
        data-hold={hold.phase === 'idle' ? undefined : hold.phase}
        {...hold.handlers}
      >
        <span className="tws-rail-icon">
          <KindIcon kind={config.kind} size={18} />
          <svg className="tws-hold-ring" viewBox="0 0 42 42" aria-hidden focusable="false">
            {/* A rounded rect 2px outside the 36×36 box, radius --pn-r-sm + 2,
                starting at the top centre and running clockwise. */}
            <path
              d="M21 1H32A9 9 0 0 1 41 10V32A9 9 0 0 1 32 41H10A9 9 0 0 1 1 32V10A9 9 0 0 1 10 1Z"
              pathLength={100}
            />
          </svg>
          {shown && !expanded ? (
            <span className="tws-rail-count-badge" data-testid="tws-rail-count" aria-hidden>
              {shown}
            </span>
          ) : null}
        </span>
        {expanded ? <span className="tws-rail-label">{config.labelPlural}</span> : null}
        {shown && expanded ? (
          <span className="tws-rail-count" data-testid="tws-rail-count" aria-hidden>
            {shown}
          </span>
        ) : null}
      </button>
    </RailTip>
  );
}

type HoldPhase = 'idle' | 'holding' | 'done';

/**
 * Press-and-hold: `onHold` after HOLD_MS, otherwise `onClick` on release. The
 * release (or key-up) that ends a completed hold is swallowed. A pointer that
 * drifts past HOLD_SLOP_PX or leaves the button cancels.
 */
export function useHold(onHold: () => void, onClick: () => void) {
  const [phase, setPhase] = useState<HoldPhase>('idle');
  const holdRef = useRef(onHold);
  const clickRef = useRef(onClick);
  holdRef.current = onHold;
  clickRef.current = onClick;
  const timer = useRef<number | null>(null);
  const after = useRef<number | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const fired = useRef(false);
  const keyDown = useRef(false);

  const clearTimers = () => {
    if (timer.current) window.clearTimeout(timer.current);
    if (after.current) window.clearTimeout(after.current);
    timer.current = null;
    after.current = null;
  };
  useEffect(() => clearTimers, []);

  const start = () => {
    clearTimers();
    fired.current = false;
    setPhase('holding');
    timer.current = window.setTimeout(() => {
      timer.current = null;
      fired.current = true;
      setPhase('done');
      holdRef.current();
      after.current = window.setTimeout(() => setPhase('idle'), RING_AFTER_MS);
    }, HOLD_MS);
  };
  /* An early release removes the ring at once (no reverse animation). */
  const cancel = () => {
    if (!timer.current) return;
    clearTimers();
    setPhase('idle');
  };

  const handlers = {
    onPointerDown(event: PointerEvent<HTMLButtonElement>) {
      if (event.button > 0) return;
      origin.current = { x: event.clientX ?? 0, y: event.clientY ?? 0 };
      start();
    },
    onPointerMove(event: PointerEvent<HTMLButtonElement>) {
      if (!origin.current || !timer.current) return;
      const dx = (event.clientX ?? 0) - origin.current.x;
      const dy = (event.clientY ?? 0) - origin.current.y;
      if (Math.hypot(dx, dy) > HOLD_SLOP_PX) cancel();
    },
    onPointerUp() {
      origin.current = null;
      cancel();
    },
    onPointerLeave() {
      origin.current = null;
      cancel();
    },
    onPointerCancel() {
      origin.current = null;
      cancel();
    },
    onContextMenu(event: MouseEvent<HTMLButtonElement>) {
      /* Hold only: a touch long-press must not open the platform menu. */
      if (timer.current || fired.current) event.preventDefault();
    },
    onClick(event: MouseEvent<HTMLButtonElement>) {
      if (fired.current) {
        fired.current = false;
        event.preventDefault();
        return;
      }
      clickRef.current();
    },
    /* Enter clicks on key-down and Space on key-up natively; both are taken
       over so a held key can pin without also clicking. */
    onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      if (event.repeat || keyDown.current) return;
      keyDown.current = true;
      start();
    },
    onKeyUp(event: KeyboardEvent<HTMLButtonElement>) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      if (!keyDown.current) return;
      keyDown.current = false;
      if (fired.current) {
        fired.current = false;
        return;
      }
      cancel();
      clickRef.current();
    },
    onBlur() {
      keyDown.current = false;
      cancel();
    },
  };
  return { phase, handlers };
}

/* TOOLTIPS (design log §3): to the right with an 8px offset, after 400ms —
   immediately while another tip is showing or has just hidden. Fixed
   position, so the top group's own scroll cannot clip them. A null label
   draws none (the expanded rail); a `flash` shows at once. */
const TIP_DELAY_MS = 400;
const TIP_WARM_MS = 300;
const TIP_OFFSET_PX = 8;
let tipShownAt = 0;
let tipHiddenAt = 0;
/* One tip at a time: a layout change under a still pointer (expand/collapse)
   can skip the old anchor's pointer-leave, so opening a tip closes the last. */
let closeOpenTip: (() => void) | null = null;

function RailTip({
  label,
  shortcut,
  flash = null,
  children,
}: {
  label: string | null;
  shortcut?: string;
  flash?: string | null;
  children: ReactElement;
}) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [flashPos, setFlashPos] = useState<{ left: number; top: number } | null>(null);
  const timer = useRef<number | null>(null);
  const anchor = useRef<HTMLDivElement>(null);
  const closeSelf = useRef(() => setPos(null));

  const place = () => {
    const rect = anchor.current?.getBoundingClientRect();
    return rect ? { left: rect.right + TIP_OFFSET_PX, top: rect.top + rect.height / 2 } : null;
  };
  useEffect(() => setFlashPos(flash ? place() : null), [flash]);
  /* A label that goes away (the rail expanded) takes its open tip with it. */
  useEffect(() => {
    if (!label) setPos(null);
  }, [label]);
  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
      if (closeOpenTip === closeSelf.current) closeOpenTip = null;
    },
    [],
  );

  const show = () => {
    if (!label) return;
    const warm = tipShownAt > tipHiddenAt || Date.now() - tipHiddenAt < TIP_WARM_MS;
    const open = () => {
      const next = place();
      if (!next) return;
      if (closeOpenTip && closeOpenTip !== closeSelf.current) closeOpenTip();
      closeOpenTip = closeSelf.current;
      tipShownAt = Date.now();
      setPos(next);
    };
    if (timer.current) window.clearTimeout(timer.current);
    if (warm) open();
    else timer.current = window.setTimeout(open, TIP_DELAY_MS);
  };
  const hide = () => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    if (pos) tipHiddenAt = Date.now();
    if (closeOpenTip === closeSelf.current) closeOpenTip = null;
    setPos(null);
  };

  const at = flash ? flashPos : label ? pos : null;
  let tip: ReactNode = null;
  if (at) {
    tip = (
      <span className="tws-tip" role="tooltip" style={{ left: at.left, top: at.top }}>
        {flash ?? label}
        {!flash && shortcut ? <span className="tws-tip-kbd">{shortcut}</span> : null}
      </span>
    );
  }
  return (
    <div
      ref={anchor}
      className="tws-tip-anchor"
      onPointerEnter={show}
      onPointerLeave={hide}
      onPointerDown={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {tip}
    </div>
  );
}
