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

export interface SidePanelKinds {
  leftKind: string;
  rightKind: string;
  setLeftKind(kind: string): void;
  setRightKind(kind: string): void;
}

/** `tm8ui.sidePanel.{viewerId}.{spaceId}` — scoped per the §11 table. */
function storageKey(viewerId: string, spaceId: SpaceId): string {
  return `tm8ui.sidePanel.${viewerId}.${spaceId}`;
}

function read(viewerId: string, spaceId: SpaceId): { left?: string; right?: string } {
  // Storage is a hostile input: it survives upgrades, users edit it, and a
  // parse failure here would take the whole workspace down. Fail to the
  // defaults rather than propagate.
  try {
    const raw = window.localStorage.getItem(storageKey(viewerId, spaceId));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const { left, right } = parsed as { left?: unknown; right?: unknown };
    return {
      left: typeof left === 'string' ? left : undefined,
      right: typeof right === 'string' ? right : undefined,
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

  const [kinds, setKinds] = useState<{ left: string; right: string }>({
    left: defaultLeft,
    right: defaultRight,
  });

  // Re-read when the viewer or space changes — the persistence is scoped to
  // BOTH, so switching either one is a different stored choice, not the same
  // one carried across.
  useEffect(() => {
    if (!spaceId || typeof window === 'undefined') return;
    const stored = read(viewerId, spaceId);
    const usable = (kind: string | undefined, fallback: string): string =>
      kind && (isSelectable?.(kind) ?? true) ? kind : fallback;
    setKinds({
      left: usable(stored.left, defaultLeft),
      right: usable(stored.right, defaultRight),
    });
  }, [viewerId, spaceId, defaultLeft, defaultRight, isSelectable]);

  const persist = useCallback(
    (next: { left: string; right: string }) => {
      setKinds(next);
      if (!spaceId || typeof window === 'undefined') return;
      try {
        window.localStorage.setItem(
          storageKey(viewerId, spaceId),
          JSON.stringify({ left: next.left, right: next.right }),
        );
      } catch {
        // Storage full or blocked (private mode). The choice still applies to
        // this session; losing persistence is not worth losing the interaction.
      }
    },
    [viewerId, spaceId],
  );

  return {
    leftKind: kinds.left,
    rightKind: kinds.right,
    setLeftKind: useCallback((kind: string) => persist({ ...kinds, left: kind }), [kinds, persist]),
    setRightKind: useCallback((kind: string) => persist({ ...kinds, right: kind }), [kinds, persist]),
  };
}
