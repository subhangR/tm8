/**
 * ADDITIVE (W1-F): "focus this draft's first field" (Spec A §16).
 *
 * A fresh draft focuses itself on mount. A `drafts.open` that REUSES a draft
 * may not remount it — and when the draft is already active at index 0 the
 * commit changes nothing, so no effect fires. The reuse path therefore posts
 * this signal as a post-commit step (which runs whether or not state changed),
 * and the mounted draft host listens for its own tab id.
 */
import type { TabId } from './types';

const listeners = new Set<(tabId: TabId) => void>();

export function requestDraftFocus(tabId: TabId): void {
  for (const listener of listeners) listener(tabId);
}

export function onDraftFocusRequest(listener: (tabId: TabId) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
