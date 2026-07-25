/** Reactions & points bar (L2.3) barrel — universal, incl. messages. */
import './reactions.css';

export { ReactionsPointsBar, type ReactionsPointsBarProps } from './ReactionsPointsBar';
export { PointsControl, type PointsControlProps } from './PointsControl';
export { useReactions, type UseReactionsResult } from './useReactions';
export {
  HOLD_MS, POINT_PRESETS, REACTION_COUNTER,
  activeReactions, flipReaction, grantPointsLocally, newMutationId,
  projectViewerReaction, reconcileLocal, topGranters,
  type Granter, type Reaction, type ReactionFlip,
} from './model';
