/**
 * `src/routes/` — the FRESH route codec (LLD §6, L8).
 *
 * Everything navigational is a URL; share/reload lands looking right. One
 * codec, built fresh. `buildHash` from the old shell is condemned and never
 * imported.
 */

export type {
  BuildOutcome,
  ChatSlot,
  ContentSurface,
  DropClass,
  NavView,
  Origin,
  PanelState,
  PanelTab,
  ParseOutcome,
  QValue,
  ListPick,
  Route,
} from '@tm8/client-core/routes';

export {
  CONTENT_SURFACES,
  DROP_CLASS_COPY,
  MAX_HASH_LENGTH,
  PANEL_TABS,
  UNADDRESSED_HASH,
  dropNoticeText,
  emptyPanels,
} from '@tm8/client-core/routes';

export { build, defaultRoute, homeAsTabs, normalize, parse, workRedirectOf } from '@tm8/client-core/routes';
export type { WorkRedirect } from '@tm8/client-core/routes';
export { decodeQ, encodeQ } from '@tm8/client-core/routes';
export { redirect } from '@tm8/client-core/routes';
export type { DeferredFeature, RedirectOutcome } from '@tm8/client-core/routes';
export { OVERLAY_STATE_KEY, createBrowserTarget, hashOfPathLink, overlayIdOf } from './transport';
export { createMemoryTarget } from '@tm8/client-core/routes';
export type { MemoryTarget, RouterTarget } from '@tm8/client-core/routes';
