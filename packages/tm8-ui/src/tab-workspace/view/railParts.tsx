/**
 * THE LEFT COLUMN'S SHARED PARTS — moved here, NOT FORKED, when the merged
 * navigator (`Navigator.tsx`, flag `tm8.ui.navigator`) grew a second column
 * that draws the same kind rows the icon rail draws.
 *
 * Both columns mount the SAME `KindButton`, `useHold`, `RailTip`,
 * `useScrollHints`, `SourceButton`, `useOpenKind`, `useTogglePin` and
 * `useCollapseKey`. A copy of any of them would be two surfaces that answer
 * "what does a hold do", "where does a kind press land" and "what does ⌘\ do"
 * independently — and the flag's whole promise is that the two states differ
 * in LAYOUT and in nothing else.
 *
 * `WorkspaceRail.tsx` keeps the rail's own arrangement (Pinned → hairline →
 * every kind → sources → the three) and the reasoning for it; this file holds
 * only what both arrangements are built from.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { KindIcon, type KindConfig } from '../../domain';
import { CRAFT_KIND } from '../../domain/craft';
import { VectorIcon } from '../../kit/VectorIcon';
import type { BrowserSource } from '../adapters/browserSources';
import { getRailStore } from '../runtime/railStore';
import { isWorkspaceKind } from '../runtime/types';
import { useShellFrame } from './context';
import { railCountLabel, railKindLabel } from './useRailCounts';

/** How long a press must be held to toggle a pin, and how far it may drift. */
export const HOLD_MS = 500;
const HOLD_SLOP_PX = 6;
/** --pn-dur-fast hold + --pn-dur-fast fade after the ring completes (R36 §3). */
const RING_AFTER_MS = 240;
const FLASH_MS = 1200;

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/**
 * A KIND PRESS FROM ANY MODE OPENS WORK WITH THAT KIND'S LIST (Craft redesign
 * §2). A kind Work's browser holds (the contract's allow-list) opens there;
 * any other opens its own kind list, which the shell counts as Work, until the
 * allow-list widens — read from the contract, so widening it needs no change
 * here. The craft kind is the one exception: it opens Craft mode.
 */
export function useOpenKind(): (kind: string) => void {
  const { gate, selectKind } = useShellFrame();
  return useCallback(
    (kind: string) => {
      if (kind === CRAFT_KIND) gate.navigateView({ view: 'craft' });
      else if (isWorkspaceKind(kind)) selectKind(kind);
      else gate.navigateTo({ type: 'kind', ref: kind });
    },
    [selectKind, gate],
  );
}

/**
 * ANYTHING THE COLUMN CAN PIN. A kind is the usual one; a non-entity browser
 * source (Project files) is pinned the same way and by the same store, because
 * §5 makes it "a kind-like entry in All kinds" rather than a section of its
 * own. `KindConfig` already satisfies this shape, so nothing had to change at
 * the kind call sites.
 */
export interface Pinnable {
  kind: string;
  labelPlural: string;
}

/**
 * Toggle a pin and say so out loud. The button moved sections and remounted,
 * so keyboard focus is put back on it inside `root`.
 */
export function useTogglePin(
  root: { current: HTMLElement | null },
  announce: (text: string) => void,
): (config: Pinnable) => boolean {
  const { spaceId } = useShellFrame();
  return useCallback(
    (config: Pinnable): boolean => {
      const el = root.current;
      const hadFocus = !!el && el.contains(document.activeElement);
      const nowPinned = getRailStore(spaceId).getState().togglePin(config.kind);
      announce(`${nowPinned ? 'Pinned' : 'Unpinned'} ${config.labelPlural}`);
      if (hadFocus) {
        window.setTimeout(() => el?.querySelector<HTMLElement>(`button[data-kind="${config.kind}"]`)?.focus(), 0);
      }
      return nowPinned;
    },
    [root, spaceId, announce],
  );
}

/**
 * ⌘\, captured at the window so GateApp's own ⌘\ (the menu-rail flag,
 * nothing drawn here) does not also fire. The rail widens to labels with it;
 * the navigator collapses to the 48px strip (§4, §7).
 */
export function useCollapseKey(toggle: () => void): void {
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== '\\' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
      event.preventDefault();
      event.stopPropagation();
      toggle();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [toggle]);
}

/**
 * OVERFLOW HINTS (Subhang, 2026-10-07): the top group scrolls inside itself
 * with no scrollbar, so it says when there is more above or below — the CSS
 * fades that edge. Re-measured on scroll, resize and when Pinned appears.
 */
export function useScrollHints(ref: { current: HTMLElement | null }, layout: unknown): { above: boolean; below: boolean } {
  const [hints, setHints] = useState({ above: false, below: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const above = el.scrollTop > 1;
      const below = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
      setHints((h) => (h.above === above && h.below === below ? h : { above, below }));
    };
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(el);
    for (const child of Array.from(el.children)) observer?.observe(child);
    return () => {
      el.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, [ref, layout]);
  return hints;
}

/** A non-entity browser source: a click shows it in the browser column. */
export function SourceButton({
  source,
  current,
  expanded,
  variant = 'rail',
  onSelect,
}: {
  source: BrowserSource;
  current: boolean;
  expanded: boolean;
  variant?: 'rail' | 'nav';
  onSelect(sourceId: string): void;
}) {
  return (
    <RailTip label={expanded ? null : source.label}>
      <button
        type="button"
        className={`tws-rail-btn tws-rail-kind${variant === 'nav' ? ' tws-nav-row' : ''}`}
        aria-label={source.label}
        aria-current={current ? 'true' : undefined}
        data-source={source.id}
        onClick={() => onSelect(source.id)}
      >
        <span className="tws-rail-icon">
          <VectorIcon paths={source.art} size={18} />
        </span>
        {expanded ? <span className="tws-rail-label">{source.label}</span> : null}
      </button>
    </RailTip>
  );
}

export interface KindButtonProps {
  config: KindConfig;
  placement: 'pinned' | 'list';
  /** The Pinned copy unpins; a list copy pins. */
  isPinned: boolean;
  current: boolean;
  expanded: boolean;
  /**
   * WHICH COLUMN IS DRAWING IT. `rail` is the 36px icon button; `nav` is the
   * navigator's 30px labelled row (§3A). Only a class differs — the hold, the
   * counts, the tooltip and the press are the same button in both, which is
   * why this is a variant and not a second component.
   */
  variant?: 'rail' | 'nav';
  /** The live count (R42); undefined on every kind but the four. */
  count: number | undefined;
  unseen: number | undefined;
  onSelect(kind: string): void;
  onTogglePin(config: KindConfig): boolean;
}

export function KindButton({ config, placement, isPinned, current, expanded, variant = 'rail', count, unseen, onSelect, onTogglePin }: KindButtonProps) {
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
  /* Tooltips and accessible labels carry the full unseen count at either width. */
  const activityLabel = railKindLabel(config.kind, config.labelPlural, count);
  const unseenShown = railCountLabel(unseen);
  const label = unseenShown ? `${activityLabel} · ${unseen} unseen` : activityLabel;
  const shown = railCountLabel(count);
  const tip = `${label} · ${verb}`;
  return (
    <RailTip label={tip} flash={flash}>
      <button
        type="button"
        className={`tws-rail-btn tws-rail-kind${variant === 'nav' ? ' tws-nav-row' : ''}`}
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
          {unseenShown ? (
            <sup className="tws-rail-unseen-badge" data-testid="tws-rail-unseen" aria-hidden>
              {unseenShown}
            </sup>
          ) : null}
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

export function RailTip({
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
