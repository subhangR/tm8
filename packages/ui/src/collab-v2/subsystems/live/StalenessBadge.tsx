/**
 * StalenessBadge — the two-signal pull state, per puller:
 *   content moved:    "v3 pinned · v5 → stale"   (hard signal, brass)
 *   discussion moved: "discussion moved since pull"  (softer, advisory)
 * with ONE-CLICK RE-PULL that re-pins the puller to the current version
 * through the facade. The badge clears itself because the pull command emits
 * the entity upsert — nothing here fakes the transition.
 */
import { useState } from 'react';
import { Pill } from '../../kit';
import type { CollabFacade } from '../../facade/CollabFacade';
import { isCollabError, type EntitySummary, type PullState } from '../../types/contract';
import { pushToast } from './toast';
import { useLiveEntity, useStalePulls } from './useLive';

export interface StalenessBadgeProps {
  entity: EntitySummary;
  /** Required for RE-PULL; without it the badge is read-only. */
  facade?: CollabFacade;
  /** Only show this actor's pull row (a personal surface, e.g. My Work). */
  actorId?: string;
  onRepulled?: (pull: PullState, version: number) => void;
  /** Announce the refresh in the toast slot (default true). */
  toast?: boolean;
  compact?: boolean;
}

/** Errors are read by CODE, never by message text (DEV-8). */
function describe(e: unknown): string {
  if (isCollabError(e)) {
    switch (e.code) {
      case 'version_conflict': return 'Version moved again — try once more.';
      case 'forbidden': return 'You cannot re-pull this entity.';
      case 'not_found': return 'That entity is gone.';
      default: return e.message;
    }
  }
  return e instanceof Error ? e.message : 'Re-pull failed.';
}

export function StalenessBadge({
  entity, facade, actorId, onRepulled, toast = true, compact = false,
}: StalenessBadgeProps) {
  const live = useLiveEntity(entity);
  const stale = useStalePulls(entity);
  const [busyActor, setBusyActor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const rows = actorId ? stale.filter((p) => p.actor.id === actorId) : stale;
  if (rows.length === 0) return null;

  const repull = async (pull: PullState): Promise<void> => {
    if (!facade) return;
    setBusyActor(pull.actor.id);
    setError(null);
    try {
      const version = live.version;
      await facade.pullEntity(live.id, {
        pinnedVersion: version,
        localId: pull.localId ?? null,
        actorId: pull.actor.id,
      });
      onRepulled?.(pull, version);
      if (toast) {
        pushToast({
          kind: 'stale',
          message: `Re-pulled ${live.title} at v${version}`,
          entityId: live.id,
        });
      }
    } catch (e) {
      setError(describe(e));
    } finally {
      setBusyActor(null);
    }
  };

  return (
    <span className="cv2-stale" data-testid="staleness-badge" data-entity={live.id}>
      {rows.map((pull) => {
        const contentStale = pull.contentStale;
        const label = contentStale
          ? `v${pull.pinnedVersion} pinned · v${live.version} → stale`
          : 'discussion moved since pull';
        return (
          <span className="cv2-stale__row" key={pull.actor.id} data-actor={pull.actor.id}>
            <Pill
              tone={contentStale ? 'stale' : 'waiting'}
              title={`${pull.actor.displayName} pinned v${pull.pinnedVersion}; content is v${live.version}`}
            >
              {compact && contentStale ? `v${pull.pinnedVersion} → stale` : label}
            </Pill>
            {facade && (
              <button
                type="button"
                className="cv2-stale__repull"
                data-testid={`repull-${pull.actor.id}`}
                aria-label={`Re-pull ${live.title} for ${pull.actor.displayName}`}
                disabled={busyActor === pull.actor.id}
                onClick={() => { void repull(pull); }}
              >
                {busyActor === pull.actor.id ? '…' : 'RE-PULL'}
              </button>
            )}
          </span>
        );
      })}
      {error && <span className="cv2-stale__error" role="alert">{error}</span>}
    </span>
  );
}
