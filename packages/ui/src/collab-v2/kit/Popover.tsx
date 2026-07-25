/**
 * Popover engine — ONE shared popover instance for the whole module (the Z2
 * hover-preview contract). Consumers call usePopover().open(anchorEl, node)
 * on mouseenter and .cancel() on mouseleave; the engine handles the open
 * delay, the close grace period (so the pointer can travel into the popover),
 * and viewport-edge placement. No portals, no deps.
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from 'react';

const OPEN_DELAY_MS = 350;
const CLOSE_DELAY_MS = 200;
const VIEWPORT_PAD = 12;

interface PopoverState {
  content: ReactNode;
  anchorRect: DOMRect;
}

export interface PopoverController {
  /** Request the popover after the hover delay; re-anchors if already open. */
  open: (anchor: HTMLElement, content: ReactNode, opts?: { delayMs?: number }) => void;
  /** Cancel a pending open, or begin the close grace period if visible. */
  cancel: () => void;
  /** Close immediately (click-through, drag start, escape). */
  close: () => void;
  readonly isOpen: boolean;
}

const PopoverContext = createContext<PopoverController | null>(null);

export function usePopover(): PopoverController {
  const ctl = useContext(PopoverContext);
  if (!ctl) throw new Error('usePopover must be used inside <PopoverProvider>');
  return ctl;
}

export function PopoverProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PopoverState | null>(null);
  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  const clearTimers = useCallback(() => {
    if (openTimer.current) { clearTimeout(openTimer.current); openTimer.current = null; }
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
  }, []);

  const close = useCallback(() => { clearTimers(); setState(null); }, [clearTimers]);

  const open = useCallback((anchor: HTMLElement, content: ReactNode, opts?: { delayMs?: number }) => {
    clearTimers();
    const show = (): void => setState({ content, anchorRect: anchor.getBoundingClientRect() });
    const delay = opts?.delayMs ?? OPEN_DELAY_MS;
    if (delay <= 0) show();
    else openTimer.current = setTimeout(show, delay);
  }, [clearTimers]);

  const cancel = useCallback(() => {
    if (openTimer.current) { clearTimeout(openTimer.current); openTimer.current = null; }
    if (state) {
      if (closeTimer.current) clearTimeout(closeTimer.current);
      closeTimer.current = setTimeout(() => setState(null), CLOSE_DELAY_MS);
    }
  }, [state]);

  useEffect(() => () => clearTimers(), [clearTimers]);

  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, close]);

  const ctl = useMemo<PopoverController>(() => ({
    open, cancel, close, get isOpen() { return state != null; },
  }), [open, cancel, close, state]);

  let style: { left: number; top: number } | undefined;
  if (state) {
    const r = state.anchorRect;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = 300; // pre-measure estimate; clamped again after paint via CSS max-width
    let left = Math.min(Math.max(r.left, VIEWPORT_PAD), vw - width - VIEWPORT_PAD);
    let top = r.bottom + 6;
    if (top > vh - 160) top = Math.max(VIEWPORT_PAD, r.top - 6 - 160);
    style = { left, top };
  }

  return (
    <PopoverContext.Provider value={ctl}>
      {children}
      {state && (
        <div
          ref={popRef}
          className="cv2-popover"
          style={style}
          role="tooltip"
          onMouseEnter={() => { if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; } }}
          onMouseLeave={cancel}
        >
          {state.content}
        </div>
      )}
    </PopoverContext.Provider>
  );
}
