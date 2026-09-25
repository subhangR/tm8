/**
 * The launch's per-group selection (design 01a0d348 §5.1–5.2, I9): the hook
 * both launch surfaces hold, and the groups they render. Its stylesheet is
 * imported HERE and only here — a deep-path import would render the groups
 * unstyled.
 */
import './launch-selection.css';

export { useLaunchSelection, type LaunchDefaultsLaunchParams, type LaunchGroupBytes, type LaunchSelection, type LoadLaunchDefaults } from './useLaunchSelection';
export {
  LaunchSelectionChips,
  LaunchSelectionGroups,
  type LaunchSelectionCandidates,
  type LaunchSelectionSources,
} from './LaunchSelectionGroups';
export type { LaunchDefaultsPort } from './port';
export { BudgetOverride, BUDGET_OVERRIDE_HINT, overrunWarning } from './BudgetOverride';
export { appliedReasons, groupMeter, REASON_WORDS, type GroupMeterFacts, type LaunchRanked } from './meter';
export type { LaunchSelectionBudgetProps } from './LaunchSelectionGroups';
