/**
 * The space's custom kinds, fed into the registry so every kind list names
 * them (see `registerCustomKinds` in domain/registry.ts).
 *
 * `useCustomKindsSync` is called ONCE, by the gate, for the active space;
 * a surface that enumerates kinds calls `useCustomKindsVersion` so it
 * re-renders when the set arrives — the registry is module state, which
 * React cannot see change on its own.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { customKindsVersion, registerCustomKinds, subscribeCustomKinds } from '../domain';
import type { SpaceId } from '@tm8/contract';
import type { Seam } from './seam';

/** Re-render on custom-kind registration; returns the registry version. */
export function useCustomKindsVersion(): number {
  return useSyncExternalStore(subscribeCustomKinds, customKindsVersion, customKindsVersion);
}

/**
 * Load the active space's custom kinds into the registry. A failed read keeps
 * whatever is registered — the kinds stay addressable by `k/c-{name}` either
 * way, so a list missing them is degraded, not broken.
 */
export function useCustomKindsSync(seam: Seam, spaceId: string | null | undefined): number {
  useEffect(() => {
    if (!spaceId) return;
    let live = true;
    seam.entityKinds(spaceId as SpaceId).then(
      (defs) => { if (live) registerCustomKinds(defs); },
      () => { /* keep the current set; see above */ },
    );
    return () => { live = false; };
  }, [seam, spaceId]);
  return useCustomKindsVersion();
}
