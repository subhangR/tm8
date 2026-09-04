/**
 * `src/home/` — the MODEL behind the space's my-work composition.
 *
 * The T5-1 `HomeScreen` component that once lived here was orphaned when Home
 * became the chat view (`home-page/HomePage.tsx`, R4 2026-08-15): it took over
 * `composeMyWork` + `useHomeData` and the standalone screen — with its dead
 * first-run block — was never mounted again. That component and its `home.css`
 * were removed; its first-run copy now lives where a new user actually reaches
 * it, in `views/EmptyCenter`. What remains here is the live model HomePage
 * consumes.
 */
export {
  useHomeData,
  reviewStatusValues,
  type HomeData,
  type HomeScreenData,
  type HomeViewer,
  type ChatThreadLite,
} from './useHomeData';
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
} from './home-activity';
