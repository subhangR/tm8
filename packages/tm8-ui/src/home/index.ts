/**
 * `src/home/` — T5-1, the space landing view behind the `dashboard` rail row.
 *
 * MOUNTABLE, NOT MOUNTED. Nothing here is wired into a screen: the coordinator
 * holds the wiring seat, and `HANDOVER.md` in this directory carries the exact
 * props and the exact call site (one branch in `GateApp`, beside the `graph`
 * one). Following `kit/`, `panels/` and `authoring/`, the stylesheet is
 * imported by the barrel — a host that imports one symbol cannot end up with a
 * half-styled screen.
 */
export { HomeScreen, HOME_STACK_BREAKPOINT, type HomeNewTask, type HomeScreenProps } from './HomeScreen';
export { useHomeData, reviewStatusValues, type HomeData, type HomeScreenData, type HomeViewer } from './useHomeData';
export {
  assignableKinds,
  composeMyWork,
  homeRowOf,
  liveKinds,
  mentionsEmptyNote,
  notificationRows,
  statusValueOf,
  type ComposeInput,
  type HomeDot,
  type HomeRow,
  type HomeSection,
  type MyWork,
} from './home-model';
export {
  ACTIVITY_WINDOW,
  activityRowOf,
  appendActivity,
  bucketActivity,
  dayBucketOf,
  recencyOf,
  type ActivityRow,
  type GlyphOf,
} from './home-activity';
