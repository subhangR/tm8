import { lazy, Suspense } from 'react';
import type { ChannelScreenProps } from './ChannelScreen';

const SplitChannelScreen = lazy(async () => {
  const module = await import('./ChannelScreen');
  return { default: module.ChannelScreen };
});

export function LazyChannelScreen(props: ChannelScreenProps) {
  return (
    <Suspense fallback={<div className="chs-host-loading" role="status">Loading Chat…</div>}>
      <SplitChannelScreen {...props} />
    </Suspense>
  );
}
