import { useEffect, useState } from 'react';

/**
 * HOW MUCH OF THE SCREEN THE SOFT KEYBOARD IS SITTING ON, in CSS pixels.
 *
 * ── THE FACT THIS HOOK EXISTS FOR ─────────────────────────────────────────
 *
 * On iOS Safari the soft keyboard does NOT resize the layout viewport. It
 * overlays it. `window.innerHeight` does not change, `100dvh` does not change,
 * and a `position: fixed` element pinned to the bottom does not move — it goes
 * UNDER the keyboard and becomes untappable. Nothing about that is visible to
 * CSS; there is no media query for "a keyboard is up", and `env()` has no
 * keyboard inset. The only thing in the platform that knows is
 * `window.visualViewport`, and nothing in this package listened to it.
 *
 * The consequence on the terminal specifically, measured: `.term-host` floors
 * at 160px and the frame is 844px tall. With a ~330px keyboard up plus the
 * app's own chrome, the visible slice of terminal is a handful of rows — and
 * the modifier bar, which is the ONLY way to send Esc or Ctrl on this device,
 * is underneath the keyboard where no finger can reach it. A modifier bar that
 * the keyboard covers is not a partially-working feature; it is the feature
 * not existing at exactly the moment it is needed.
 *
 * ── THE ARITHMETIC, AND WHY IT IS NOT JUST `innerHeight - vv.height` ──────
 *
 * The keyboard's occluded strip is what the layout viewport has that the
 * VISUAL viewport does not, MINUS whatever the visual viewport has already
 * been scrolled down by:
 *
 *     inset = layoutHeight - visualViewport.height - visualViewport.offsetTop
 *
 * `offsetTop` is load-bearing and is the term that is usually forgotten. iOS
 * scrolls the visual viewport to keep the focused field visible, and while it
 * is scrolled the bottom of the visual viewport has already moved down the
 * page. Dropping the term double-counts that scroll and pushes the bar up by
 * roughly the amount the page moved — the bar drifts away from the keyboard as
 * you type, which reads as a rendering bug rather than as a missing term.
 *
 * Clamped at zero: `visualViewport.height` exceeds the layout height during
 * pinch-zoom-out and rubber-band scrolling, and a negative inset would pull the
 * bar off the bottom of the screen.
 *
 * ── WHY IT REPORTS PIXELS AND NOT A VIEWPORT UNIT ────────────────────────
 *
 * Because a viewport unit inside a CSS `zoom` scope means two different things:
 * Chrome leaves `vh` at the raw viewport while Safari divides it by the zoom.
 * This surface sits under `.cv2-root`, which is a zoom scope on desktop, so a
 * `vh`-derived offset here would be correct in one engine and wrong in the
 * other. A number measured in JS and applied as `px` has one meaning in both.
 *
 * ── RESIZE IS NOT ENOUGH ─────────────────────────────────────────────────
 *
 * Both `resize` AND `scroll` are subscribed. The keyboard opening fires
 * `resize`; the visual viewport being scrolled while it is open fires only
 * `scroll`, and that is the event that moves `offsetTop`. Listening to one of
 * them gives a bar that is correct until the user types.
 */
export function useKeyboardInset(): number {
  const [inset, setInset] = useState(0);

  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : undefined;
    /* No visualViewport means no way to know, and "no way to know" must resolve
       to zero rather than to a guess: a wrong non-zero inset moves the terminal
       for no reason on every desktop browser that lacks the API. */
    if (!vv) return;

    const sync = () => {
      const occluded = window.innerHeight - vv.height - vv.offsetTop;
      /* Sub-pixel noise is constant here (device pixel ratios of 3 produce
         thirds), and a value that jitters by a third of a pixel would rerender
         this subtree on every scroll frame. Round, and only commit a change. */
      const next = Math.max(0, Math.round(occluded));
      setInset((current) => (current === next ? current : next));
    };

    sync();
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    return () => {
      vv.removeEventListener('resize', sync);
      vv.removeEventListener('scroll', sync);
    };
  }, []);

  return inset;
}
