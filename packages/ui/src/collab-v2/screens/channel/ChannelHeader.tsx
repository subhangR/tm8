/**
 * Channel hub header — name · topic · who is here · who is working.
 *
 * Pure composition: the glyph/tint come from the kind registry, presence and
 * the working rollup are the live subsystem components, unread is a kit Pill.
 */
import { Pill, Timestamp } from '../../kit';
import { registryFor } from '../../registry';
import { PresenceAvatars, WorkingAggregate, useLiveEntity } from '../../subsystems/live';
import type { CollabFacade } from '../../facade/CollabFacade';
import type { EntityDetail } from '../../types/contract';
import { channelTopic, channelUnread, channelWorkingCount } from './projection';

export interface ChannelHeaderProps {
  detail: EntityDetail;
  facade: CollabFacade;
}

export function ChannelHeader({ detail, facade }: ChannelHeaderProps) {
  // The header tracks the live summary so unread/working move under the
  // simulation without this screen owning a single timer.
  const live = useLiveEntity(detail);
  const entry = registryFor(detail.kind);
  const topic = channelTopic(detail);
  const unread = channelUnread(live);
  const working = channelWorkingCount(live);

  return (
    <div className="cv2-hub__headrow">
      <span className="cv2-hub__glyph" style={{ color: entry.tint(live) }} aria-hidden="true">
        {entry.glyph}
      </span>
      <h1 className="cv2-hub__name">{detail.title}</h1>
      {topic && <p className="cv2-hub__topic" title={topic}>{topic}</p>}
      <span className="cv2-hub__headspace" />
      {unread > 0 && <Pill tone="brand" dot={false}>{unread} unread</Pill>}
      {/* A channel's recency is its most useful fact after its name, and the
          hub said nothing about it until now. */}
      <Timestamp className="cv2-hub__when" at={live.activityAt} prefix="active" title="last activity" />
      <PresenceAvatars entityId={detail.id} facade={facade} compact />
      <WorkingAggregate entity={live} count={working > 0 ? working : undefined} />
    </div>
  );
}
