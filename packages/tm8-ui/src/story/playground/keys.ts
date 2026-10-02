/**
 * The playground's keyboard: a focus trap for its two surfaces, and the
 * story-scoped ⌘K / Ctrl-K.
 *
 * ⌘K is the app's command palette (keyboard/contract.ts `palette.mod-k`,
 * installed by GateApp on window in the BUBBLE phase). The sheet takes the
 * chord only while the story page is the thing the user is in: focus is
 * inside the story root, or focus is on the body and the last pointerdown
 * landed inside it. Then a window CAPTURE listener opens the sheet and stops
 * the event, so the palette does not open as well. Anywhere else the chord is
 * left alone and the palette gets it exactly as before.
 */
import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The story root a playground node lives in (`data-story-root`, else its parent). */
export function storyRootOf(el: Element | null): Element | null {
  if (!el) return null;
  return el.closest('[data-story-root]') ?? el.parentElement;
}

/**
 * Bind ⌘K / Ctrl-K to `onOpen` while the story page is engaged. `enabled`
 * false (no `actions.add`) binds nothing — the palette keeps the chord.
 */
export function useStoryHotkey(host: RefObject<Element | null>, enabled: boolean, onOpen: () => void): void {
  const open = useRef(onOpen);
  open.current = onOpen;
  useEffect(() => {
    if (!enabled) return;
    let pointerInside = false;
    const onPointer = (ev: PointerEvent) => {
      const root = storyRootOf(host.current);
      pointerInside = !!root && ev.target instanceof Node && root.contains(ev.target);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (!(ev.metaKey || ev.ctrlKey) || ev.altKey || ev.shiftKey || ev.key.toLowerCase() !== 'k') return;
      const root = storyRootOf(host.current);
      if (!root) return;
      const active = document.activeElement;
      const engaged =
        active && active !== document.body ? root.contains(active) : pointerInside;
      if (!engaged) return;
      ev.preventDefault();
      ev.stopPropagation();
      open.current();
    };
    document.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [enabled, host]);
}

/**
 * Trap Tab inside `box` while it is mounted, close on Esc, and hand focus
 * back to whatever had it before the surface opened. Returns the box's
 * onKeyDown; Esc is stopped there so the app's own Esc (pop a panel) never
 * also fires.
 */
export function useFocusTrap(
  box: RefObject<HTMLElement | null>,
  onClose: () => void,
): (ev: ReactKeyboardEvent<HTMLElement>) => void {
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      // Only when focus was lost with the surface — never take it back from
      // whatever the user (or the sheet a popover handed over to) moved it to.
      const now = document.activeElement;
      if (before && before.isConnected && (!now || now === document.body)) before.focus();
    };
  }, []);
  return (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      onClose();
      return;
    }
    if (ev.key !== 'Tab' || !box.current) return;
    const items = Array.from(box.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    );
    if (!items.length) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (ev.shiftKey && document.activeElement === first) {
      ev.preventDefault();
      last.focus();
    } else if (!ev.shiftKey && document.activeElement === last) {
      ev.preventDefault();
      first.focus();
    }
  };
}

/** Enter submits, Shift+Enter is a newline; ⌘/Ctrl+Enter submits from anywhere in the surface. */
export function isSubmitKey(ev: ReactKeyboardEvent<HTMLElement>, inText: boolean): boolean {
  if (ev.key !== 'Enter' || ev.nativeEvent.isComposing) return false;
  if (ev.metaKey || ev.ctrlKey) return true;
  return inText && !ev.shiftKey && !ev.altKey;
}
