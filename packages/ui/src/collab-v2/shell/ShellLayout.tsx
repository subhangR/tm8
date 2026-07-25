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
}: ShellLayoutProps) {
  const currentSpace = useNavStore((s) => s.spaceId);
  const paletteOpen = useNavStore((s) => s.paletteOpen);

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
