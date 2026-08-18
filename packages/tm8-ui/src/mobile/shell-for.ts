/**
 * §4.4 — WHICH SHELL RENDERS. A pure function, no state, no React, no window.
 *
 * RULED (user, 2026-08-14): **coarse pointer AND narrow, with a user override.**
 *
 *     shellFor({ pointer, width, override }) → 'mobile' | 'desktop'
 *       override ?? (pointer === 'coarse' && width < ~500)
 *
 * The same shape `geometry.ts` already establishes, for the same reason: the
 * decision is provable in isolation, without a DOM, and the pixel thresholds
 * are measured rather than asserted. Everything that needs a live window —
 * reading the media query, the viewport width, the stored override — lives in
 * `useShellKind.ts` and does nothing but feed this function.
 *
 * THIS IS NOT `shell/geometry.ts` AND MUST NOT IMPORT IT. Geometry answers
 * *"how many panel columns fit, and what settles if they do not"* — a
 * presentational demotion under R13, inside the desktop shell. This answers
 * *"which shell renders at all"*. Related questions, different decisions, and
 * conflating them would put a viewport-demotion concern in the one function
 * that must stay decidable before either shell mounts.
 *
 * WHY `pointer` AND NOT WIDTH ALONE — the consequences are deliberate (§4.4):
 *
 *   iPhone 390, coarse  → mobile
 *   iPad 820, coarse    → desktop   (the override is how a user disagrees)
 *   desktop @ 390, fine → desktop, descending the existing layout ladder
 *
 * A dragged-narrow desktop window KEEPS THE DESKTOP SHELL and descends into
 * `sheets`, so the solver's bottom rungs stay reachable and the §3.3 fix stays
 * necessary rather than becoming dead code. A keyboard-and-mouse user never
 * gets touch-sized targets, however narrow the window.
 */

/** What kind of pointer the primary input device has. `(pointer: coarse)`. */
export type PointerType = 'coarse' | 'fine';

/** The two renderings. There is no third, and adding one is an architecture change. */
export type ShellKind = 'mobile' | 'desktop';

export interface ShellForInput {
  /** Primary pointer type, from `(pointer: coarse)`. */
  readonly pointer: PointerType;
  /** Viewport width in CSS pixels. */
  readonly width: number;
  /**
   * The user's explicit per-device choice, or `null`/`undefined` when they
   * have not chosen. When set it WINS OUTRIGHT — that is what an override is,
   * and a tablet user who wants the phone shell must be able to say so.
   */
  readonly override?: ShellKind | null;
}

/**
 * The narrow threshold, in CSS pixels.
 *
 * NO LONGER PROVISIONAL. §4.4 called the `~500` a placeholder until a capture
 * pass measured it. The `before-lanes` run is that pass, and the shell contract
 * (DEF-041, owner-ruled into the gate on 2026-08-18) settles the number HERE
 * rather than deferring it — because three lanes are about to build on this
 * contract and moving the cut afterwards re-opens it under them.
 *
 * THE RULING: THE CUT STAYS AT 500.
 *
 * The comparison is strictly `<`, so 500 itself is DESKTOP.
 *
 * ── WHAT THE EVIDENCE ACTUALLY SAID ────────────────────────────────────────
 *
 * `OFFICIAL-before-lanes.json` measured tablet-768 with `coarsePointer: true`
 * on all 14 routes. 768 is above this cut, so the phone fork never fires and a
 * coarse tablet is served the DESKTOP shell — where it overflows nearly every
 * route: `overflowCount` 9 with `worstRightEdge` 1048 against an inner width of
 * 768, and `board` at `overflowCount` 53 / `worstRightEdge` 2201.
 *
 * That is real and it is bad. It is also NOT an argument for moving this line,
 * and the four reasons are recorded so this is not re-litigated from the
 * numbers alone:
 *
 *   1. RAISING THE CUT WOULD SHIP AN UNMEASURED SHELL TO A WHOLE DEVICE CLASS.
 *      A cut above 768 hands every iPad the PHONE arrangement — one surface, a
 *      five-destination tab bar, no columns — on a 768x1024 device. The phone
 *      shell has been measured at 390 and 430 and at no other width by anything
 *      in this program. Trading "amputated content" for "a phone app blown up
 *      to tablet size" is not obviously the better failure, and choosing it
 *      inside the gate whose whole purpose is to stop unverified shell changes
 *      would be self-defeating.
 *
 *   2. THE OVERFLOW IS A DESKTOP-SHELL BUG, NOT A SHELL-SELECTION BUG. `board`
 *      reports the SAME `worstRightEdge` of 2201 at desktop-1440
 *      (`overflowCount` 19) as it does at 768. A layout that overflows a 1440px
 *      window is not overflowing because the viewer is holding a tablet.
 *      Reassigning the shell would HIDE that finding behind a different
 *      arrangement rather than fix it.
 *
 *   3. THE TABLET CASE IS ALREADY A DELIBERATE ANSWER HERE, not an oversight —
 *      see the consequence table above ("iPad 820, coarse -> desktop"). A
 *      coarse-pointer tablet user who wants the phone arrangement says so with
 *      the override, which wins outright and is read back by `useShellKind`.
 *
 *   4. THE THREE LANES ARE SCOPED COARSE-POINTER PHONE. Moving the cut would
 *      silently widen every lane's verification surface to a viewport the build
 *      service is not asserting thresholds at.
 *
 * ── THE OUTCOME, STATED RATHER THAN LEFT SILENT (DEF-041 acceptance) ────────
 *
 * The cut did NOT move, so tablet-768 is a **KNOWN, RECORDED FAILURE** and not
 * an undiscovered one. Nobody reading the baseline's tablet rows later should
 * file them as new: they are the accepted consequence of this ruling, written
 * down at the moment the ruling was made.
 *
 * IT IS NOT OWNED BY A LANE and it is not owned by this contract. The cure is a
 * distinct tablet arrangement — a desktop shell that reflows below its column
 * floors — which is a separate scope from both the phone lanes and this gate.
 *
 * ITS OWNER IS A TASK, NOT A NAME IN PROSE, so the record outlives the program
 * that found it:
 *
 *     tm8 task 01a016b4-9359-77c6-9078-4354ba8202db
 *     "Desktop-shell reflow overflow (surfaces as tablet-768) — needs an owner"
 *
 * See `src/mobile/CONTRACT.md` §1.
 */
export const MOBILE_MAX_WIDTH = 500;

/**
 * Which shell renders.
 *
 * Total over its input: every combination of pointer, width and override
 * returns one of the two kinds. A width that is not a finite number means the
 * measurement failed, and the answer is DESKTOP — the shell that has always
 * existed. Falling back to the new shell on a failed measurement would turn a
 * measurement bug into "the desktop app silently became a phone app", which is
 * the worse of the two failures by a wide margin.
 */
export function shellFor(input: ShellForInput): ShellKind {
  if (input.override) return input.override;
  if (!Number.isFinite(input.width)) return 'desktop';
  return input.pointer === 'coarse' && input.width < MOBILE_MAX_WIDTH ? 'mobile' : 'desktop';
}

/**
 * Narrows an untrusted string to a `ShellKind`.
 *
 * The stored override is read back from device storage, which means it is
 * whatever was last written there — a stale value from an older build, or
 * something a user typed into devtools. Anything unrecognised reads as "no
 * override set" rather than throwing: a corrupt preference must not be able to
 * stop the app from choosing a shell.
 */
export function asShellKind(value: string | null | undefined): ShellKind | null {
  return value === 'mobile' || value === 'desktop' ? value : null;
}
