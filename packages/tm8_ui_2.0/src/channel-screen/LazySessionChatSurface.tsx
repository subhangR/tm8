import { lazy, Suspense } from 'react';
import type { SessionChatSurfaceProps } from './SessionChatSurface';

const SplitSessionChatSurface = lazy(async () => {
  const module = await import('./SessionChatSurface');
  return { default: module.SessionChatSurface };
});

/** The production route boundary; direct unit tests keep importing the module. */
export function LazySessionChatSurface(props: SessionChatSurfaceProps) {
  return (
    <Suspense
      fallback={(
        <div className="chs-host-loading" role="status">
          Loading Chat…
        </div>
      )}
    >
      <SplitSessionChatSurface {...props} />
    </Suspense>
  );
}
