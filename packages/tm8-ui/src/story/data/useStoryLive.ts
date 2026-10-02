/**
 * React binding for `story-live-controller`: the story page's view, kept live.
 *
 *   const { view, live } = useStoryLive(seam, storyId);
 *   <StoryPage view={view} actions={actions} live={live} />
 *
 * `view` is null until the first read lands (and stays the last good view
 * when a later read fails — `error` says so). `live` is exactly the
 * `StoryLive` the blocks read (props.ts).
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { EntityId } from '@tm8/contract';
import type { Seam } from '../../data/seam';
import type { StoryView } from '../model';
import type { StoryLive } from '../props';
import { createStoryLiveController, type StoryLiveController, type StoryLiveSnapshot } from './story-live-controller';

export interface UseStoryLiveResult {
  view: StoryView | null;
  live: StoryLive;
  loading: boolean;
  error: Error | null;
  /** Re-read now (e.g. after a write whose event has not arrived). */
  refresh: () => Promise<void>;
  /** Every id in the story as of the last read (story, nodes, child stories, feed anchors). */
  membership: ReadonlySet<string>;
}

const IDLE: StoryLiveSnapshot = {
  view: null,
  loading: true,
  error: null,
  landed: new Set(),
  paused: false,
  queued: 0,
  updatesLastMinute: 0,
  connection: 'connecting',
};
const noSubscribe = (): (() => void) => () => undefined;
const idleSnapshot = (): StoryLiveSnapshot => IDLE;
const EMPTY_SET: ReadonlySet<string> = new Set();

export function useStoryLive(seam: Seam, storyId: EntityId): UseStoryLiveResult {
  const [controller, setController] = useState<StoryLiveController | null>(null);

  useEffect(() => {
    const c = createStoryLiveController({ seam, storyId });
    const detach = c.attach();
    setController(c);
    return () => {
      detach();
      c.dispose();
      setController((cur) => (cur === c ? null : cur));
    };
  }, [seam, storyId]);

  const snap = useSyncExternalStore(
    controller ? controller.subscribe : noSubscribe,
    controller ? controller.getSnapshot : idleSnapshot,
  );

  const live = useMemo<StoryLive>(() => ({
    status: snap.paused
      ? 'paused'
      : snap.connection === 'live' || snap.connection === 'polling'
        ? 'live'
        : 'reconnecting',
    paused: snap.paused,
    setPaused: (p: boolean) => controller?.setPaused(p),
    queued: snap.queued,
    updatesLastMinute: snap.updatesLastMinute,
    landed: snap.landed,
  }), [snap, controller]);

  return {
    view: snap.view,
    live,
    loading: snap.loading,
    error: snap.error,
    refresh: () => controller?.refresh() ?? Promise.resolve(),
    membership: controller?.membership() ?? EMPTY_SET,
  };
}
