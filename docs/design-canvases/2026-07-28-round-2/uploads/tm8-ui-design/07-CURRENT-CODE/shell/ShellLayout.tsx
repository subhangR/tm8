/**
 * ShellLayout — what Atlas mounts. Composes the workspace chrome:
 *
 *   IconRail │ LeftRail │ CenterHost │ pinned splits │ Z3 panel stack │ palette
 *
 * It also owns the two global wirings: the hash router (URL ⇄ nav store, so
 * back/forward is graph browsing history) and the keyboard map. Both are
 * opt-out props so tests and embeds can mount the chrome without touching
 * `window`.
 */
import { useEffect, useMemo, type ReactNode } from 'react';
import './shell.css';
import { useNavStore } from '../stores/nav';
import type { CollabFacade } from '../facade/CollabFacade';
import type { SpaceId } from '../types/contract';
import { CenterHost } from './CenterHost';
import { IconRail } from './IconRail';
import { LeftRail } from './LeftRail';
import { PanelStack } from './PanelStack';
import { useKeyboardMap } from './keyboard';
import { createBrowserTarget, isRoutableHash, startRouter, type RouterTarget } from './router';
import type { PanelSlot, RailSection, ViewRegistry } from './types';

export interface ShellLayoutProps {
  facade: CollabFacade;
  /** Space to open when the URL carries none. Defaults to the first space. */
  spaceId?: SpaceId;
  /** W3 screens. Missing views fall back to the data-backed placeholder. */
  views?: ViewRegistry;
  /** W1a EntityPanel body slot. */
  renderPanel?: PanelSlot;
  /** W2 command palette — rendered when `paletteOpen` is set. */
  palette?: ReactNode;
  extraSections?: RailSection[];
  enableRouter?: boolean;
  enableKeyboard?: boolean;
  /** Injectable history transport (tests use `createMemoryTarget`). */
  routerTarget?: RouterTarget;
  /**
   * ⚠ tm8 addition (drift ledger): views that own the whole window.
   *
   * The shell is a fixed four-slot grid, so a screen mounted in `CenterHost`
   * necessarily sits to the RIGHT of `IconRail` and `LeftRail`. That is correct
   * for every view the module ships — they are sections WITHIN this chrome.
   *
   * It is wrong for exactly one case: a screen that is an application shell in
   * its own right. tm8's execution workspace is a verbatim transplant of
   * maestro's window — its own project tab bar across the top, its own icon
   * rail down the side — so mounting it inside this chrome renders two icon
   * rails side by side and a tab bar starting a third of the way across the
   * screen. Naming such views here lets the shell step ASIDE for them, which is
   * both smaller and far more honest than letting the view paint over chrome
   * that is still underneath it — still focusable, still in the tab order,
   * still announced to a screen reader.
   *
   * Route, nav store and router are untouched either way: only the chrome
   * around the view changes, so navigating anywhere else restores it with no
   * special case. Typed as `readonly string[]` rather than `ViewName[]` so the
   * module does not have to know which of tm8's views are full-bleed.
   */
  fullBleedViews?: readonly string[];
}

export function ShellLayout({
  facade,
  spaceId,
  views,
  renderPanel,
  palette,
  extraSections,
  enableRouter = true,
  enableKeyboard = true,
  routerTarget,
  fullBleedViews,
}: ShellLayoutProps) {
  const currentSpace = useNavStore((s) => s.spaceId);
  const paletteOpen = useNavStore((s) => s.paletteOpen);
  const view = useNavStore((s) => s.view);

  const target = useMemo(
    () => (routerTarget ?? (typeof window === 'undefined' ? null : createBrowserTarget(window))),
    [routerTarget],
  );

  // Pick a space before the router publishes the first URL — but never clobber a
  // deep link: a routable hash wins, and `setSpace` would clear its stack/pins.
  useEffect(() => {
    if (useNavStore.getState().spaceId) return;
    const hash = target?.getHash();
    if (enableRouter && hash && isRoutableHash(hash)) {
      useNavStore.getState().hydrateFromHash(hash);
      return;
    }
    if (spaceId) { useNavStore.getState().setSpace(spaceId); return; }
    let alive = true;
    void facade.listSpaces().then((spaces) => {
      if (!alive || !spaces[0] || useNavStore.getState().spaceId) return;
      useNavStore.getState().setSpace(spaces[0].id);
    }, () => undefined);
    return () => { alive = false; };
  }, [facade, spaceId, target, enableRouter]);

  const hasSpace = Boolean(currentSpace);
  useEffect(() => {
    if (!enableRouter || !target || !hasSpace) return;
    return startRouter(target);
  }, [enableRouter, target, hasSpace]);

  useKeyboardMap(enableKeyboard);

  // The rails are OMITTED rather than hidden for a full-bleed view: a rail that
  // is merely covered is still tabbable and still read aloud, which is a worse
  // bug than the double chrome it was hiding. The palette stays — it is global,
  // it is modal, and a keyboard shortcut that silently stops working on one
  // route is exactly the kind of quiet gap this codebase captions instead.
  if (fullBleedViews?.includes(view)) {
    return (
      <div className="cv2-shell cv2-shell--fullbleed" data-testid="cv2-shell" data-fullbleed={view}>
        <CenterHost facade={facade} views={views} fallback={<div className="cv2-center__hint">Loading space…</div>} />
        {paletteOpen && palette}
      </div>
    );
  }

  return (
    <div className="cv2-shell" data-testid="cv2-shell">
      <IconRail facade={facade} />
      <LeftRail facade={facade} extraSections={extraSections} />
      <CenterHost facade={facade} views={views} fallback={<div className="cv2-center__hint">Loading space…</div>} />
      <PanelStack facade={facade} renderPanel={renderPanel} />
      {paletteOpen && palette}
    </div>
  );
}
