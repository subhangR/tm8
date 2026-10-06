import { useLayoutEffect, useRef, useState } from 'react';

/**
 * WHERE A FULL-PAGE MODAL MOUNTS: the OUTERMOST `.cv2-root` above the place
 * that rendered it.
 *
 * A `position: fixed; z-index: 200` overlay is only as high as the stacking
 * context it sits in. Rendered in place, the launch popup lived inside the
 * tab's right action strip, whose `.pn-actions__flow` is `position: absolute;
 * z-index: 40` — so the scrim covered the page but the icon rail and the tab's
 * title bar, stacked higher in the shell, painted straight through it.
 *
 * OUTERMOST, not `closest`: `.cv2-root` is re-opened inside itself as a theme
 * scope (the dark action strip is one), and the nearest one is exactly the
 * trapped subtree we are escaping. The outermost root still carries the theme
 * tokens and the 1.1 zoom, which `document.body` would not; body is the
 * fallback only where there is no root at all (tests, bare harnesses).
 *
 * Usage: render `marker` in place until `host` is known, then portal into it.
 */
export function useOverlayHost(): {
  marker: React.RefObject<HTMLSpanElement | null>;
  host: HTMLElement | null;
} {
  const marker = useRef<HTMLSpanElement | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  /* Layout effect: the re-render lands before paint, so nothing flashes in place. */
  useLayoutEffect(() => {
    if (host || !marker.current) return;
    let root: HTMLElement | null = null;
    for (let node = marker.current.parentElement; node; node = node.parentElement) {
      if (node.classList.contains('cv2-root')) root = node;
    }
    setHost(root ?? marker.current.ownerDocument.body);
  }, [host]);
  return { marker, host };
}
