import { lazy, Suspense } from 'react';
import type { ChannelChatSurfaceProps } from './ChannelChatSurface';

const SplitChannelChatSurface = lazy(async () => {
  const module = await import('./ChannelChatSurface');
  return { default: module.ChannelChatSurface };
});

/** Same split point as the session chat: the composer and feed are the heavy
    half of this package and a panel that never opens a channel never pays. */
export function LazyChannelChatSurface(props: ChannelChatSurfaceProps) {
  return (
    <Suspense fallback={<div className="chs-host-loading" role="status">Loading Chat…</div>}>
      <SplitChannelChatSurface {...props} />
    </Suspense>
  );
}
