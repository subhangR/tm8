/**
 * Leaderboard screen barrel (L5). Atlas mounts `leaderboardViews` on
 * `ShellLayout.views`.
 */
import './leaderboard.css';
import type { ViewRegistry } from '../../shell';
import { LeaderboardScreen } from './LeaderboardScreen';

export { LeaderboardScreen } from './LeaderboardScreen';
export { ScoreRows, type ScoreRowsProps } from './ScoreRows';
export {
  AwardsFeed, AwardBreakdowns, type AwardsFeedProps, type AwardBreakdownsProps,
} from './AwardsFeed';
export {
  useScores, useAwards, useLedgerNonce, useCompletionMoment, breakdownsByTask,
  CELEBRATION_MS, type AwardBreakdown,
} from './useLeaderboard';

/** ViewRegistry fragment — `{ leaderboard }`. */
export const leaderboardViews: ViewRegistry = { leaderboard: LeaderboardScreen };
