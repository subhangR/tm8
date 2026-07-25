/**
 * Channel Hub — the `channel` center view (UX brief §7).
 *
 *   header (name · topic · presence · working rollup)
 *   shelf  (pinned entity cards)
 *   tabs   (Feed + the facade's auto-tabs)
 *   pane   (Thread feed w/ living embeds + composer, or a CollectionView)
 *
 * "Put tasks and team members into a channel" is not a feature: it is
 * `attached_to` edges + the auto-tab projection + embeds. This screen composes,
 * it never derives.
 */
import { EntityPanelSkeleton } from '../../entity';
import { useAsyncValue, type ShellViewProps } from '../../shell';
import { ChannelHeader } from './ChannelHeader';
import { ChannelHubBody } from './ChannelHubBody';
import { useChannelDetail } from './useChannelData';
import type { EntityId } from '../../types/contract';

export function ChannelHub({ facade, spaceId, entityId, onOpenEntity }: ShellViewProps) {
  // The rail routes here with the channel id; a bare `#/s/{space}/channel`
  // (or a `g`-chord) lands on the space's first channel.
  const { value: navigation } = useAsyncValue(
    () => facade.getNavigation(spaceId),
    [facade, spaceId],
  );
  const channelId = entityId ?? navigation?.channels[0]?.entity.id ?? null;

  if (!channelId) {
    return (
      <div className="cv2-hub cv2-hub--loading" data-testid="view-channel">
        <EntityPanelSkeleton />
      </div>
    );
  }
  // Keyed so switching channels remounts the hub (fresh tab selection, fresh
  // thread) instead of bleeding the previous channel's state across.
  return (
    <ChannelHubRoute
      key={channelId}
      facade={facade}
      channelId={channelId}
      onOpenEntity={onOpenEntity}
    />
  );
}

function ChannelHubRoute({ facade, channelId, onOpenEntity }: {
  facade: ShellViewProps['facade'];
  channelId: EntityId;
  onOpenEntity: ShellViewProps['onOpenEntity'];
}) {
  const { value: detail } = useChannelDetail(facade, channelId);

  if (!detail) {
    return (
      <div className="cv2-hub cv2-hub--loading" data-testid="view-channel">
        <EntityPanelSkeleton />
      </div>
    );
  }

  return (
    <div className="cv2-hub" data-testid="view-channel" data-channel={channelId}>
      <header className="cv2-hub__head">
        <ChannelHeader detail={detail} facade={facade} />
      </header>
      <ChannelHubBody detail={detail} onOpenEntity={(id) => onOpenEntity(id)} />
    </div>
  );
}
