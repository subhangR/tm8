import { lazy, Suspense } from 'react';
import type { TranscriptSurfaceProps } from './TranscriptSurface';

const SplitTranscriptSurface = lazy(async () => {
  const module = await import('./TranscriptSurface');
  return { default: module.TranscriptSurface };
});

/** The production route boundary; direct unit tests keep importing the module. */
export function LazyTranscriptSurface(props: TranscriptSurfaceProps) {
  return (
    <Suspense
      fallback={(
        <div className="tr-surface__state" role="status">
          Loading Transcript…
        </div>
      )}
    >
      <SplitTranscriptSurface {...props} />
    </Suspense>
  );
}
