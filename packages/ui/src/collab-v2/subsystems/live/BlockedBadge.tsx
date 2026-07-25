/**
 * BlockedBadge — "⚠ blocked · 2" plus the waiting-on chips that say WHY, and
 * the unblock moment: when the last hard dependency resolves the badge clears
 * itself, flashes once, fires `onUnblocked`, and drops a toast. Driven purely
 * by `badges.blocked` arriving on the event stream, so the simulation's
 * completion ripple is what you actually see.
 */
import { Pill } from '../../kit';
import { EntityChip } from '../../entity/EntityChip';
import type { EntitySummary } from '../../types/contract';
import { pushToast } from './toast';
import { useBlocked, useLiveEntity, useUnblockMoment } from './useLive';

export interface BlockedBadgeProps {
  entity: EntitySummary;
  /** Render the waiting-on chips (default true). */
  showWaitingOn?: boolean;
  /** Fires once, on the blocked → unblocked flip. */
  onUnblocked?: (entity: EntitySummary) => void;
  /** Push the unblock toast (default true). */
  toast?: boolean;
  /** Duration of the unblock flash; 0 disables. */
  flashMs?: number;
  maxChips?: number;
}

export function BlockedBadge({
  entity, showWaitingOn = true, onUnblocked, toast = true, flashMs, maxChips = 3,
}: BlockedBadgeProps) {
  const live = useLiveEntity(entity);
  const { blocked, count, waitingOn } = useBlocked(entity);

  const flash = useUnblockMoment(entity, {
    flashMs,
    onUnblocked: (unblocked) => {
      onUnblocked?.(unblocked);
      if (toast) {
        pushToast({
          kind: 'unblock',
          message: `${unblocked.title} is unblocked`,
          entityId: unblocked.id,
        });
      }
    },
  });

  if (!blocked) {
    return flash
      ? (
        <span className="cv2-unblocked" data-testid="unblock-moment" role="status">
          <Pill tone="done">unblocked</Pill>
        </span>
      )
      : null;
  }

  const chips = waitingOn.slice(0, maxChips);
  const overflow = waitingOn.length - chips.length;

  return (
    <span className="cv2-blocked" data-testid="blocked-badge" data-entity={live.id} data-count={count}>
      <Pill
        tone="blocked"
        title={`waiting on ${waitingOn.map((w) => w.title).join(', ')}`}
      >
        ⚠ blocked · {count}
      </Pill>
      {showWaitingOn && chips.length > 0 && (
        <span className="cv2-blocked__waiting" data-testid="waiting-on">
          <span className="cv2-blocked__word">waiting on</span>
          {chips.map((w) => <EntityChip key={w.id} entity={w} variant="ref" />)}
          {overflow > 0 && <span className="cv2-blocked__more">+{overflow}</span>}
        </span>
      )}
    </span>
  );
}
