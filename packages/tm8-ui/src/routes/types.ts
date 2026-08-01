/**
 * Route grammar types (LLD §6, WLT §2.2 verbatim).
 *
 * Everything navigational is a URL (L8). The codec is FRESH: the old
 * `collab-v2/shell/router.ts:buildHash` is CONDEMNED (channel-route asymmetry,
 * SPEC-FINAL C-7) and is never imported, adapted, or consulted for shape.
 */
import type { EntityId, SpaceId } from '@tm8/contract';
import type { CollectionMode, GroupByKey, QueryFilter, SortKey } from '../domain';

/** The four outer panel tabs (D3: always four, fixed order). */
export type PanelTab = 'content' | 'discussion' | 'connections' | 'activity';
export const PANEL_TABS: readonly PanelTab[] = ['content', 'discussion', 'connections', 'activity'];

/**
 * Per-panel content surface, meaningful only for work_session panels. NEVER
 * expands the `t` vocabulary. Phase 1 preserves-and-clamps `chat` (D12).
 */
export type ContentSurface = 'terminal' | 'chat' | 'debug';
export const CONTENT_SURFACES: readonly ContentSurface[] = ['terminal', 'chat', 'debug'];

/** `origin = {slug}[.{mode}]`, registry-validated. */
export interface Origin {
  slug: string;
  mode: CollectionMode | null;
}

/** `q` codec v1 payload — a strict subset of `CollectionQuery`. */
export interface QValue {
  v: 1;
  filters?: QueryFilter;
  sortBy?: SortKey;
  groupBy?: GroupByKey;
}

/** Where the view host points. One member per WLT §2.2 route line. */
export type NavView =
  | { view: 'home' }
  | { view: 'feed' }
  | { view: 'inbox' }
  | { view: 'workspace' }
  | { view: 'kind'; slug: string; mode: CollectionMode | null; q: QValue | null }
  | { view: 'entity'; entityId: EntityId; origin: Origin | null }
  | { view: 'channels' }
  | { view: 'channel'; channelId: EntityId; msg: EntityId | null }
  | { view: 'settings'; section: 'projects' | 'menu' | null };

/** The panel-engine state the URL mirrors (LLD §11: the URL owns all of it). */
export interface PanelState {
  /** `p` — bottom→top. */
  stack: EntityId[];
  /** `pin` — pin order. */
  pinned: EntityId[];
  /** `t` — omitted pairs default to `content`. */
  tabs: Record<EntityId, PanelTab>;
  /** `contentSurface` — preserved verbatim, including Phase-2 `chat` (D12). */
  contentSurface: Record<EntityId, ContentSurface>;
  /** `session` — auto-opens only when `p` and `pin` are both absent. */
  session: EntityId | null;
}

export interface Route {
  spaceId: SpaceId;
  target: NavView;
  panels: PanelState;
}

/**
 * The classes a drop notice may name. R4-7: the notice names the CLASS, never
 * a raw ID, and one notice covers a whole settle.
 */
export type DropClass = 'tabs' | 'pins' | 'stack' | 'query' | 'origin' | 'mode' | 'session' | 'anchor';

export const DROP_CLASS_COPY: Readonly<Record<DropClass, string>> = {
  tabs: 'tab and surface state',
  pins: 'pinned panels',
  stack: 'open panels',
  query: 'filter state',
  origin: 'where you came from',
  mode: 'layout choice',
  session: 'the session to open',
  anchor: 'the message anchor',
};

/**
 * The ONE generalized notice (R4-7): class-naming, no raw IDs. The NoticeHost
 * renders a single line per settle no matter how many params were discarded.
 */
export function dropNoticeText(dropped: readonly DropClass[]): string | null {
  if (dropped.length === 0) return null;
  return "Some state wasn't carried in this link — it was too long or malformed.";
}

export interface ParseOutcome {
  /** `null` ⇒ no addressable space in the hash: render the space picker. */
  route: Route | null;
  /** Params discarded atomically because they were unparseable. */
  dropped: DropClass[];
}

export interface BuildOutcome {
  hash: string;
  /** Params dropped whole to respect the 2048 cap, in the ruled order. */
  dropped: DropClass[];
}

export const MAX_HASH_LENGTH = 2048;

export function emptyPanels(): PanelState {
  return { stack: [], pinned: [], tabs: {}, contentSurface: {}, session: null };
}
