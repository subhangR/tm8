/**
 * Icon rail (Spec A §4, design log §3 + R36, task 01a1112a-c568).
 * Workstream A.
 *
 *   [Pinned kinds]  ── hairline
 *   [Work ▸] [Library ▸] [Agents & People ▸] [Code ▸]   (collapsible sections)
 *   ── hairline
 *   Needs you · Status  ⌘K · Design · Settings · Help  account · »
 *   (three clusters, 12px apart, no dividers — Design Advisor R39)
 *
 * THE SECTIONS ARE THE HOME RAIL'S POPULATION, NOT ITS COMPONENT:
 * `homeRailGroups()` restricted to the Workspace kinds (D7). Pins, open
 * sections and the expanded flag are the Workspace's own (`railStore`), never
 * Home's. A pinned kind ALSO stays in its section; both copies show current.
 *
 * A kind button IS the browser's kind control (click ⇒ `browsers.main.kind`);
 * a 500ms hold — pointer or Enter/Space — toggles its pin instead, and the
 * release that ends a hold never clicks.
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
import { KindIcon, VIEW_ART, homeRailGroups, homeRailPinnedKinds, type KindConfig } from '../../domain';
import { VectorIcon } from '../../kit/VectorIcon';
import { getRailStore } from '../runtime/railStore';
import { isWorkspaceKind } from '../runtime/types';
import { useWorkspace, useWorkspaceState } from './context';
import { RAIL_COLLAPSE_ART, RAIL_EXPAND_ART, RAIL_SECTION_ART } from './railArt';
import { RailAttention, RailStatus } from './RailStatus';

const BOTTOM_GROUP_IDS = ['craft', 'settings', 'help'] as const;
const BOTTOM_ART: Record<(typeof BOTTOM_GROUP_IDS)[number], readonly string[]> = {
  craft: VIEW_ART.craft,
  settings: VIEW_ART.settings,
  help: VIEW_ART.help,
};

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
  const { gate, dispatch, spaceId } = useWorkspace();
  const railStore = useMemo(() => getRailStore(spaceId), [spaceId]);
  const pins = useStore(railStore, (s) => s.pins);
  const openChoices = useStore(railStore, (s) => s.open);
  const expanded = useStore(railStore, (s) => s.expanded);
  const browserKind = useWorkspaceState((s) => s.browsers.main.kind);
  const [announcement, setAnnouncement] = useState('');

  const sections = useMemo(
    () =>
      homeRailGroups()
        .map((group) => ({ ...group, kinds: group.kinds.filter((config) => isWorkspaceKind(config.kind)) }))
        .filter((group) => group.kinds.length > 0),
    [],
  );
  const pinned = useMemo(() => homeRailPinnedKinds(pins).filter((config) => isWorkspaceKind(config.kind)), [pins]);
  const bottom = BOTTOM_GROUP_IDS.flatMap((id) => {
    const tab = gate.shellTabs.find((t) => t.id === id);
    return tab ? [{ id, label: tab.label }] : [];
  });

  const selectKind = useCallback(
    (kind: string) =>
      dispatch({ command: 'workspace.browser.set', args: { browserId: 'main', kind }, source: 'click' }),
    [dispatch],
  );
  const togglePin = useCallback(
    (config: KindConfig): boolean => {
      const nowPinned = railStore.getState().togglePin(config.kind);
      setAnnouncement(`${nowPinned ? 'Pinned' : 'Unpinned'} ${config.labelPlural}`);
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

  const kindButton = (config: KindConfig, placement: 'pinned' | 'section') => (
    <KindButton
      key={`${placement}:${config.kind}`}
      config={config}
      placement={placement}
      isPinned={placement === 'pinned' || pins.includes(config.kind)}
      current={config.kind === browserKind}
      expanded={expanded}
      onSelect={selectKind}
      onTogglePin={togglePin}
    />
  );

  const expandLabel = expanded ? 'Collapse sidebar' : 'Expand sidebar';
  return (
    <nav
      className="tws-rail"
      aria-label="Work rail"
      data-testid="tws-rail"
      data-rail-expanded={expanded || undefined}
    >
      <div className="tws-rail-top">
        {pinned.length > 0 ? (
          <>
            <div className="tws-rail-group" role="group" aria-label="Pinned" data-testid="tws-rail-pinned">
              {pinned.map((config) => kindButton(config, 'pinned'))}
            </div>
            <hr className="tws-rail-rule" />
          </>
        ) : null}
        {sections.map((section) => {
          const holdsCurrent = section.kinds.some((config) => config.kind === browserKind);
          const open = openChoices[section.id] ?? holdsCurrent;
          const bodyId = `tws-rail-section-${section.id}`;
          return (
            <div
              key={section.id}
              className="tws-rail-group"
              role="group"
              aria-label={section.label}
              data-section={section.id}
            >
              <RailTip label={expanded ? null : section.label}>
                <button
                  type="button"
                  className="tws-rail-btn tws-rail-section"
                  aria-label={section.label}
                  aria-expanded={open}
                  aria-controls={open ? bodyId : undefined}
                  /* A closed section holding the browser's kind keeps the bar,
                     so the selection is never invisible. */
                  aria-current={!open && holdsCurrent ? 'true' : undefined}
                  onClick={() => railStore.getState().setOpen(section.id, !open)}
                >
                  <span className="tws-rail-icon">
                    <VectorIcon paths={RAIL_SECTION_ART[section.id] ?? VIEW_ART.workspace} size={18} />
                  </span>
                  {expanded ? (
                    <span className="tws-rail-label">
                      <span className="tws-rail-chevron" aria-hidden>
                        {open ? '▾' : '▸'}
                      </span>
                      {section.label}
                    </span>
                  ) : null}
                </button>
              </RailTip>
              {open ? (
                <div id={bodyId} className="tws-rail-section-body">
                  {section.kinds.map((config) => kindButton(config, 'section'))}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      <hr className="tws-rail-rule" />
      <div className="tws-rail-bottom" role="group" aria-label="Work tools">
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
        {bottom.map((tab) => (
          <RailTip key={tab.id} label={expanded ? null : tab.label}>
            <button
              type="button"
              className="tws-rail-btn"
              aria-label={tab.label}
              data-rail-tool={tab.id}
              onClick={() => gate.onSelectViewTab(tab.id)}
            >
              <span className="tws-rail-icon">
                <VectorIcon paths={BOTTOM_ART[tab.id]} size={18} />
              </span>
              {expanded ? <span className="tws-rail-label">{tab.label}</span> : null}
            </button>
          </RailTip>
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
      <span className="tws-sr-only" aria-live="polite" data-testid="tws-rail-live">
        {announcement}
      </span>
    </nav>
  );
}

interface KindButtonProps {
  config: KindConfig;
  placement: 'pinned' | 'section';
  /** The Pinned copy always unpins; a section copy pins or unpins. */
  isPinned: boolean;
  current: boolean;
  expanded: boolean;
  onSelect(kind: string): void;
  onTogglePin(config: KindConfig): boolean;
}

function KindButton({ config, placement, isPinned, current, expanded, onSelect, onTogglePin }: KindButtonProps) {
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
  const tip = expanded ? verb.charAt(0).toUpperCase() + verb.slice(1) : `${config.labelPlural} · ${verb}`;
  return (
    <RailTip label={tip} flash={flash}>
      <button
        type="button"
        className="tws-rail-btn tws-rail-kind"
        aria-label={config.labelPlural}
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
        </span>
        {expanded ? <span className="tws-rail-label">{config.labelPlural}</span> : null}
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

  const place = () => {
    const rect = anchor.current?.getBoundingClientRect();
    return rect ? { left: rect.right + TIP_OFFSET_PX, top: rect.top + rect.height / 2 } : null;
  };
  useEffect(() => setFlashPos(flash ? place() : null), [flash]);

  const show = () => {
    if (!label) return;
    const warm = tipShownAt > tipHiddenAt || Date.now() - tipHiddenAt < TIP_WARM_MS;
    const open = () => {
      const next = place();
      if (!next) return;
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
    <div ref={anchor} className="tws-tip-anchor" onPointerEnter={show} onPointerLeave={hide} onFocus={show} onBlur={hide}>
      {children}
      {tip}
    </div>
  );
}
