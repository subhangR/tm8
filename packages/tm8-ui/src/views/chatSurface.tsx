/**
 * ONE SLOT, TWO SURFACES, CHOSEN BY ARCHETYPE — for EVERY host, not two of five.
 *
 * `EntityDetailPanel.chatSurface` is an opaque slot the panel cannot fill for
 * itself; each host must build the surface. EntityView and WorkspaceView each
 * hand-rolled the same archetype fork, and the three hosts that never copied it
 * (ChannelView, GraphScreen, AuxEntityPanel) shipped panels whose Chat tab was
 * the "feed host is unavailable" alert — or, for a hub, nothing at all. The
 * fork lives here once so a host can only choose whether to wire chat, never
 * how.
 *
 * The choice stays on ARCHETYPE, a registry field, never on kind (§15.2):
 * `hub` entities get their channel feed, everything else with a detail gets
 * the session chat.
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

/**
 * What a host must already own to fill the slot. Every member is something the
 * five hosts each build for their other panel props anyway — nothing here
 * exists only for chat.
 */
export interface ChatSurfaceHost {
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

export function chatSurfaceFor(
  detail: EntityDetail | null | undefined,
  entityId: EntityId,
  host: ChatSurfaceHost,
): ReactNode | undefined {
  if (!detail) return undefined;
  const kindRow = getKind(detail.kind);
  if (kindRow.panel.archetype === 'hub') {
    return (
      <LazyChannelChatSurface
        port={host.channelFeedPort}
        channelId={entityId}
        connection={host.connection}
        onOpenEntity={host.onOpenEntity}
        threads={kindRow.panel.threads === true}
        anchorTitle={`${kindRow.chip.glyph}${detail.title}`}
      />
    );
  }
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
