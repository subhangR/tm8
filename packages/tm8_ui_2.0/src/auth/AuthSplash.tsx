/**
 * AuthSplash — the brand moment the gate shows before the sign-in card.
 *
 * WHY THIS IS NOT A FAKE LOADER. `AuthGate` already renders LITERAL NOTHING
 * on a cold browser: `if (!initialFrame && coldAtMount && (!claimSettled ||
 * session.checkingLoopback)) return null`. Two real probes are in flight
 * there — `auth.claim.status` and the loopback auto-owner check — and the gate
 * deliberately blanks rather than paint a card it may have to swap. So there
 * is a genuine wait with a genuine reason, and until now it was drawn as grey
 * nothing. This component draws it instead. It does not invent the wait; it
 * names one that was already happening.
 *
 * THE FLOOR, AND WHY IT IS HONEST. On loopback those probes settle in tens of
 * milliseconds, which would make the splash a two-frame flicker — worse than
 * the blank it replaces, because a flash reads as a fault. `SPLASH_FLOOR_MS`
 * holds it long enough to be read as a deliberate beat. That IS added time and
 * it is stated as such: the floor is short, it runs once per page load, and
 * ANY pointer or key press retires it early (see `useSplashCurtain`) so it can
 * never be a wall between somebody and the password field they came for.
 *
 * THE MARK IS THE PRODUCT'S OWN, NOT THE SUPPLIED PATH. The design ships a
 * flat two-loop SVG with 53 decorative lines clipped inside it; the design
 * IMAGE is unmistakably `RibbonMark` — the 150 quad seams of the real Möbius
 * ribbon are visible in it. Where the two disagree the picture is the brief, so
 * this mounts the real component.
 *
 * IT DOES NOT SPIN, and that is a correction. The first build turned it, the
 * way `BootLoader` turns its wordmark. Measured at 274px the mark then spends a
 * visible slice of every loop EDGE-ON, and an edge-on Möbius ribbon is a sliver
 * — the screenshot of it is a vertical smear, not an 8. The design's own brief
 * says "animates the 8 subtly" and its CSS carries an arrive and a float and no
 * rotation, which is the same conclusion reached from the other direction. So
 * the drawing holds its rest pose and the BOX moves: arrive, then float.
 *
 * (`kit/BrandMark` still turns, per its own note — that mark is 15px, where
 * there is no edge-on frame to be caught in.)
 *
 * Under `prefers-reduced-motion` the curtain never raises at all, so none of it
 * runs and the viewer gets the form immediately rather than a still picture of
 * a wait.
 *
 * `role="status"` + a live region, same as every other wait state here: a
 * screen reader is told the workspace is starting rather than meeting an empty
 * document for a second and a bit.
 */
import { useEffect, useState } from 'react';
import { RibbonMark } from '../kit';
import { useTheme } from '../theme/useTheme';

/**
 * How long the splash is held once painted. Long enough to read as a moment,
 * short enough that nobody waiting on the form resents it. Retired early by
 * any input: the floor governs the eye, never the hand.
 *
 * SIX SECONDS WAS THE FIRST ASK AND IS NOT WHAT SHIPPED. Six reads beautifully
 * once and badly on the tenth page load of a working day, so it went back to
 * the owner with that trade stated and 2.5s is the ruling. Moving this number
 * is a product decision, not a tuning one.
 */
export const SPLASH_FLOOR_MS = 2500;

/** The cross-fade out. Matches `--pn-dur-slower` in `auth.css`. */
export const SPLASH_LIFT_MS = 420;

export type SplashPhase = 'up' | 'lifting' | 'gone';

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * The curtain's own clock, kept out of the gate so the gate keeps reading as a
 * gate.
 *
 * `active` is the caller's answer to "is the real wait still running". The
 * curtain lifts when that has gone false AND the floor has elapsed, whichever
 * is later — so it never cuts away mid-beat and never outstays the work.
 *
 * `armed` is read ONCE, at mount. A curtain that re-raised itself whenever the
 * gate's state churned would flash the brand panel at somebody mid-typing;
 * this is a page-load moment or it is nothing.
 */
