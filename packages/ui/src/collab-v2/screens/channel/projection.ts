/**
 * Channel route projection — the four facts the hub chrome reads off the
 * facade's own channel projection (topic, pinned shelf, unread, working count).
 *
 * These are NOT kind branches. The `channel` route is anchored on a channel by
 * construction (`ShellViewProps.entityId` comes from the left-rail channel tree
 * and the `#/s/{space}/e/{channelId}` hash), so the discriminated arm is a
 * route invariant. Every accessor is written as an optional read with a
 * fallback, so a mis-routed id degrades to an empty hub instead of throwing —
 * and the screen never grows an `if (kind === …)`.
 *
 * The tab strip deliberately does NOT come from here: it comes from
 * `facade.getChannelTabs()` (see `useChannelTabs`), because the facade's
 * auto-tab projection IS the source of truth for what tabs exist.
 */
import type {
  EntityContent, EntityDetail, EntityState, EntitySummary,
} from '../../types/contract';

type ChannelState = Extract<EntityState, { kind: 'channel' }>;
type ChannelContent = Extract<EntityContent, { kind: 'channel' }>;

function stateOf(entity: EntitySummary | null | undefined): Partial<ChannelState> {
  return (entity?.state as ChannelState | undefined) ?? {};
}

function contentOf(detail: EntityDetail | null | undefined): Partial<ChannelContent> {
  return (detail?.content as ChannelContent | undefined) ?? {};
}

/** Channel topic — the one-line subject rendered next to the name. */
export function channelTopic(detail: EntityDetail | null | undefined): string {
  return contentOf(detail).topic ?? stateOf(detail).topic ?? '';
}

/** The pinned Shelf: `attached_to` edges carrying `props.pinned`, projected. */
export function channelShelf(detail: EntityDetail | null | undefined): EntitySummary[] {
  return contentOf(detail).pinned ?? [];
}

/** Unread count for the viewer, from the live summary state. */
export function channelUnread(entity: EntitySummary | null | undefined): number {
  return stateOf(entity).unreadCount ?? 0;
}

/** Agents currently working in this channel (the header's live rollup). */
export function channelWorkingCount(entity: EntitySummary | null | undefined): number {
  return stateOf(entity).workingAgentCount ?? 0;
}
