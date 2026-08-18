/**
 * The conversation surface for the `conversationSurface` slot, composed ONCE for every
 * host that mounts an `EntityDetailPanel` — the same shape, and for the same
 * reason, as `graphSurfaceFor` and `debugSurfaceFor`.
 *
 * `EntityDetailPanel.conversationSurface` is an opaque slot the panel cannot fill for
 * itself; each host must build the surface. EntityView and WorkspaceView each
 * hand-rolled the same archetype fork, and the three hosts that never copied
 * it (ChannelView, GraphScreen, AuxEntityPanel) shipped panels whose Chat tab
 * was the "feed host is unavailable" alert — or, for a hub, nothing at all.
 * The composition lives here and a host opts in with one call.
 *
 * PARAMETERISED BY SURFACE, not hardcoded to one: WHICH surface is composed is
 * an explicit kind with its own composer below. Three exist — a channel feed,
 * the session chat, and the session Transcript that now holds the session
 * panel's slot; a future 'discussion' adds a composer and a resolver arm, never
 * a sixth hand-rolled mount.
 *
 * The panel prop was `chatSurface` while that name was still contested. The
 * naming ruling landed — 'Chat' retires from the session panel and survives for
 * actual chat threads — so the prop is `conversationSurface`, named for the
 * SLOT rather than any one occupant. That is what let the session panel repoint
 * from chat to transcript without a single host changing.
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
import { DiscussionSurface } from '../channel-screen/DiscussionSurface';
import { LazyTranscriptSurface } from '../transcript/LazyTranscriptSurface';
import type { SessionChatSeam } from '../channel-screen/SessionChatSurface';
import type { TranscriptSeam } from '../transcript/TranscriptSurface';
import type { ChannelFeedPort } from '../channel-screen/useChannelFeed';
import type { ConnectionState, SessionLiveness } from '../data/seam';

/** The surfaces this slot can compose. All four expected entrants have now
 *  landed, each with its own composer and one resolver arm. */
export type ConversationSurfaceKind =
  | 'channel-feed'
  | 'session-chat'
  | 'discussion'
  | 'transcript';

/**
 * What a host must already own to fill the slot. Every member is something the
 * five hosts each build for their other panel props anyway — nothing here
 * exists only for this slot.
 */
export interface ConversationSurfaceHost {
  /** Widened when the transcript arm landed: the same gate seam every host
   *  already passes, now named for both surfaces that read from it. */
  seam: SessionChatSeam & TranscriptSeam;
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

/**
 * The registry's default surface for an entity: hub → its channel feed,
 * everything else → the session TRANSCRIPT.
 *
 * The non-hub arm used to be `'session-chat'`, which read the graph's message
 * feed for the session. Per Subhang's ruling the session panel shows the
 * agent's own transcript instead, and the graph conversation moves to the
 * Discussion tab where it is not competing with the agent's words.
 * `'session-chat'` stays in the union: it is still what a host can ask for
 * explicitly, and deleting a composer is a separate change from changing a
 * default.
 */
export function defaultConversationSurfaceKind(detail: EntityDetail): ConversationSurfaceKind {
  return getKind(detail.kind).panel.archetype === 'hub' ? 'channel-feed' : 'transcript';
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

/**
 * THE DISCUSSION TAB'S CONVERSATION — one surface, over `entities.feed` with NO
 * SCOPE, on the tab every entity already has.
 *
 * `anchorNoun` and `anchorTitle` are the only per-kind values here, and both
 * come from REGISTRY DATA rather than a kind branch. The feed itself is
 * kind-blind: the server resolves the reading from the anchor's kind
 * (`feed-context.ts:176`), which is exactly why this composes once for a task,
 * a doc, a channel and a session alike.
 *
 * `panel.threads` decides whether the branch pane is OFFERED. The capability
 * exists on every anchor; `registry.ts:894-901` rules that a session keeps its
 * flat, replies-inline read while a channel takes threads.
 */
export function discussionSurfaceFor(
  detail: EntityDetail,
  entityId: EntityId,
  host: ConversationSurfaceHost,
): ReactNode {
  const kindRow = getKind(detail.kind);
  return (
    <DiscussionSurface
      // The branch read rides the channel feed port's seam, the one slice of a
      // host's bundle that already carries `messages`.
      seam={{ ...host.seam, messages: host.channelFeedPort.seam.messages }}
      anchorId={entityId}
      anchorNoun={`this ${kindRow.label.toLowerCase()}`}
      anchorTitle={`${kindRow.chip.glyph}${detail.title}`}
      spaceId={host.spaceId}
      viewerMemberId={host.viewerMemberId ?? 'anonymous'}
      connection={host.connection}
      threads={kindRow.panel.threads === true}
      canPost={detail.capabilities.canEdit || detail.capabilities.canReact}
      onOpenEntity={host.onOpenEntity}
    />
  );
}

/**
 * THE TRANSCRIPT ARM — `execution.transcript` rendered as a conversation.
 *
 * It needs strikingly little from the host compared to the other three arms,
 * and that is the point rather than an accident: the transcript is a file the
 * node reads off disk, so there is no feed port, no viewer identity, no
 * composer policy and no scope. The surface self-fetches through the seam
 * exactly as `SessionDebugBody` does, with the same hook.
 */
export function transcriptSurfaceFor(
  _detail: EntityDetail,
  entityId: EntityId,
  host: ConversationSurfaceHost,
): ReactNode {
  return (
    <LazyTranscriptSurface
      seam={host.seam}
      sessionId={entityId}
      liveness={host.livenessOf(entityId)}
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
    case 'discussion':
      return discussionSurfaceFor(detail, entityId, host);
    case 'transcript':
      return transcriptSurfaceFor(detail, entityId, host);
  }
}
