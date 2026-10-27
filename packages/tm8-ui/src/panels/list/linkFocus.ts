import { useSyncExternalStore } from 'react';

/**
 * WHICH GROUP THE COUNTS LINE ASKED FOR — a one-shot request from a list row
 * to the side column's Links section (design doc 01a1465d §6: "clicking a
 * count opens that group in the detail panel").
 *
 * WHY A TRANSIENT STORE AND NOT `TabUi`. The obvious home is the tab record —
 * `ui.chat.section` already lives there — and it is the wrong one. `TabUi` is
 * PERSISTED (`contract/workspace/stored.ts` re-hydrates it on every reload)
 * and this is a request, not a preference: a reader who clicked `📄2` on
 * Tuesday has not asked for the Docs filter again on Wednesday. Persisting it
 * would also make the five groups a contract-level vocabulary, which is the
 * cross-package bump the design doc parks under its own risk 6.
 *
 * ONE-SHOT, AND THE CONSUMER CLEARS IT. `take()` returns the request and
 * forgets it, so a reader who then clears the chip by hand is not fighting a
 * filter that reapplies on every render. The entity id rides along so a stale
 * request cannot land on a DIFFERENT entity's links when two rows are clicked
 * in quick succession.
 *
 * Module state, not context: the asker is a list tile in one column and the
 * reader is the side panel in another, with the whole workspace shell between
 * them. A provider spanning both would be the shell, and the shell has no
 * business knowing what a count badge is.
 */
export interface LinkFocusRequest {
  entityId: string;
  /** The registry kind the group names (`doc`, `pull_request`, `artifact`, …). */
  kind: string;
  /** Monotonic, so a second click on the SAME group is still a new request. */
  seq: number;
}

let current: LinkFocusRequest | null = null;
let seq = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function requestLinkFocus(entityId: string, kind: string): void {
  seq += 1;
  current = { entityId, kind, seq };
  emit();
}

/** The pending request for this entity, consumed. Null for anyone else's. */
export function takeLinkFocus(entityId: string): LinkFocusRequest | null {
  if (current === null || current.entityId !== entityId) return null;
  const taken = current;
  current = null;
  emit();
  return taken;
}

/** Read without consuming — the subscription the side panel renders from. */
export function useLinkFocus(): LinkFocusRequest | null {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => null,
  );
}

/** Test seam: forget any pending request between cases. */
export function resetLinkFocus(): void {
  current = null;
  emit();
}
