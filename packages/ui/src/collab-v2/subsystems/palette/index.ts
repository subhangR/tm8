/**
 * Palette barrel (L2.4). Hosts need exactly two things:
 *   <CommandPalette/>          — pass to `ShellLayout.palette`
 *   openPaletteWith(entityId)  — imperative, context-scoped open
 */
export { CommandPalette, usePaletteOpen, type CommandPaletteProps } from './CommandPalette';
export {
  openPaletteWith, dismissPalette, startRecentsTracker, usePaletteStore,
  selectRecentIds, selectPaletteContextId, RECENTS_CAP, type RecentsState,
} from './recents';
export {
  buildRootItems, buildLocalActions, buildGotoItems, buildStatusItems,
  buildLinkTypeItems, buildCreateItems, buildEntityItems, itemForFacadeAction,
  runPull, runSetStatus, runComplete, runCreate, runLink, runGoTo, runOpenEntity,
  parseQuery, matchesQuery, describeError, customEdgeType,
  VIEW_CHOICES, EDGE_TYPE_CHOICES, STATUS_CHOICES,
} from './actions';
export { useKnownEntities, useContextEntity, useFacadeActions, KNOWN_CAP } from './usePaletteData';
export type {
  PaletteItem, PaletteMode, PaletteGroup, PaletteDeps, PaletteExecution,
  PaletteNav, PaletteNotice, ViewChoice, EdgeTypeChoice, StatusChoice,
} from './types';
