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

export function channelFeedPortFromGateData(data: GateData): ChannelFeedPort {
  return {
    seam: data.seam,
    spaceId: data.spaceId,
    liveIds: data.liveIds,
    postMessage: data.postMessage as ChannelFeedPort['postMessage'],
    spawn: data.spawn as unknown as ChannelFeedPort['spawn'],
    projects: data.launch.projects,
  };
}
