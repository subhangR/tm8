/**
 * `GateData` → `ChannelFeedPort`, in one place.
 *
 * The hook takes a narrow port rather than `GateData` so `channel-screen/`
 * keeps pointing away from `views/`. This adapter is the seam where the wide
 * host object becomes that narrow slice, and it lives on the `views/` side —
 * the side that already knows what `GateData` is.
 *
 * Memoized by the caller on `data`, so the port identity is stable and the
 * hook's effects do not re-run on every render of the host.
 */
import type { ChannelFeedPort } from '../channel-screen/useChannelFeed';
import type { GateData } from './useGateData';

/**
 * `viewerMemberId` is a SECOND ARGUMENT rather than a field read off `GateData`,
 * because `GateData` does not carry it — every host receives the viewer from
 * its own props. It is what keys persisted drafts and the mutation journal, so
 * a host that omits it does not fail loudly; it quietly shares one draft slot
 * between whoever is signed in. Passing it is the point of this parameter
 * existing at all.
 */
export function channelFeedPortFromGateData(
  data: GateData,
  viewerMemberId?: string | null,
): ChannelFeedPort {
  return {
    seam: data.seam,
    spaceId: data.spaceId,
    ...(viewerMemberId ? { viewerMemberId } : {}),
    liveIds: data.liveIds,
    postMessage: data.postMessage as ChannelFeedPort['postMessage'],
    spawn: data.spawn as unknown as ChannelFeedPort['spawn'],
    projects: data.launch.projects,
  };
}
