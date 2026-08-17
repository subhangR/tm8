import { useEffect, useState, type CSSProperties, type RefObject } from 'react';

/**
 * VIEWPORT COORDINATES FOR A PORTALLED MENU.
 *
 * Lifted out of `panels/controls/EntityControls.tsx` when the Board tab's
 * filter selects became its second consumer. Nothing here changed except the
 * menu height, which is now an argument: the panels menu is 210px tall by its
 * own stylesheet, the board's is taller, and a hook that hard-codes one
 * consumer's number silently flips the other one's up/down decision.
 *
 * WHY A PORTAL AT ALL. A menu positioned inside its trigger's subtree is at
 * the mercy of every ancestor's `overflow` — `.pn-tt` sets `overflow: hidden`
 * plus `container-type`, which clips and traps it. Rendering into the app root
 * with fixed coordinates is the only placement that cannot be clipped by a
 * container the trigger does not control.
 *
 * IT CLOSES ON SCROLL AND RESIZE rather than tracking them: fixed coordinates
 * measured once go stale the moment the page moves, and a menu that has
 * drifted away from its trigger is worse than a menu that is gone.
 *
 * AND IT DIVIDES BY THE HOST'S ZOOM, which is the part that is not obvious.
 * `.cv2-root` carries `zoom: 1.1`, and CSS `zoom` multiplies every length
 * inside it — including a `position: fixed` descendant's — while
 * `getBoundingClientRect` keeps answering in real screen pixels. Feeding a
 * measured rect straight back as a fixed coordinate therefore lands the menu
 * at `x * 1.1`: a 25px drift under the leftmost control and ~50px under the
 * rightmost, growing with distance from the origin. Measured in a real engine
 * (`e2e/capture-board.mjs`); jsdom applies no zoom, so no vitest case here can
 * ever see it.
 */

/** The zoom actually applied to a subtree — `zoom` MULTIPLIES when nested. */
function zoomOf(el: HTMLElement): number {
  let factor = 1;
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    const z = Number.parseFloat(getComputedStyle(node).zoom);
    if (Number.isFinite(z) && z > 0) factor *= z;
  }
  return factor;
}
export interface MenuAnchor {
  style: CSSProperties;
  host: HTMLElement;
}

/** Panels' menu: 210px max-height (panels.css) + its 4px offset. */
export const PANELS_MENU_HEIGHT = 214;

export function useMenuAnchor(
  open: boolean,
  boxRef: RefObject<HTMLElement | null>,
  menuRef: RefObject<HTMLElement | null>,
  onClose: () => void,
  /** The menu's own outer height — decides whether it opens up or down. */
  menuHeight: number = PANELS_MENU_HEIGHT,
  /** The menu's minimum width — the right-edge clamp cannot push it off-screen. */
  menuWidth = 170,
): MenuAnchor | null {
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  useEffect(() => {
    if (!open) {
      setAnchor(null);
      return;
    }
    const el = boxRef.current;
    const box = el?.getBoundingClientRect();
    if (!el || !box) return;
    const host = (el.closest('.cv2-root') as HTMLElement | null) ?? document.body;
    /* Every decision below is taken in SCREEN pixels, because that is what the
       rect and the viewport are measured in — the menu's declared size has to
       be scaled UP to be compared with them, and the answers scaled back DOWN
       to be written as lengths inside the zoomed host. */
    const zoom = zoomOf(host);
    const shownHeight = menuHeight * zoom;
    const shownWidth = menuWidth * zoom;
    const below = window.innerHeight - box.bottom;
    const up = below < shownHeight && box.top > below;
    setAnchor({
      host,
      style: {
        position: 'fixed',
        // Clamped so a trigger at the right edge cannot push the menu's
        // minimum width off-screen.
        left: Math.max(8, Math.min(box.left, window.innerWidth - shownWidth - 8)) / zoom,
        ...(up
          ? { top: 'auto', bottom: (window.innerHeight - box.top + 4) / zoom }
          : { top: (box.bottom + 4) / zoom }),
        zIndex: 1000,
      },
    });
    const close = (event: Event) => {
      if (
        menuRef.current
        && event.target instanceof Node
        && menuRef.current.contains(event.target)
      ) return;
      onClose();
    };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open, boxRef, menuRef, onClose, menuHeight, menuWidth]);
  return anchor;
}
