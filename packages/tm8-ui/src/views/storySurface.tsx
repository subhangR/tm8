/**
 * The story page, composed ONCE for every host that mounts an
 * `EntityDetailPanel` — the `debugSurfaceFor` pattern. The panel layer is
 * presentational and never reaches for the seam, so the live page arrives as
 * a node; the `storyline` block draws it.
 *
 * Building the element costs nothing for a row that is not a story: it is
 * only MOUNTED by the `storyline` block, which only a story's registry row
 * declares. A host without a seam gets `undefined`, and the block falls back
 * to the static read of the row it already holds.
 */
import type { ReactNode } from 'react';
import type { EntityId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { StoryLiveHost } from '../story/StoryHost';
import type { StoryRunner } from '../story/props';

export function storySurfaceFor(
  seam: Seam | undefined,
  entityId: string | null | undefined,
  open?: (entityId: string) => void,
  /** The host's launch roster (`data.launch.teammates`): who the playground can spawn as. */
  runners?: readonly StoryRunner[],
): ReactNode | undefined {
  if (!seam || !entityId) return undefined;
  return (
    <StoryLiveHost
      key={entityId}
      seam={seam}
      storyId={entityId as EntityId}
      {...(open ? { open } : {})}
      {...(runners ? { runners } : {})}
    />
  );
}
