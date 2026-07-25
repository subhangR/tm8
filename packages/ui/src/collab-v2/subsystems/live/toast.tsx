/**
 * Toast slot — the moment channel. Deliberately a store, not a context, so a
 * badge deep inside a collection can announce an unblock without every host
 * remembering to wrap a provider (and so tests can assert on state directly).
 */
import { useEffect, type ReactNode } from 'react';
import { create } from 'zustand';
import type { EntityId } from '../../types/contract';

export type ToastKind = 'unblock' | 'stale' | 'success' | 'info' | 'error';

export interface ToastItem {
  id: string;
  kind: ToastKind;
  message: string;
  entityId?: EntityId;
  /** Auto-dismiss delay; 0 keeps it until dismissed. */
  ttlMs: number;
  seq: number;
}

export const TOAST_CAP = 4;
export const TOAST_TTL_MS = 5000;

let seq = 0;

export interface ToastState {
  toasts: ToastItem[];
  push: (t: Omit<ToastItem, 'id' | 'seq' | 'ttlMs'> & { ttlMs?: number }) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

export const useToastStore = create<ToastState>()((set) => ({
  toasts: [],

  push: (t) => {
    seq += 1;
    const id = `toast_${seq}`;
    const item: ToastItem = { ...t, id, seq, ttlMs: t.ttlMs ?? TOAST_TTL_MS };
    set((s) => ({ toasts: [...s.toasts, item].slice(-TOAST_CAP) }));
    return id;
  },

  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),

  clear: () => set({ toasts: [] }),
}));

/** Imperative helper for non-React callers (action executors, hooks). */
export function pushToast(t: Omit<ToastItem, 'id' | 'seq' | 'ttlMs'> & { ttlMs?: number }): string {
  return useToastStore.getState().push(t);
}

export interface ToastViewportProps {
  /** Render prop for hosts that want their own chrome. */
  renderToast?: (toast: ToastItem, dismiss: () => void) => ReactNode;
  className?: string;
}

/** Drop once near the app root; each toast self-expires on its ttl. */
export function ToastViewport({ renderToast, className }: ToastViewportProps) {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  useEffect(() => {
    const timers = toasts
      .filter((t) => t.ttlMs > 0)
      .map((t) => setTimeout(() => dismiss(t.id), t.ttlMs));
    return () => { for (const t of timers) clearTimeout(t); };
  }, [toasts, dismiss]);

  if (toasts.length === 0) return null;

  return (
    <div className={`cv2-toasts${className ? ` ${className}` : ''}`} role="region" aria-label="Notifications">
      {toasts.map((t) => (
        renderToast
          ? <div key={t.id}>{renderToast(t, () => dismiss(t.id))}</div>
          : (
            <div
              key={t.id}
              className="cv2-toast"
              data-kind={t.kind}
              data-testid={`toast-${t.kind}`}
              role="status"
            >
              <span className="cv2-toast__glyph" aria-hidden="true">
                {t.kind === 'unblock' ? '⛓️‍💥' : t.kind === 'stale' ? '⟳' : t.kind === 'error' ? '⚠' : '✓'}
              </span>
              <span className="cv2-toast__msg">{t.message}</span>
              <button
                type="button"
                className="cv2-toast__x"
                aria-label="Dismiss notification"
                onClick={() => dismiss(t.id)}
              >
                ×
              </button>
            </div>
          )
      ))}
    </div>
  );
}
