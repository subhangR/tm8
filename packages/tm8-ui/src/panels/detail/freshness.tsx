import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';

/**
 * CONTENT FRESHNESS FOR AN OPEN PANEL — the consumer half of
 * `DomainState.staleDetails`.
 *
 * THE BUG THIS CLOSES. An `entity.upsert` carries a summary and no content, so
 * the store overlays the new version, title and state onto the content it
 * already had. The panel then shows `v14` over `v13`'s body, scene or bundle
 * and keeps showing it: `refetchDetail` only runs after the viewer's OWN
 * actions, and `pull` is a cache-fill that early-returns on a cached detail —
 * which an open panel always has. Nothing re-read on someone else's edit, so
 * docs, drawings and artifacts sat on old content until a reload.
 *
 * WHY THE HOOK LIVES WITH THE PANEL AND NOT WITH THE STORE. "Re-read the open
 * ones" needs to know which ones are open, and the honest answer to that is
 * not a registry the hook layer maintains — it is which components are
 * MOUNTED. A mounted `EntityDetailPanel` is an open view of exactly one id, so
 * subscribing there makes openness structural: no retain/release to keep in
 * step with navigation, and nothing to leak when a tab closes.
 *
 * WHY A CONTEXT AND NOT A PROP. Five hosts mount `EntityDetailPanel`
 * (Workspace, Entity, Channel, Graph, aux) and more mount it indirectly. This
 * concern is the same for all of them and interesting to none, so it rides a
 * provider mounted once above them — the shape `EntitySeenProvider` already
 * uses for the same reason. The default value is inert, so a dev harness,
 * fixture screen or unit test mounts a panel with no node and asks for
 * nothing.
 *
 * NOT A REQUEST FROM RENDER. The read is issued from an effect keyed on the
 * ANNOUNCED VERSION, and the comments on `pull` explain why that distinction
 * is load-bearing rather than pedantic: a render-time request against an
 * entity whose read cannot satisfy the condition is a loop against the node.
 * Here the key is a version number, so the sequence terminates — see the
 * effect below.
 */
export interface DetailFreshness {
  /** Entity id → the version the node has announced but this client lacks. */
  staleDetails?: Readonly<Record<string, number>>;
  /** Re-read one id's detail. Coalesced per id by the hook layer. */
  freshenDetail?: (id: string) => void;
}

const INERT: DetailFreshness = {};

const FreshnessContext = createContext<DetailFreshness>(INERT);

/**
 * A SHORT SETTLE BEFORE THE READ, which is the debounce the fix calls for.
 *
 * Long enough that a save landing as three bumps in quick succession (content,
 * then a counter, then a status) is answered by ONE read of the final version
 * rather than three of intermediate ones — each new mark replaces the pending
 * timer below. Short enough that a remote edit still appears "within a few
 * seconds" without a reload, which is the behaviour being asked for. The
 * store's own frame batching already folds a same-frame burst into one mark;
 * this covers bursts spread across frames.
 */
export const FRESHEN_DEBOUNCE_MS = 400;

export function DetailFreshnessProvider({
  staleDetails,
  freshenDetail,
  children,
}: DetailFreshness & { children: ReactNode }) {
  /* Memoised on the two members, so the provider hands down a new value only
     when a mark is added or answered. `staleDetails` is a store slice whose
     identity is already stable across events that change no mark, so a steady
     burst over entities nobody has open re-renders no consumer. */
  const value = useMemo<DetailFreshness>(
    () => ({ staleDetails, freshenDetail }),
    [staleDetails, freshenDetail],
  );
  return <FreshnessContext.Provider value={value}>{children}</FreshnessContext.Provider>;
}

/**
 * Keep the content behind `id` fresh while this component is mounted.
 *
 * Call it UNCONDITIONALLY and above any early return — it is a hook, and the
 * panel it lives in returns several different bodies. Pass `undefined` while
 * the subject is unknown; that asks for nothing.
 *
 * WHY THIS CANNOT LOOP, stated plainly because the surrounding code was
 * written around exactly that hazard:
 *
 *  - The effect's key is the ANNOUNCED VERSION, not a boolean and not the
 *    detail. It re-runs when the node announces a version this client lacks,
 *    and at no other time.
 *  - A read that LANDS clears the mark (`ingestDetail`), so the key becomes
 *    undefined and the effect unsubscribes. One re-read per version bump.
 *  - A read that FAILS leaves the mark exactly as it was, so the key does not
 *    change and nothing re-fires. The entity is asked once per announced
 *    version even against a node that is refusing — the panel goes on
 *    rendering the content it holds rather than spinning or retrying.
 *  - Unmounting cancels a pending timer, so a panel closed during the settle
 *    never spends a request.
 */
export function useDetailFreshness(id: string | undefined): void {
  const { staleDetails, freshenDetail } = useContext(FreshnessContext);
  const staleVersion = id === undefined ? undefined : staleDetails?.[id];
  useEffect(() => {
    if (id === undefined || staleVersion === undefined || !freshenDetail) return;
    const timer = setTimeout(() => freshenDetail(id), FRESHEN_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [id, staleVersion, freshenDetail]);
}
