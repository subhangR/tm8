/**
 * launch-handoff — what happens between a pressed Launch and a live session
 * (task 01a182d2): the launch record and its state machine (`store`), the boot
 * phases (`phases`), the page model (`page`), how a spawn failed (`failure`)
 * and what the page may ask of its host (`page-host`).
 *
 * Layer-neutral on purpose: panels draw the page, Work hosts it and the views'
 * hand-off drives it, so it imports from none of them.
 */
export {
  adoptLaunch,
  beginLaunch,
  startingRecord,
  dropLaunch,
  launchForSession,
  launchRecord,
  launchesStore,
  resetLaunches,
  transition,
  useLaunchForSession,
  useLaunchRecord,
  type LaunchEvent,
  type LaunchFailure,
  type LaunchPage,
  type LaunchRecord,
  type LaunchState,
} from './store';
export { BOOT_PHASES, bootPhaseOf, formatElapsed, launchPhases, stepsDone, type BootStep, type PhaseMark, type PhaseRow } from './phases';
export { BOOT_STALE_MS, bootIsFresh, bootingSessionOf, launchPageModel, type BootingSession, type LaunchPageModel, type LaunchPageState } from './page';
export { isLaunchTimeout, launchFailureOf } from './failure';
export { LaunchPageHostContext, useLaunchPageHost, type LaunchPageHost } from './page-host';
