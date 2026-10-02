/**
 * The story page's HOSTS — the two ways a panel mounts `StoryPage`.
 *
 * `StoryLiveHost` is the real one: the integration lane's hooks over the
 * seam (`data/useStoryLive` for the read and the event feed,
 * `data/useStoryActions` for every write). A host composes it once through
 * `views/storySurface.tsx`, exactly as the Debug and Graph surfaces are.
 *
 * `StoryStaticHost` is the honest fallback for a panel whose host wired no
 * seam: the story drawn from the detail row it already holds, with no live
 * affordances and no writes beyond navigation (absent members draw nothing).
 */
import { useMemo } from 'react';
import type { EntityDetail, EntityId } from '@tm8/contract';

import type { Seam } from '../data/seam';
import { toStoryView, useStoryActions, useStoryLive } from './data';
import type { StoryActions } from './actions';
import { StoryPage, type StoryFilterRoute } from './StoryPage';
import type { StoryRunner } from './props';

export function StoryLiveHost({
  seam,
  storyId,
  open,
  runners,
  selectedId,
  filterRoute,
  layout,
}: {
  seam: Seam;
  storyId: EntityId;
  /** The BESIDE opener: the host shows that entity's details next to the story. */
  open?: (entityId: string) => void;
  /** The space's launch roster, so the playground can spawn as any agent teammate. */
  runners?: readonly StoryRunner[] | null;
  /** The entity whose details are open beside the story (the host's state). */
  selectedId?: string | null;
  filterRoute?: StoryFilterRoute | null;
  layout?: 'panel' | 'full';
}) {
  const { view, live, loading, error, refresh } = useStoryLive(seam, storyId);
  const actions = useStoryActions(seam, storyId, { view, ...(open ? { open } : {}) });

  if (!view) {
    if (error) {
      return (
        <div className="sty-state" role="alert">
          <b>The story could not be read.</b>
          <span>{error.message}</span>
          <button type="button" className="sty-state__retry" onClick={() => void refresh()}>
            Try again
          </button>
        </div>
      );
    }
    return (
      <div className="sty-state" aria-busy={loading}>
        Reading the story…
      </div>
    );
  }
  return (
    <>
      {error ? (
        <div className="sty-state sty-state--inline" role="status">
          Showing the last good read · {error.message}
        </div>
      ) : null}
      <StoryPage
        view={view}
        actions={actions}
        live={live}
        runners={runners ?? null}
        selectedId={selectedId ?? null}
        filterRoute={filterRoute ?? null}
        {...(layout ? { layout } : {})}
      />
    </>
  );
}

export function StoryStaticHost({ detail, open }: { detail: EntityDetail; open?: (entityId: string) => void }) {
  const view = useMemo(() => toStoryView({ entity: detail }), [detail]);
  const actions = useMemo<StoryActions>(() => (open ? { open } : {}), [open]);
  if (!view) return <div className="sty-state">This row carries no story read.</div>;
  return <StoryPage view={view} actions={actions} />;
}
