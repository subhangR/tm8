/**
 * THE UNDO TOAST (Attention v2, chapter 3): one per shell, whichever surface
 * resolved. It shows for the 8s the server keeps a Resolve undoable, and shows
 * a command failure the same way. Renders nothing outside a provider, so a host
 * can mount it unconditionally.
 */
import { useAttentionOptional } from './attention-store';
import './attention-v2.css';

export function AttentionUndoToast() {
  const api = useAttentionOptional();
  if (!api || (!api.undo && !api.error)) return null;
  const { undo, error } = api;
  return (
    <div className="att-toast" role="status" aria-live="polite" data-testid="attention-toast">
      {undo ? (
        <>
          <span className="att-toast__text">Resolved.</span>
          <button
            type="button"
            className="att-toast__act"
            onClick={() => void api.unresolve(undo.batchId)}
            data-testid="attention-toast-undo"
          >
            Undo
          </button>
        </>
      ) : (
        <span className="att-toast__text att-toast__text--error">{error}</span>
      )}
    </div>
  );
}
