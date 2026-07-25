/**
 * Inbox — the cross-space notification list.
 *
 * `getInbox` is space-agnostic by contract, so rows carry their own space and
 * the screen labels them from `listSpaces`. Clicking a row marks it read and
 * opens its target as a Z3 panel; read state is applied optimistically and
 * reconciled by the `notification.read` event.
 */
import { useEffect, useMemo, useState } from 'react';
import { Eyebrow } from '../../kit';
import { useAsyncValue, type ShellViewProps, type ViewRegistry } from '../../shell';
import { pushToast } from '../../subsystems/live';
import type { NotificationItem } from '../../types/contract';
import { NotificationRow } from './NotificationRow';

export function InboxScreen({ facade, spaceId, onOpenEntity }: ShellViewProps) {
  const [nonce, setNonce] = useState(0);
  const [readIds, setReadIds] = useState<Set<string>>(() => new Set());
  const [unreadOnly, setUnreadOnly] = useState(false);

  useEffect(() => facade.subscribe(spaceId, (event) => {
    if (event.type === 'notification.created' || event.type === 'notification.read') {
      setNonce((n) => n + 1);
    }
  }), [facade, spaceId]);

  const { value, loading } = useAsyncValue(() => facade.getInbox(), [facade, nonce]);
  const spaces = useAsyncValue(() => facade.listSpaces(), [facade]);

  const spaceNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const s of spaces.value ?? []) map[s.id] = s.name;
    return map;
  }, [spaces.value]);

  const items = value?.items ?? [];
  const isRead = (n: NotificationItem): boolean => n.readAt != null || readIds.has(n.id);
  const visible = unreadOnly ? items.filter((n) => !isRead(n)) : items;
  const unreadCount = items.filter((n) => !isRead(n)).length;

  const markRead = async (item: NotificationItem): Promise<void> => {
    if (isRead(item)) return;
    setReadIds((prev) => new Set(prev).add(item.id));
    try {
      await facade.markNotificationRead(item.id);
    } catch (e) {
      setReadIds((prev) => {
        const next = new Set(prev);
        next.delete(item.id);
        return next;
      });
      pushToast({ kind: 'error', message: `Couldn't mark read — ${(e as Error).message}` });
    }
  };

  const activate = (item: NotificationItem): void => {
    void markRead(item);
    if (item.target) onOpenEntity(item.target.id);
  };

  const markAllRead = async (): Promise<void> => {
    const unread = items.filter((n) => !isRead(n));
    if (unread.length === 0) return;
    setReadIds((prev) => {
      const next = new Set(prev);
      for (const n of unread) next.add(n.id);
      return next;
    });
    await Promise.all(unread.map((n) => facade.markNotificationRead(n.id).catch(() => undefined)));
    setNonce((n) => n + 1);
  };

  return (
    <div className="cv2-inbox" data-testid="view-inbox">
      <header className="cv2-inbox__header">
        <Eyebrow>inbox</Eyebrow>
        <h1 className="cv2-inbox__h1">Notifications</h1>
        <div className="cv2-inbox__tools">
          <span className="cv2-inbox__unreadcount" data-testid="inbox-unread">{unreadCount} unread</span>
          <button
            type="button"
            className="cv2-inbox__chip"
            aria-pressed={unreadOnly}
            data-active={unreadOnly ? 'true' : undefined}
            onClick={() => setUnreadOnly((u) => !u)}
          >
            unread only
          </button>
          <button
            type="button"
            className="cv2-inbox__chip"
            data-testid="mark-all-read"
            disabled={unreadCount === 0}
            onClick={() => void markAllRead()}
          >
            mark all read
          </button>
        </div>
      </header>

      {loading && items.length === 0 && (
        <div className="cv2-inbox__loading" role="status">loading…</div>
      )}

      {!loading && visible.length === 0 && (
        <div className="cv2-inbox__empty" role="status">
          <div className="cv2-inbox__emptyglyph" aria-hidden="true">◇</div>
          <p>{unreadOnly ? 'nothing unread — you are caught up.' : 'no notifications yet.'}</p>
        </div>
      )}

      <ol className="cv2-inbox__rows">
        {visible.map((item) => (
          <NotificationRow
            key={item.id}
            item={item}
            read={isRead(item)}
            spaceName={spaceNames[item.spaceId]}
            onActivate={activate}
            onOpenEntity={onOpenEntity}
          />
        ))}
      </ol>
    </div>
  );
}

/** ViewRegistry fragment — the shell composes screen fragments into `views`. */
export const inboxViews: ViewRegistry = { inbox: InboxScreen };
