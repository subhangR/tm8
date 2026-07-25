/**
 * Home (My Work) — pure composition of three live collection queries plus the
 * space activity column.
 *
 * The three presets are the contract's Home presets expressed as
 * `CollectionQuery` (the shape `getHome` returns), scoped to "my work" = the
 * viewer AND every agent that works for them, so an agent's in-flight task
 * shows up under its owner. Expressing them as queries (rather than consuming
 * `getHome`'s one-shot page) is what keeps the columns live: `useCollection`
 * re-runs them on the WorkspaceEvents that change membership.
 */
import { useMemo, useState } from 'react';
import { Eyebrow } from '../../kit';
import { pushToast } from '../../subsystems/live';
import type { ShellViewProps, ViewRegistry } from '../../shell';
import type { CollectionQuery, EntitySummary } from '../../types/contract';
import { ActivityFeed } from './ActivityFeed';
import { WorkColumn } from './WorkColumn';
import { OwnerAttribution } from './rows';
import { useViewerActors } from './useViewerActors';

/** Statuses that mean "someone of mine has this in hand right now". */
const IN_FLIGHT_STATUSES = ['pulled', 'working'] as const;

function PullButton({ entity, onPull }: {
  entity: EntitySummary;
  onPull: (entity: EntitySummary) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      className="cv2-home__pull"
      disabled={pending}
      data-testid={`pull-${entity.id}`}
      onClick={async (e) => {
        e.stopPropagation();
        setPending(true);
        try { await onPull(entity); } finally { setPending(false); }
      }}
    >
      {pending ? 'PULLING…' : 'PULL'}
    </button>
  );
}

export function HomeScreen({ facade, spaceId, onOpenEntity }: ShellViewProps) {
  const { viewer, actorIds, byId, loading } = useViewerActors(facade, spaceId);
  const ready = actorIds.length > 0;

  const readyQuery: CollectionQuery = useMemo(() => ({
    spaceId, kinds: ['task'], filters: { readyToPull: true, assigneeIds: actorIds }, sort: 'priority',
  }), [spaceId, actorIds]);

  const inFlightQuery: CollectionQuery = useMemo(() => ({
    spaceId,
    kinds: ['task'],
    filters: { assigneeIds: actorIds, workStatus: [...IN_FLIGHT_STATUSES] },
    sort: 'activityAt_desc',
  }), [spaceId, actorIds]);

  const needsMeQuery: CollectionQuery = useMemo(() => ({
    spaceId, kinds: ['task'], filters: { inReviewForActorId: viewer?.id ?? '' }, sort: 'activityAt_desc',
  }), [spaceId, viewer?.id]);

  const pull = async (entity: EntitySummary): Promise<void> => {
    try {
      await facade.pullEntity(entity.id, {
        pinnedVersion: entity.version,
        actorId: viewer?.id,
      });
      pushToast({
        kind: 'success',
        message: `Pulled “${entity.title}” · pinned v${entity.version}`,
        entityId: entity.id,
      });
    } catch (e) {
      pushToast({
        kind: 'error',
        message: `Couldn't pull “${entity.title}” — ${(e as Error).message}`,
        entityId: entity.id,
      });
    }
  };

  const attribution = (entity: EntitySummary) => (
    <OwnerAttribution entity={entity} actorsById={byId} />
  );

  return (
    <div className="cv2-home" data-testid="view-home">
      <header className="cv2-home__header">
        <Eyebrow>my work</Eyebrow>
        <h1 className="cv2-home__h1">{viewer ? viewer.displayName : 'Home'}</h1>
        <p className="cv2-home__blurb">
          What you can start, what is in flight under you and your agents, and what is waiting on you.
        </p>
      </header>

      {!ready && (
        <div className="cv2-home__loading" role="status">
          {loading ? 'loading your work…' : 'no work scope for this space yet.'}
        </div>
      )}

      {ready && (
        <div className="cv2-home__grid">
          <WorkColumn
            testId="home-ready"
            title="ready to pull"
            hint="Open, unblocked, and yours — pull one to pin its version."
            query={readyQuery}
            onOpen={onOpenEntity}
            renderAction={(entity) => <PullButton entity={entity} onPull={pull} />}
          />
          <WorkColumn
            testId="home-inflight"
            title="in flight"
            hint="Pulled or being worked — a stale pin offers RE-PULL."
            query={inFlightQuery}
            onOpen={onOpenEntity}
            renderMeta={attribution}
          />
          <WorkColumn
            testId="home-needsme"
            title="needs me"
            hint="In review where you are the author or an assignee."
            query={needsMeQuery}
            onOpen={onOpenEntity}
            renderMeta={attribution}
          />
          <ActivityFeed facade={facade} spaceId={spaceId} />
        </div>
      )}
    </div>
  );
}

/** ViewRegistry fragment — the shell composes screen fragments into `views`. */
export const homeViews: ViewRegistry = { home: HomeScreen };
