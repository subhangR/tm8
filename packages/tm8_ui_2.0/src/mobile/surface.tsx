/**
 * THE ONE-SURFACE SEAM — how a SHARED screen learns it is on a phone, without
 * asking the window and without a second copy of itself.
 *
 * ── THE PROBLEM THIS SOLVES ────────────────────────────────────────────────
 *
 * `MobileShell` reuses the desktop screens (`EntityView`, `ChannelView`) and
 * replaces only the chrome. That is the ruling and it is the right one — the
 * screens are shared, the arrangement is not. But those screens arrange
 * themselves in THREE COLUMNS, and three columns on a 390px phone is the
 * defect this lane exists for: the Tasks list rendered ~200px wide with the
 * desktop detail pane bleeding in behind it and half the screen blank.
 *
 * A screen therefore has to know which arrangement it is being asked for. The
 * three ways it could learn that are not equal:
 *
 *   1. A MEDIA QUERY (`@media (max-width: 500px)`). WRONG: the shell fork is
 *      `(pointer: coarse) && width < 500` (`shell-for.ts`), so a media query
 *      would restyle the DESKTOP shell at a narrow window — a shell that is in
 *      daily use and is not this lane's. Width alone is not the fork.
 *   2. `useShellKind()` INSIDE THE SCREEN. WRONG: that hook touches a live
 *      window, so every shared screen would grow a second, independently-timed
 *      answer to a question `GateApp` has already answered once. Two sources of
 *      one truth is how the shells drift apart.
 *   3. THE HOST TELLS IT. This file. `MobileShell` already knows — it is only
 *      mounted when the fork says phone — so it states the fact once and the
 *      screens under it read it.
 *
 * ── WHY A CONTEXT AND NOT A PROP ───────────────────────────────────────────
 *
 * The screens that need this are not all direct children of the shell, and
 * Lane 3 is about to add seven more. Threading `oneSurface` down through every
 * intermediate component is a prop that every future screen must remember to
 * forward, and forgetting it fails SILENTLY as a squeezed desktop layout —
 * exactly the defect, reintroduced, invisibly. A context cannot be forgotten.
 *
 * ── THE DESKTOP DEFAULT IS THE WHOLE SAFETY ARGUMENT ───────────────────────
 *
 * There is no provider on the desktop path, so `useMobileSurface()` returns
 * `DESKTOP` there — `oneSurface: false`, `sheetHost: null`. Every branch this
 * enables is therefore dead code on a desktop by CONSTRUCTION rather than by a
 * selector that has to be kept correct. A shared screen can gain a phone
 * arrangement without its desktop arrangement being touched, which is the
 * property that lets desktop stay in daily use while this program runs.
 */
import { createContext, useContext, useMemo, type ReactNode } from 'react';

export interface MobileSurface {
  /**
   * TRUE when this screen is being rendered into the phone shell, which shows
   * ONE surface at a time against the desktop's three columns.
   *
   * A screen reading this must COLLAPSE rather than merely restyle: render the
   * list OR the detail, not both narrowed. Narrowing is what produced a 200px
   * list column with a detail pane behind it.
   */
  readonly oneSurface: boolean;

  /**
   * The frame's sheet region, or `null` where there is none.
   *
   * Handed down as a DOM node rather than as a render slot because a sheet's
   * content belongs to the screen that opened it — it closes over that screen's
   * state and props — while its POSITION belongs to the frame, which is the
   * only thing that knows where the tab bar is. A portal is the one arrangement
   * that gives each of those to its rightful owner; see `MobileSheet`.
   */
  readonly sheetHost: HTMLElement | null;
}

const DESKTOP: MobileSurface = { oneSurface: false, sheetHost: null };

const MobileSurfaceContext = createContext<MobileSurface>(DESKTOP);

/**
 * What arrangement am I being rendered into?
 *
 * Safe to call from any shared screen: off the phone shell it returns `DESKTOP`
 * and every phone branch it guards is unreachable.
 */
export function useMobileSurface(): MobileSurface {
  return useContext(MobileSurfaceContext);
}

export interface MobileSurfaceProviderProps {
  readonly sheetHost: HTMLElement | null;
  readonly children: ReactNode;
}

/**
 * Mounted by `MobileShell` around the screen it renders, and by nothing else.
 *
 * `oneSurface` is hard-coded `true` rather than taken as a prop: the only thing
 * that may provide this context is the phone shell, and a provider that could
 * be handed `false` would be a way to get the phone shell's chrome with the
 * desktop's arrangement inside it — a combination no viewer should ever see.
 */
export function MobileSurfaceProvider({ sheetHost, children }: MobileSurfaceProviderProps) {
  const value = useMemo<MobileSurface>(() => ({ oneSurface: true, sheetHost }), [sheetHost]);
  return <MobileSurfaceContext.Provider value={value}>{children}</MobileSurfaceContext.Provider>;
}
