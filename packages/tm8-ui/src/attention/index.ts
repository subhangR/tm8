/**
 * `src/attention/` — the ONE UI owner of attention (Attention v2, chapter 5).
 * Surfaces import from here: the provider and hooks, the selectors' types,
 * and the shared components. Nothing else in the UI talks to the attention API.
 */
export {
  AttentionApiProvider,
  AttentionProvider,
  useAttention,
  useAttentionOptional,
} from './attention-store';
export type { AttentionApi, AttentionEntityRef, AttentionProviderProps } from './attention-store';
export type {
  AttentionChip,
  AttentionCounts,
  AttentionFilter,
  AttentionQueueRow,
} from './attention-selectors';
export { formatAge, PENDING_STATUSES } from './attention-selectors';
export { UNDO_WINDOW_MS } from './attention-commands';
export type { AttentionSeam, AttentionUndo } from './attention-commands';
export { AttentionUndoToast } from './AttentionUndoToast';
