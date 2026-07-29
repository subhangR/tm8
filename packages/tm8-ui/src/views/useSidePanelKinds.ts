/**
 * Side-panel kind selection — the state behind the workspace panels' kind
 * selectors (LLD §11 state-ownership table).
 *
 * The table rules this precisely: owner `sidePanelStore`, persistence
 * "localStorage per (viewer, space)". It is deliberately NOT in the URL — two
 * viewers sharing a workspace link should each keep their own panel choice,
 * which is exactly why it sits outside the navStore's URL-mirrored state.
 *
 * WHY IT LIVES IN `views/` FOR NOW: the LLD module map puts `sidePanelStore` in
 * `src/stores/`, which is A1a's lane. This hook implements the ruled CONTRACT
 * (same key shape, same per-viewer-per-space scoping) inside my own lane so the
 * gate is not blocked on a cross-lane turn; when a real `stores/sidePanelStore`
 * lands, this becomes a re-export and the storage key does not change.
 *
 * The defect it fixes: `EntityListPanel` has always emitted `onKindChange`, and
 * the shell never handled it — so the kind selector rendered, opened, and did
 * nothing. An affordance that looks live and changes nothing is worse than one
 * honestly disabled (L6): it teaches the viewer a false model of the app.
 */
import { useCallback, useEffect, useState } from 'react';
import type { SpaceId } from '@tm8/contract';
import {
  LEFT_PANEL_DEFAULT,
  LEFT_PANEL_MIN,
  RIGHT_PANEL_DEFAULT,
  RIGHT_PANEL_MIN,
} from '../shell/geometry';

export type SidePanelDock = 'left' | 'right';

interface PersistedSidePanels {
  left: string;
  right: string;
  leftWidth: number;
  rightWidth: number;
}

export interface SidePanelKinds {
  leftKind: string;
  rightKind: string;
  leftWidth: number;
  rightWidth: number;
  setLeftKind(kind: string): void;
  setRightKind(kind: string): void;
  movePanel(from: SidePanelDock, to: SidePanelDock): void;
  resizePanel(side: SidePanelDock, width: number): void;
  resetPanelWidth(side: SidePanelDock): void;
}

/** `tm8ui.sidePanel.{viewerId}.{spaceId}` — scoped per the §11 table. */
function storageKey(viewerId: string, spaceId: SpaceId): string {
  return `tm8ui.sidePanel.${viewerId}.${spaceId}`;
}

function read(
  viewerId: string,
  spaceId: SpaceId,
): Partial<PersistedSidePanels> {
  // Storage is a hostile input: it survives upgrades, users edit it, and a
  // parse failure here would take the whole workspace down. Fail to the
  // defaults rather than propagate.
  try {
    const raw = window.localStorage.getItem(storageKey(viewerId, spaceId));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const { left, right, leftWidth, rightWidth } = parsed as Record<string, unknown>;
    return {
      left: typeof left === 'string' ? left : undefined,
      right: typeof right === 'string' ? right : undefined,
      leftWidth:
        typeof leftWidth === 'number' && Number.isFinite(leftWidth)
          ? Math.max(LEFT_PANEL_MIN, leftWidth)
          : undefined,
      rightWidth:
        typeof rightWidth === 'number' && Number.isFinite(rightWidth)
          ? Math.max(RIGHT_PANEL_MIN, rightWidth)
          : undefined,
    };
  } catch {
    return {};
  }
}

export interface SidePanelKindsOptions {
  viewerId: string;
  spaceId: SpaceId;
  /** Registry-supplied defaults — the shell does not name kinds itself (§15.2). */
  defaultLeft: string;
  defaultRight: string;
  /** Guard: a persisted kind the registry can no longer render falls back. */
  isSelectable?: (kind: string) => boolean;
}

export function useSidePanelKinds(options: SidePanelKindsOptions): SidePanelKinds {
  const { viewerId, spaceId, defaultLeft, defaultRight, isSelectable } = options;

  const [panels, setPanels] = useState<PersistedSidePanels>({
    left: defaultLeft,
    right: defaultRight,
    leftWidth: LEFT_PANEL_DEFAULT,
    rightWidth: RIGHT_PANEL_DEFAULT,
  });

  // Re-read when the viewer or space changes — the persistence is scoped to
  // BOTH, so switching either one is a different stored choice, not the same
  // one carried across.
  useEffect(() => {
    if (!spaceId || typeof window === 'undefined') return;
    const stored = read(viewerId, spaceId);
    const usable = (kind: string | undefined, fallback: string): string =>
      kind && (isSelectable?.(kind) ?? true) ? kind : fallback;
    setPanels({
      left: usable(stored.left, defaultLeft),
      right: usable(stored.right, defaultRight),
      leftWidth: stored.leftWidth ?? LEFT_PANEL_DEFAULT,
      rightWidth: stored.rightWidth ?? RIGHT_PANEL_DEFAULT,
    });
  }, [viewerId, spaceId, defaultLeft, defaultRight, isSelectable]);

  const persist = useCallback(
    (next: PersistedSidePanels) => {
      setPanels(next);
      if (!spaceId || typeof window === 'undefined') return;
      try {
        window.localStorage.setItem(
          storageKey(viewerId, spaceId),
          JSON.stringify(next),
        );
      } catch {
        // Storage full or blocked (private mode). The choice still applies to
        // this session; losing persistence is not worth losing the interaction.
      }
    },
    [viewerId, spaceId],
  );

  return {
    leftKind: panels.left,
    rightKind: panels.right,
    leftWidth: panels.leftWidth,
    rightWidth: panels.rightWidth,
    setLeftKind: useCallback(
      (kind: string) => persist({ ...panels, left: kind }),
      [panels, persist],
    ),
    setRightKind: useCallback(
      (kind: string) => persist({ ...panels, right: kind }),
      [panels, persist],
    ),
    movePanel: useCallback(
      (from: SidePanelDock, to: SidePanelDock) => {
        if (from === to) return;
        persist({
          left: panels.right,
          right: panels.left,
          leftWidth: Math.max(LEFT_PANEL_MIN, panels.rightWidth),
          rightWidth: Math.max(RIGHT_PANEL_MIN, panels.leftWidth),
        });
      },
      [panels, persist],
    ),
    resizePanel: useCallback(
      (side: SidePanelDock, width: number) =>
        persist({
          ...panels,
          [side === 'left' ? 'leftWidth' : 'rightWidth']: Math.max(
            side === 'left' ? LEFT_PANEL_MIN : RIGHT_PANEL_MIN,
            Math.round(width),
          ),
        }),
      [panels, persist],
    ),
    resetPanelWidth: useCallback(
      (side: SidePanelDock) =>
        persist({
          ...panels,
          [side === 'left' ? 'leftWidth' : 'rightWidth']:
            side === 'left' ? LEFT_PANEL_DEFAULT : RIGHT_PANEL_DEFAULT,
        }),
      [panels, persist],
    ),
  };
}