export function useSplashCurtain(active: boolean, floorMs = SPLASH_FLOOR_MS): SplashPhase {
  const [armed] = useState(() => !prefersReducedMotion());
  const [phase, setPhase] = useState<SplashPhase>(() => (armed ? 'up' : 'gone'));
  const [floorDone, setFloorDone] = useState(!armed);

  // The floor, plus its escape hatch. Both write the same flag, so whichever
  // comes first wins and the other is a no-op.
  useEffect(() => {
    if (!armed || floorDone) return;
    const done = () => setFloorDone(true);
    const timer = window.setTimeout(done, floorMs);
    // Capture phase: a click on a control underneath still retires the
    // curtain, because the curtain is decoration and the control is not.
    window.addEventListener('pointerdown', done, { capture: true, once: true });
    window.addEventListener('keydown', done, { capture: true, once: true });
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointerdown', done, { capture: true });
      window.removeEventListener('keydown', done, { capture: true });
    };
  }, [armed, floorDone, floorMs]);

  // TWO EFFECTS, AND THEY MUST STAY TWO. Both were one to begin with: the lift
  // was triggered and the fade's timer set in the same body. That effect
  // depends on `phase`, so `setPhase('lifting')` re-ran it, its cleanup
  // cleared the timer it had just set, and the re-run returned early — the
  // curtain reached `lifting` and never reached `gone`. Invisible at
  // `opacity: 0` and fatal: a fixed, full-screen layer stays mounted over the
  // app and swallows every click for the rest of the session. Caught by
  // `splash.test.tsx`, which is why that file asserts removal from the DOM
  // rather than the phase attribute.
  useEffect(() => {
    if (phase !== 'up') return;
    if (active || !floorDone) return;
    setPhase('lifting');
  }, [phase, active, floorDone]);

  // The fade's own clock. Keyed on `lifting`, so its cleanup fires only when
  // the phase LEAVES lifting — which is the transition it is timing.
  useEffect(() => {
    if (phase !== 'lifting') return;
    const timer = window.setTimeout(() => setPhase('gone'), SPLASH_LIFT_MS);
    return () => window.clearTimeout(timer);
  }, [phase]);

  return phase;
}

/**
 * The curtain itself.
 *
 * `aria-hidden` while lifting: by then the thing it announced is over and the
 * card underneath is the live document. Leaving it in the tree for the fade is
 * a visual concern only.
 */
export function AuthSplash({
  phase,
  detail,
  floorMs = SPLASH_FLOOR_MS,
}: {
  phase: SplashPhase;
  detail?: string;
  /**
   * Drives the progress line's fill, and it is the SAME constant the curtain
   * is held for. One number: the bar cannot finish early (which would read as
   * a hang) or late (which would read as a stutter at the hand-off).
   */
  floorMs?: number;
}) {
  const { theme } = useTheme();
  if (phase === 'gone') return null;
  const lifting = phase === 'lifting';
  return (
    /**
     * ITS OWN `.cv2-root`, and it must have one.
     *
     * The curtain mounts in `App`, ABOVE the gate — which is the point, since
     * it has to cover the blank the gate draws. But `.cv2-root` is opened by
     * `GateApp` when signed in and by `AuthFlow` when signed out, both of them
     * BELOW. Every rule in this package is written `.cv2-root .thing`, so with
     * no scope of its own not one of them matched: the mark rendered at its
     * intrinsic size across the whole viewport, in the fallback brass, because
     * `--pn-ribbon-ink: var(--au-splash-ribbon)` resolved to nothing either.
     * The wrong COLOUR was the tell — a sizing bug alone would have kept the
     * palette, and that is what said "no rules matched" rather than "one rule
     * is wrong".
     *
     * Never nested inside another scope, so `app.css`'s `zoom: 1.1` on
     * `.cv2-root` applies once instead of compounding to 1.21× — the same trap
     * `AuthFlow`'s `rootScope === 'inherit'` branch exists to avoid.
     */
    <div className="cv2-root" data-astryx-theme="neutral" data-theme={theme}>
      <div
        className="auth-splash"
        data-phase={phase}
        data-testid="auth-splash"
        style={{ ['--au-splash-ms' as string]: `${floorMs}ms` }}
        role={lifting ? undefined : 'status'}
        aria-live={lifting ? undefined : 'polite'}
        aria-hidden={lifting ? true : undefined}
      >
        <div className="auth-splash__grid" aria-hidden="true" />
        <div className="auth-splash__glow auth-splash__glow--top" aria-hidden="true" />
        <div className="auth-splash__glow auth-splash__glow--bottom" aria-hidden="true" />
        <div className="auth-splash__stack">
          {/* THE 8 ALONE. `layout="mark"` is the standalone 560x700 drawing,
              not the wordmark's smaller 8 — at this size the lockup's letters
              would be furniture and the mark is what is being waited on. */}
          <RibbonMark className="auth-splash__ribbon" layout="mark" animated={false} />
          <div className="auth-splash__loader">
            <div className="auth-splash__track" aria-hidden="true">
              <span className="auth-splash__progress" />
              <span className="auth-splash__shine" />
            </div>
            <div className="auth-splash__label">{detail ?? 'STARTING UP'}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
