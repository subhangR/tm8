/**
 * `src/routes/` — the FRESH route codec (LLD §6, L8).
 *
 * Everything navigational is a URL; share/reload lands looking right. One
 * codec, built fresh. `buildHash` from the old shell is condemned and never
 * imported.
 */

export type {
  BuildOutcome,
  ContentSurface,
  DropClass,
  NavView,
  Origin,
  PanelState,
  PanelTab,
  ParseOutcome,
  QValue,
  Route,
} from './types';

export {
  CONTENT_SURFACES,
  DROP_CLASS_COPY,
  MAX_HASH_LENGTH,
  PANEL_TABS,
  dropNoticeText,
  emptyPanels,
} from './types';

export { build, defaultRoute, normalize, parse } from './codec';
export { decodeQ, encodeQ } from './q';
export { redirect } from './redirects';
export type { DeferredFeature, RedirectOutcome } from './redirects';
export { createBrowserTarget, createMemoryTarget } from './transport';
export type { MemoryTarget, RouterTarget } from './transport';
