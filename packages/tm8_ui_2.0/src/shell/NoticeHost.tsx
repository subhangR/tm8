/**
 * NoticeHost (LLD §4.3) — the single home for R4-7 overflow notices, command
 * failures, and demotion notices.
 *
 * T1-4 behavior, binding: bottom-center, 6s, **never stacks**. Pushing a notice
 * whose id is already live REPLACES it, so a resize storm that demotes three
 * times shows one card with the current count rather than three cards.
 *
 * `aria-live="polite"` (C8): these are consequences of the viewer's own action
 * and must be announced without stealing focus.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Notice } from './notices';

export interface NoticeHostHandle {
  push(notice: Notice): void;
  dismiss(id: string): void;
}

export function useNotices(): NoticeHostHandle & { notices: Notice[] } {
  const [notices, setNotices] = useState<Notice[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setNotices((current) => current.filter((notice) => notice.id !== id));
  }, []);

  const push = useCallback(
    (notice: Notice) => {
      // Replace-by-id: the aggregate-into-one-card rule.
      const existing = timers.current.get(notice.id);
      if (existing) clearTimeout(existing);
      setNotices((current) => [...current.filter((n) => n.id !== notice.id), notice]);
      timers.current.set(
        notice.id,
        setTimeout(() => dismiss(notice.id), notice.ttlMs),
      );
    },
    [dismiss],
  );

  // Clearing timers on unmount keeps StrictMode's double-mount from leaving a
  // dangling setState behind.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach(clearTimeout);
      pending.clear();
    };
  }, []);

  return { notices, push, dismiss };
}

export interface NoticeHostProps {
  notices: readonly Notice[];
  onDismiss(id: string): void;
}

export function NoticeHost({ notices, onDismiss }: NoticeHostProps) {
  return (
    <div className="shell-notices" role="status" aria-live="polite" data-testid="notice-host">
      {notices.map((notice) => (
        <div key={notice.id} className={`shell-notice shell-notice--${notice.tone}`}>
          <span className="shell-notice__glyph" aria-hidden="true">
            ◬
          </span>
          <div className="shell-notice__text">
            <span className="shell-notice__title">{notice.title}</span>
            <span className="shell-notice__body">{notice.body}</span>
          </div>
          <button
            type="button"
            className="shell-notice__dismiss"
            onClick={() => onDismiss(notice.id)}
          >
            dismiss
          </button>
        </div>
      ))}
    </div>
  );
}
