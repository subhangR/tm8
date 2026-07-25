/**
 * LiveBadges — the composed badge row (blocked · working · stale) that cards,
 * panels and list rows drop in one line. Purely a composition of the three
 * live components; the ordering is the UX brief's: why-it's-stuck first, who's
 * on it second, what's out of date third.
 */
import type { CollabFacade } from '../../facade/CollabFacade';
import type { EntitySummary } from '../../types/contract';
import { BlockedBadge } from './BlockedBadge';
import { StalenessBadge } from './StalenessBadge';
import { WorkingAggregate } from './WorkingAggregate';
import { WorkingPulse } from './WorkingPulse';
import { useWorkingActors } from './useLive';

export interface LiveBadgesProps {
  entity: EntitySummary;
  /** Enables RE-PULL on the staleness row. */
  facade?: CollabFacade;
  /** Aggregate ("🤖 2 working") vs individual pulses. */
  workingStyle?: 'aggregate' | 'pulses';
  showWaitingOn?: boolean;
  onUnblocked?: (entity: EntitySummary) => void;
  compact?: boolean;
}

export function LiveBadges({
  entity, facade, workingStyle = 'aggregate', showWaitingOn = true, onUnblocked, compact = false,
}: LiveBadgesProps) {
  const working = useWorkingActors(entity);

  return (
    <span className="cv2-livebadges" data-testid="live-badges">
      <BlockedBadge entity={entity} showWaitingOn={showWaitingOn && !compact} onUnblocked={onUnblocked} />
      {workingStyle === 'aggregate'
        ? <WorkingAggregate entity={entity} />
        : working.map((w) => <WorkingPulse key={`${w.actor.id}-${w.task.id}`} work={w} compact={compact} />)}
      <StalenessBadge entity={entity} facade={facade} compact={compact} />
    </span>
  );
}
