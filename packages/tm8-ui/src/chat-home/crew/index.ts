/**
 * The crew surfaces — prototype sections A (Crew Card) and C (Live Dock) of
 * artifact 01a028f6-5b26-77d6-bf6d-22cdca62a60b, plus the status vocabulary
 * both read from.
 *
 * The COMPONENTS are still leaves: nothing in `CrewCard` or `LiveDock` opens a
 * feed, reads a session or touches the seam, and a host hands over a `CrewView`
 * and gets a surface back. What changed is that there is now a real producer of
 * one — `crew-source.ts` folds live work-session facts into `HelperView`s
 * against DESIGN 2's answers (#507) about which fields have a source and which
 * never will. The fixtures remain, and remain the only thing the components are
 * tested against.
 */
export { CrewCard, type CrewCardProps } from './CrewCard';
export { LiveDock, type LiveDockProps } from './LiveDock';
export {
  collapseCrewRows,
  crewRowOf,
  crewSummaryOf,
  monogramOf,
  CREW_VISIBLE_ROWS,
  type CrewCollapse,
  type CrewCounts,
  type CrewRow,
  type CrewSummary,
  type CrewTrack,
  type CrewView,
  type HelperView,
} from './crew-model';
export {
  facetWord,
  helperCountWords,
  helperWordsOf,
  pillToneOf,
  CREW_FACET_ORDER,
  HELPER_WORDS,
  UNKNOWN_HELPER_WORDS,
  type CrewFacet,
  type HelperStatus,
  type HelperTone,
  type HelperWords,
} from './status-vocabulary';
export {
  crewViewFrom,
  roleFromTitle,
  type CrewEntityRead,
  type CrewFold,
  type CrewSourceInput,
} from './crew-source';
export {
  CREW_ALL_DONE,
  CREW_ALL_WORKING,
  CREW_CROWDED,
  CREW_EMPTY,
  CREW_FIXTURES,
  CREW_ONE_NEEDS_YOU,
  CREW_ONE_STUCK,
  CREW_UNKNOWN_STATUS,
  FIXTURE_KEYS,
} from './crew-fixtures';
