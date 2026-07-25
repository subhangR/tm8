/**
 * Compact activity column — the space's `ActivityItem` stream.
 *
 * ActivityItems are not entities, so the row is screen chrome; every *entity*
 * it references renders as a real `ChipById` (Z1) and every actor as the kit
 * Avatar. Verbs are formatted, never branched on.
 */
import { useEffect, useState } from 'react';
import { ChipById } from '../../entity';
import type { CollabFacade } from '../../facade/CollabFacade';
import { Avatar, Eyebrow } from '../../kit';
import { relTime } from '../../registry';
import { useAsyncValue } from '../../shell';
import type { ActivityItem, SpaceId } from '../../types/contract';

export interface ActivityFeedProps {
  facade: CollabFacade;
  spaceId: SpaceId;
  limit?: number;
}

function ActivityRow({ item }: { item: ActivityItem }) {
  return (
    <li className="cv2-home__act" data-verb={item.verb}>
      {item.actor
        ? <Avatar actor={item.actor} size={20} />
        : <span className="cv2-home__actdot" aria-hidden="true">·</span>}
      <span className="cv2-home__actbody">
        <span className="cv2-home__actwho">{item.actor?.displayName ?? 'someone'}</span>
        {' '}
        <span className="cv2-home__actverb">{item.verb.replace(/_/g, ' ')}</span>
        {item.entityId && <> <ChipById entityId={item.entityId} /></>}
      </span>
      <time className="cv2-home__acttime" dateTime={item.createdAt}>{relTime(item.createdAt)}</time>
    </li>
  );
}

export function ActivityFeed({ facade, spaceId, limit = 20 }: ActivityFeedProps) {
  const [nonce, setNonce] = useState(0);
  useEffect(() => facade.subscribe(spaceId, (event) => {
    if (event.type === 'activity.created' || event.type === 'message.created') {
      setNonce((n) => n + 1);
    }
  }), [facade, spaceId]);

  const { value, loading } = useAsyncValue(
    () => facade.getSpaceActivity(spaceId),
    [facade, spaceId, nonce],
  );
  const items = (value?.items ?? []).slice(0, limit);

  return (
    <aside className="cv2-home__feed" data-testid="home-activity" aria-label="Recent activity">
      <header className="cv2-home__colhead">
        <Eyebrow>recent activity</Eyebrow>
      </header>
      {loading && items.length === 0 && <div className="cv2-home__loading" role="status">loading…</div>}
      <ol className="cv2-home__acts">
        {items.map((item) => <ActivityRow key={item.id} item={item} />)}
      </ol>
    </aside>
  );
}
