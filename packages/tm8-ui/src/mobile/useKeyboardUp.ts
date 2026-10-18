import { useEffect, useState } from 'react';

/**
 * IS THE SOFT KEYBOARD UP: the boolean behind `data-keyboard="up"` (task t-safe).
 *
 * ── WHY THE INSET ALONE CANNOT ANSWER IT ─────────────────────────────────
 *
 * `useKeyboardInset` measures what the keyboard OVERLAYS, so it is only
 * non-zero where the keyboard overlays, and that means iOS. `index.html` declares
 * `interactive-widget=resizes-content` (audit A4), so on Android the keyboard
 * RESIZES the layout viewport: `innerHeight` and `visualViewport.height` shrink
 * together and the inset stays 0. Keyed off the inset alone, the dock would
 * keep its home-indicator padding above the keys and the hero would never
 * collapse on Android, which is where the room is scarcest.
 *
 * ── THE SECOND SIGNAL ────────────────────────────────────────────────────
 *
 * The layout viewport has shrunk well below the tallest it has been at this
 * width, AND a text field has focus. Each half on its own is wrong:
 *
 * - Height alone also fires on a split-screen or freeform-window resize.
 * - Focus alone stays true after Android's Back closes the keyboard and leaves
 *   the field focused.
 *
 * The URL bar moves `innerHeight` by about 56px. A keyboard takes 250px or more.
 * `SHRINK_PX` sits between the two.
 *
 * The baseline is per WIDTH, so rotating the phone is not mistaken for a
 * keyboard. A new width starts a new baseline.
 */
export const SHRINK_PX = 150;

export function isEditable(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLInputElement) {
    const nonText = ['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'];
    return !nonText.includes(el.type) && !el.readOnly && !el.disabled;
  }
  return el instanceof HTMLElement && el.isContentEditable === true;
}

/** Pure, so the decision can be tested without a layout engine. */
export function keyboardUp(input: {
  inset: number;
  tallest: number;
  height: number;
  editableFocused: boolean;
}): boolean {
  if (input.inset > 0) return true;
  return input.editableFocused && input.tallest - input.height >= SHRINK_PX;
}

export function useKeyboardUp(inset: number): boolean {
  const [resized, setResized] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    let width = window.innerWidth;
    let tallest = window.innerHeight;

    const sync = () => {
      if (window.innerWidth !== width) {
        width = window.innerWidth;
        tallest = window.innerHeight;
      }
      tallest = Math.max(tallest, window.innerHeight);
      const next = keyboardUp({
        inset: 0,
        tallest,
        height: window.innerHeight,
        editableFocused: isEditable(document.activeElement),
      });
      setResized((current) => (current === next ? current : next));
    };

    /* focusout fires before the next element takes focus. Read focus on the
       next task, or a tab from one field to another flickers the hero. */
    let pending = 0;
    const syncSoon = () => {
      window.clearTimeout(pending);
      pending = window.setTimeout(sync, 0);
    };

    sync();
    window.addEventListener('resize', sync);
    window.visualViewport?.addEventListener('resize', sync);
    document.addEventListener('focusin', syncSoon);
    document.addEventListener('focusout', syncSoon);
    return () => {
      window.clearTimeout(pending);
      window.removeEventListener('resize', sync);
      window.visualViewport?.removeEventListener('resize', sync);
      document.removeEventListener('focusin', syncSoon);
      document.removeEventListener('focusout', syncSoon);
    };
  }, []);

  return inset > 0 || resized;
}
