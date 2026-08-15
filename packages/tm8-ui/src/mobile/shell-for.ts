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
 * PROVISIONAL — §4.4 calls the `~500` a placeholder until the reference-capture
 * pass measures it. It is a named export rather than an inline literal so that
 * pass is a one-line change with a test that already covers both sides of it.
 *
 * The comparison is strictly `<`, so 500 itself is DESKTOP.
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
