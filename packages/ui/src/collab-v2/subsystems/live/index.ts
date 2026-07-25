/**
 * Live layer barrel (L2.5) — presence, typing, working pulses, staleness,
 * blocked + the unblock moment. Every component is store/facade-driven, so the
 * simulation exercises all of them without a single component-local timer.
 */
import './live.css';

export { PresenceAvatars, type PresenceAvatarsProps } from './PresenceAvatars';
export { TypingIndicator, type TypingIndicatorProps } from './TypingIndicator';
export { WorkingPulse, WorkingDetail, type WorkingPulseProps } from './WorkingPulse';
export { WorkingAggregate, type WorkingAggregateProps } from './WorkingAggregate';
export { StalenessBadge, type StalenessBadgeProps } from './StalenessBadge';
export { BlockedBadge, type BlockedBadgeProps } from './BlockedBadge';
export { LiveBadges, type LiveBadgesProps } from './LiveBadges';
export {
  ToastViewport, useToastStore, pushToast, TOAST_CAP, TOAST_TTL_MS,
  type ToastItem, type ToastKind, type ToastState, type ToastViewportProps,
} from './toast';
export {
  useLiveEntity, useLiveEntityById, usePresenceOf, usePresenceChannel, useTypingOf, useActors,
  useWorkingActors, useStalePulls, useBlocked, useUnblockMoment,
  UNBLOCK_FLASH_MS, type BlockedInfo, type UnblockMomentOptions,
} from './useLive';
