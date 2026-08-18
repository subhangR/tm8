/**
 * The conversation surface for the `chatSurface` slot, composed ONCE for every
 * host that mounts an `EntityDetailPanel` — the same shape, and for the same
 * reason, as `graphSurfaceFor` and `debugSurfaceFor`.
 *
 * `EntityDetailPanel.chatSurface` is an opaque slot the panel cannot fill for
 * itself; each host must build the surface. EntityView and WorkspaceView each
 * hand-rolled the same archetype fork, and the three hosts that never copied
 * it (ChannelView, GraphScreen, AuxEntityPanel) shipped panels whose Chat tab
 * was the "feed host is unavailable" alert — or, for a hub, nothing at all.
 * The composition lives here and a host opts in with one call.
 *
 * PARAMETERISED BY SURFACE, not hardcoded to chat: the slot is contested by
 * three efforts (session chat, a Discussion-tab conversation surface, a
 * session Transcript surface), so WHICH surface is composed is an explicit
 * kind with its own composer below. Today two exist; a future 'transcript' or
 * 'discussion' adds a composer and a resolver arm, never a sixth hand-rolled
 * mount. The panel prop keeps its `chatSurface` name until the pending naming
 * ruling on whether 'Chat' survives on the session panel — the prop rename is
 * that ruling's, not this file's.
 *
 * The default choice stays on ARCHETYPE, a registry field, never on kind
 * (§15.2): `hub` entities get their channel feed, everything else with a
 * detail gets the session chat.
 */
import type { ReactNode } from 'react';
import type { ComposerInteractionPolicy, EntityDetail, EntityId } from '@tm8/contract';
import { getKind } from '../domain';
import { QUIET_SESSION_DETAIL, needsAttentionOf } from '../domain/needs-attention';
import { LazyChannelChatSurface } from '../channel-screen/LazyChannelChatSurface';
import { LazySessionChatSurface } from '../channel-screen/LazySessionChatSurface';
import type { SessionChatSeam } from '../channel-screen/SessionChatSurface';
import type { ChannelFeedPort } from '../channel-screen/useChannelFeed';
import type { ConnectionState, SessionLiveness } from '../data/seam';

/** The surfaces this slot can compose. Open by design — 'transcript' and
 *  'discussion' are expected entrants; each gets its own composer. */
export type ConversationSurfaceKind = 'channel-feed' | 'session-chat';

/**
 * What a host must already own to fill the slot. Every member is something the
 * five hosts each build for their other panel props anyway — nothing here
 * exists only for this slot.
 */
export interface ConversationSurfaceHost {
  seam: SessionChatSeam;
  spaceId: string;
  connection: ConnectionState;
  livenessOf(id: string): SessionLiveness;
  channelFeedPort: ChannelFeedPort;
  viewerMemberId?: string | null | undefined;
  /** Opening an entity from the feed lands wherever this host reads sideways. */
  onOpenEntity(id: EntityId): void;
  /** The session surface's way back to the terminal — a REAL handler; the
   *  no-op ban's reasoning applies (see no-op-handler-ban.test.ts). */
  onSwitchToTerminal(): void;
}

/** The registry's default surface for an entity: hub → its channel feed,
 *  everything else → the session chat. */
export function defaultConversationSurfaceKind(detail: EntityDetail): ConversationSurfaceKind {
  return getKind(detail.kind).panel.archetype === 'hub' ? 'channel-feed' : 'session-chat';
}

export function channelFeedSurfaceFor(
  detail: EntityDetail,
  entityId: EntityId,
  host: ConversationSurfaceHost,
): ReactNode {
  const kindRow = getKind(detail.kind);
  return (
    <LazyChannelChatSurface
      port={host.channelFeedPort}
      channelId={entityId}
      connection={host.connection}
      onOpenEntity={host.onOpenEntity}
      threads={kindRow.panel.threads === true}
      anchorTitle={`${kindRow.chip.glyph}${detail.title}`}
      viewerMemberId={host.viewerMemberId}
    />
  );
}

export function sessionChatSurfaceFor(
  detail: EntityDetail,
  entityId: EntityId,
  host: ConversationSurfaceHost,
): ReactNode {
  const recordedStatus = (detail.state as unknown as { status?: string } | undefined)?.status;
  const content = detail.content as unknown as {
    interactionProfile?: {
      feedPolicy?: { pageSize?: number };
      composerPolicy?: ComposerInteractionPolicy | null;
    } | null;
  };
  return (
    <LazySessionChatSurface
      seam={host.seam}
      sessionId={entityId}
      spaceId={host.spaceId}
      viewerMemberId={host.viewerMemberId ?? 'anonymous'}
      connection={host.connection}
      sessionExited={recordedStatus === 'exited' || recordedStatus === 'failed'}
      defaultLimit={content.interactionProfile?.feedPolicy?.pageSize}
      composerPolicy={content.interactionProfile?.composerPolicy}
      needsAttention={needsAttentionOf(detail, host.livenessOf)}
      attentionDetail={QUIET_SESSION_DETAIL}
      onOpenEntity={host.onOpenEntity}
      onSwitchToTerminal={host.onSwitchToTerminal}
    />
  );
}

export function conversationSurfaceFor(
  detail: EntityDetail | null | undefined,
  entityId: EntityId,
  host: ConversationSurfaceHost,
  surface?: ConversationSurfaceKind,
): ReactNode | undefined {
  if (!detail) return undefined;
  switch (surface ?? defaultConversationSurfaceKind(detail)) {
    case 'channel-feed':
      return channelFeedSurfaceFor(detail, entityId, host);
    case 'session-chat':
      return sessionChatSurfaceFor(detail, entityId, host);
  }
}
