/**
 * Notification kind presentation — DATA, not code paths.
 *
 * Same discipline as the KindRegistry: a notification kind is a table row
 * (label + pill tone), so adding a kind is adding an entry and an unknown kind
 * degrades gracefully instead of falling through a conditional.
 */
import type { PillTone } from '../../kit';

export interface NotificationKindSpec {
  label: string;
  tone: PillTone;
}

export const NOTIFICATION_KINDS: Record<string, NotificationKindSpec> = {
  mention: { label: 'mention', tone: 'brand' },
  assignment: { label: 'assignment', tone: 'open' },
  award: { label: 'award', tone: 'done' },
  unblock: { label: 'unblock', tone: 'working' },
  review_request: { label: 'review', tone: 'review' },
  stale: { label: 'stale', tone: 'stale' },
};

export function specForNotification(kind: string): NotificationKindSpec {
  return NOTIFICATION_KINDS[kind] ?? { label: kind.replace(/_/g, ' '), tone: 'neutral' };
}
