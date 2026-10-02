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
import { useMemo, type ComponentProps, type ReactNode } from 'react';
import type { EntityId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { StoryLiveHost } from '../story/StoryHost';
import type { StoryRunner } from '../story/props';
import type { StoryFilterRoute } from '../story/StoryPage';
import { navStore, useNavStore } from '../stores/navStore';

export interface StorySurfaceOptions {
  /** The entity whose details the host has open beside the story — its aux id. */
  selectedId?: string | null;
  /** `full` in the Z4 full view. */
  layout?: 'panel' | 'full';
}

export function storySurfaceFor(
  seam: Seam | undefined,
  entityId: string | null | undefined,
  /** The BESIDE opener — the host's next-column / aux / right-slot open. */
  open?: (entityId: string) => void,
  /** The host's launch roster (`data.launch.teammates`): who the playground can spawn as. */
  runners?: readonly StoryRunner[],
  options: StorySurfaceOptions = {},
): ReactNode | undefined {
  if (!seam || !entityId) return undefined;
  return (
    <RoutedStoryHost
      key={entityId}
      seam={seam}
      storyId={entityId as EntityId}
      {...(open ? { open } : {})}
      {...(runners ? { runners } : {})}
      selectedId={options.selectedId ?? null}
      {...(options.layout ? { layout: options.layout } : {})}
    />
  );
}

/**
 * THE GRAPH FILTER RIDES THE ADDRESS (PR 1004): `?hops=2&kinds=task,doc` on
 * the entity route, when the route names THIS story — the kind screen's
 * `e/{id}?origin=stories` and the full view's `e/{id}?full=1`. Written with a
 * REPLACE: a filter tweak is not a place to go Back to. Anywhere the story is
 * not the routed entity (a workspace column, an aux panel) the page keeps the
 * filter locally instead.
 */
function RoutedStoryHost(props: Omit<ComponentProps<typeof StoryLiveHost>, 'filterRoute'>) {
  const routed = useNavStore((s) => (s.view.view === 'entity' && s.view.entityId === props.storyId ? s.view : null));
  const hops = routed?.hops ?? null;
  const kinds = routed?.kinds ?? null;
  const filterRoute = useMemo<StoryFilterRoute | null>(
    () =>
      routed
        ? {
            hops,
            kinds,
            set: (nextHops, nextKinds) =>
              navStore.setState((s) =>
                s.view.view === 'entity' && s.view.entityId === props.storyId
                  ? {
                      view: { ...s.view, hops: nextHops, kinds: nextKinds },
                      history: 'replace',
                      revision: s.revision + 1,
                    }
                  : {},
              ),
          }
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [routed !== null, hops, kinds ? kinds.join(',') : null, props.storyId],
  );
  return <StoryLiveHost {...props} filterRoute={filterRoute} />;
}
