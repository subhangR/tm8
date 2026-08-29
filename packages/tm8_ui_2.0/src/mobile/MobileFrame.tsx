import type { CSSProperties, ReactNode } from 'react';
import { useKeyboardInset } from '../terminal/useKeyboardInset';
import './mobile.css';

/**
 * THE MOBILE FRAME — the structural container §5.7's screens get composed into.
 *
 * FRAME ONLY, AND DELIBERATELY EMPTY. This is the chrome row of §5.7's
 * inventory reduced to its regions: a header, one scrolling surface, a tab bar,
 * a sheet host and a notice host. It builds NONE of them and NONE of the
 * fourteen screens — Phase 3 fills these slots, starting with what a shared
 * link lands on (§6). An honest empty frame is worth more here than half a
 * screen inventory, because every screen that lands early lands before the
 * regions it must live inside are settled.
 *
 * IT OWNS NO ROUTING, and `no-router-fork.test.ts` holds it to that. It takes
 * rendered children and places them. Which screen is rendered into `children`
 * is derived from the one shared `navStore` by whatever mounts this — exactly
 * as `WorkspaceView` does for the desktop shell. That is §4.3: two renderings
 * of the same state, one history.
 *
 * MOUNTED BY NOBODY, ON PURPOSE. Phase 2 owns every `GateApp.tsx` edit in this
 * lane, serialized, because two workers in that file is a merge conflict on the
 * one file whose failure mode is a silent wrong screen. See `index.ts` for the
 * exact seam Phase 2 calls.
 *
 * ── THE TWO STRUCTURAL FACTS THAT ARE NOT DECORATION ──────────────────────
 *
 * `100dvh`, not `100vh` (§3.6). On iOS Safari `100vh` is the height the
 * viewport has with the URL bar HIDDEN, so a `100vh` shell is taller than the
 * screen for as long as the bar is showing — which is most of the time, and
 * which puts the bottom tab bar underneath it. `dvh` tracks the bar.
 *
 * SAFE-AREA INSETS, which exist nowhere in this codebase today (§3.6). Without
 * them the tab bar sits under the home indicator and the header under the
 * notch. They are declared as tokens rather than inlined so §7.3's drop notice
 * — a toast that must sit ABOVE the tab bar, inside the inset — can compose
 * against the same numbers instead of re-deriving them.
 */
export interface MobileFrameProps {
  /**
   * Top chrome — title, back affordance, per-screen actions. Phase 3 fills it.
   * When absent the region is not rendered at all, so an empty header cannot
   * leave a dead band of chrome above the content.
   */
  readonly header?: ReactNode;

  /**
   * The screen. One surface at a time — that is the mobile shell's whole
   * arrangement, against the desktop shell's three columns (§4.2).
   */
  readonly children?: ReactNode;

  /** Bottom tab bar — §5.1's five destinations. Phase 3 fills it. */
  readonly tabBar?: ReactNode;

  /**
   * Sheet host. Sheets are the mobile shell's answer to the desktop pin and
   * the desktop hover-card, so the host is a peer of the content rather than a
   * child of it: a sheet must be able to cover the tab bar.
   */
  readonly sheet?: ReactNode;

  /**
   * Notice host (§7.3). Positioned above the tab bar and inside the safe-area
   * inset, which is why it is a frame region and not something a screen renders
   * for itself — a screen does not know where the tab bar is.
   */
  readonly notices?: ReactNode;
}

export function MobileFrame({ header, children, tabBar, sheet, notices }: MobileFrameProps) {
  /*
   * THE KEYBOARD IS A FRAME CONCERN — shell contract, §3 of `CONTRACT.md`.
   *
   * MEASURED ONCE, HERE, AND PUBLISHED AS A NUMBER. `useKeyboardInset` already
   * existed and was called by exactly one surface (the terminal's modifier
   * bar), which is the shape that would have had three lanes each wiring their
   * own listener to the same `visualViewport` and each choosing their own
   * arithmetic for it. A composer, a modifier bar and a sheet that disagree
   * about where the keyboard starts is three bugs, not one.
   *
   * WHY THE WHOLE FRAME SHRINKS rather than each bottom-anchored thing lifting
   * itself. On iOS the soft keyboard OVERLAYS the layout viewport: `innerHeight`
   * does not change, `100dvh` does not change, and the tab bar goes under the
   * keyboard where no finger reaches it. Shrinking the frame is the behaviour
   * `interactive-widget=resizes-content` would give us if iOS honoured it — the
   * whole arrangement stays on screen and above the keyboard, and every region
   * (header, content, notices, tab bar, sheet) inherits that for free without
   * knowing the keyboard exists. A per-region lift would have to be re-derived
   * by every future region and forgotten by one of them.
   *
   * It is inert everywhere it should be: no `visualViewport` (every desktop
   * browser without the API) reports 0, and Android — which genuinely does
   * resize the layout viewport — reports ~0 because `innerHeight` has already
   * shrunk, so the frame is not shortened twice.
   */
  const keyboardInset = useKeyboardInset();

  return (
    <div
      className="mobile-frame"
      data-shell="mobile"
      /* The BOOLEAN half of the same measurement, for the rules that need to
         know "is it up" rather than "how far". Absent rather than `="down"`, so
         a selector for it is a presence check and the DOM stays quiet in the
         state the app is in almost all of the time. */
      {...(keyboardInset > 0 ? { 'data-keyboard': 'up' } : {})}
      /* A CUSTOM PROPERTY, NOT A HEIGHT. The frame's own height composes it in
         `mobile.css` beside `100dvh` and the safe-area tokens, so the whole
         viewport arithmetic stays readable in one place in the stylesheet
         rather than being half in CSS and half in a style attribute. It is also
         then available to any region that needs to compose against it. */
      style={{ '--mobile-keyboard-inset': `${keyboardInset}px` } as CSSProperties}
    >
      {header ? (
        <header className="mobile-frame__header" role="banner">
          {header}
        </header>
      ) : null}

      <main className="mobile-frame__content" role="main">
        {children}
      </main>

      {notices ? <div className="mobile-frame__notices">{notices}</div> : null}

      {tabBar ? (
        <nav className="mobile-frame__tabbar" role="navigation">
          {tabBar}
        </nav>
      ) : null}

      {sheet ? <div className="mobile-frame__sheet">{sheet}</div> : null}
    </div>
  );
}
