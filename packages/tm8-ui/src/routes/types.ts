/**
 * Route grammar types (LLD §6, WLT §2.2 verbatim).
 *
 * Everything navigational is a URL (L8). The codec is FRESH: the old
 * `collab-v2/shell/router.ts:buildHash` is CONDEMNED (channel-route asymmetry,
 * SPEC-FINAL C-7) and is never imported, adapted, or consulted for shape.
 */
import type { EntityId, MenuViewRef, SpaceId } from '@tm8/contract';
import type { CollectionMode, GroupByKey, QueryFilter, SortKey } from '../domain';

/** The four outer panel tabs (D3: always four, fixed order). */
export type PanelTab = 'content' | 'discussion' | 'connections' | 'activity';
export const PANEL_TABS: readonly PanelTab[] = ['content', 'discussion', 'connections', 'activity'];

/**
 * Per-panel content surface, meaningful only for work_session panels. NEVER
 * expands the `t` vocabulary. Phase 1 preserves-and-clamps (D12).
 */
export type ContentSurface = 'terminal' | 'transcript' | 'git' | 'debug' | 'graph';
export const CONTENT_SURFACES: readonly ContentSurface[] = [
  'terminal',
  'transcript',
  'git',
  'debug',
  'graph',
];

/**
 * RETIRED TOKENS THAT STILL DECODE. `chat` was this slot's name until the
 * session panel's surface became the agent transcript, and links carrying it
 * are already in people's hands — in pasted URLs, in bookmarks, in messages in
 * this app's own channels.
 *
 * The preserve-don't-rewrite ruling (DECISIONS.md) is why this exists and also
 * why it is one-directional: an old token is ACCEPTED on the way in and is
 * never EMITTED on the way out, so a link keeps working while the vocabulary
 * still retires. A URL that arrives as `chat` leaves as `transcript` the next
 * time the route is written.
 */
export const LEGACY_CONTENT_SURFACES: Readonly<Record<string, ContentSurface>> = {
  chat: 'transcript',
};

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

/**
 * The Cockpit stages that are NOT an entity.
 *
 * The Cockpit's centre berth holds one of three things: the conversation, an
 * entity (addressed by the panel stack), or one of these. Only these need a
 * name in the route, because the other two already have addresses.
 */
export type CockpitStage = 'fleet' | 'graph';
export const COCKPIT_STAGES: ReadonlySet<CockpitStage> = new Set(['fleet', 'graph']);

/**
 * The unified Home's ROOT (task 01a00932, UNIFIED-HOME-DESIGN.md D1): which
 * population its left column lists — one collection kind (by slug, the same
 * registry-validated vocabulary `origin` uses) or the chat threads, with the
 * open conversation optionally addressed. Absent ⇒ the viewer's remembered
 * root (D15 memory), which is what keeps a bare `/home` link personal.
 */
export type HomeRootTarget =
  | { type: 'kind'; slug: string }
  | {
      type: 'chats';
      threadId: EntityId | null;
      /**
       * `?stage=` — which COCKPIT STAGE is up: the fleet this conversation
       * orchestrates, or its entity graph. The other occupant of that berth
       * is an entity, which is addressed by the panel stack rather than here,
       * so this names only the stages that are not entities.
       *
       * A URL rather than component state, for the reason `?graph=full` was
       * one before it: Back closes the stage, a reload restores it, and a
       * viewer can SEND someone the fleet of a conversation. A stage nobody
       * can link to is a stage nobody shares.
       *
       * LOSSY-TOLERANT, inherited verbatim from the parameter it replaces: any
       * unrecognised value is silently ignored at parse and degrades to the
       * plain conversation. A stale or foreign link must never crash and must
       * never announce itself.
       *
       * REPLACES `graph`/`gf`. The Cockpit ruling retires the fullscreen graph
       * dialog and the facet rail that edited `gf`, and `gf` was OPAQUE to
       * this layer by design — carrying an unreadable parameter forward for a
       * UI that no longer exists is how dead vocabulary outlives its feature.
       */
      stage?: CockpitStage | null;
    };

/** Where the view host points. One member per WLT §2.2 route line. */
export type NavView =
  | { view: 'home'; root?: HomeRootTarget | null }
  | { view: 'feed' }
  | { view: 'inbox' }
  | { view: 'workspace' }
  | { view: 'kind'; slug: string; mode: CollectionMode | null; q: QValue | null }
  /*
   * `originView` — THE COMPANION THAT IS A VIEW RATHER THAN A COLLECTION.
   *
   * `origin` names a KIND's collection and is registry-validated against a
   * slug, which is right for every screen the rail reaches by kind. It has no
   * way to name a VIEW: `messages`, `inbox` and `dashboard` are `MenuViewRef`s,
   * not kinds, so a view screen could not carry an open entity in its address
   * and both halves of the route<->stack loop skipped it.
   *
   * ADDITIVE RATHER THAN A WIDENED `Origin`, deliberately. Making `Origin` a
   * union would be tidier and would touch every consumer that reads
   * `origin.slug` — `companionOf`, `landingOfRoute`, `routeViewOf`, the codec —
   * and this lands on the router, which is the highest-risk file in this
   * program and cannot be captured until the instrument queue clears. A second
   * optional field breaks nothing that exists today and is deletable if the
   * union is later preferred.
   *
   * MUTUALLY EXCLUSIVE WITH `origin` BY CONSTRUCTION, not by assertion: the
   * codec reads ONE `origin=` parameter and decides which shape it is from the
   * `v-` prefix, so an address cannot carry both.
   */
  | { view: 'entity'; entityId: EntityId; origin: Origin | null; originView?: MenuViewRef | null }
  | { view: 'channels' }
  | { view: 'channel'; channelId: EntityId; msg: EntityId | null }
  | { view: 'settings'; section: 'projects' | 'menu' | null }
  /*
   * The four screens that rendered from the rail with NO route line, added by
   * the 2026-08-14 amendment to WLT §2.1/§2.2.
   *
   * These were not new features and this was not a widening of the app's
   * surface: `graph`, `files`, `git` and `messages` have been live
   * `MenuViewRef` members in `@tm8/contract` and live branches in `GateApp`'s
   * render switch. What they lacked was addressability — so their screens
   * could not be reloaded into, shared, or reached with the back button, and a
   * viewer sitting on the Graph had a URL claiming they were somewhere else.
   *
   * WLT §2.3 froze `ViewRef` as a "CLOSED v1 union" of six. The contract enum
   * already carried ten. The spec was the stale artefact here, not the code.
   */
  | { view: 'graph' }
  | { view: 'files' }
  | { view: 'git' }
  | { view: 'messages' }
  /* The task Board (2026-08-16): a whole-centre kanban screen, flat segment,
     no parameters of its own — same posture as the four above. */
  | { view: 'board' }
  /* The Craft studio (2026-08-16): whole-centre split pane, flat segment. */
  | { view: 'craft' }
  /*
   * BOARD V2 (2026-08-18, Kind/Status/Category/Workflow program): the
   * universal board — any entity kind, columns = the four status categories
   * (or one kind's workflow states). Whole-centre, flat segment.
   *
   * ROUTE-ONLY like `newSession`, and for the same reason: a `MenuViewRef`
   * costs a contract enum widening, a menu revision and a DB migration
   * (`menu_view_registry`, the seeder parity pin). While v2 runs BESIDE the
   * shipping Board its tab is appended client-side by the shell instead —
   * when v2 replaces Board by a later decision, THAT change takes the
   * migration and this member migrates into `MenuViewRef`.
   */
  | { view: 'boardV2' }
  /*
   * NEW SESSION (2026-08-16): the create screen that mints a task from a typed
   * prompt and spawns on it. Flat segment, no parameters.
   *
   * ROUTE-ONLY, AND DELIBERATELY NOT A `MenuViewRef`. The rail members above
   * are contract enum entries and adding one costs a menu revision and a
   * migration. This screen is reached from a quick action and from the
   * sessions empty state, not from the rail, so it needs addressability and
   * nothing else — `VIEW_REF_ROUTE` stays total over `MenuViewRef` without it.
   *
   * It carries no id because the screen exists BEFORE the thing it creates:
   * once the session is spawned the app replaces this route with the session's
   * own, so a New Session URL is never a link to a particular session.
   */
  | { view: 'newSession' }
  /*
   * A VOICE ROOM. Added 2026-08-14 to close a latent break, not to add a
   * feature.
   *
   * `domain/registry.ts:923` has emitted `#/s/{spaceId}/voice/{id}` since voice
   * channels shipped, and this codec could not parse it — the registry has been
   * handing out a link the app cannot read. The grammar always meant to carry
   * this route; only the codec was missing.
   *
   * It surfaced when deriving the shell's active target from `navStore` was
   * attempted: that requires EVERY reachable target to have a `NavView`, and
   * the rail genuinely emits voice targets. Without this member the derivation
   * silently drops the voice rooms.
   *
   * `voice_channel` keeps `strategy: 'special'` with `slug: null` — a room is
   * not a feed and gets NO `k/` collection view. One room, one route.
   */
  | { view: 'voice'; voiceChannelId: EntityId };

/** The panel-engine state the URL mirrors (LLD §11: the URL owns all of it). */
export interface PanelState {
  /** `p` — bottom→top. On Home the stack IS the centre TRAIL: the top
   *  renders, the rest are its breadcrumb (task 01a00932 R7/D2). */
  stack: EntityId[];
  /** `pin` — pin order. */
  pinned: EntityId[];
  /**
   * `r` — Home's RIGHT-PANEL trail, bottom→top, same encoding as `p`
   * (task 01a00932 R6/R7). The top renders in the right panel; the rest are
   * its breadcrumb. Empty ⇒ no right panel. Other views carry it verbatim.
   */
  right: EntityId[];
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
export type DropClass =
  | 'tabs'
  | 'right'
  | 'pins'
  | 'stack'
  | 'query'
  | 'origin'
  | 'mode'
  | 'session'
  | 'anchor';

export const DROP_CLASS_COPY: Readonly<Record<DropClass, string>> = {
  tabs: 'tab and surface state',
  right: 'the side panel',
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
 *
 * IT NEVER NAMED THE CLASS, WHICH IS THE ONE THING R4-7 REQUIRES OF IT. The
 * sentence was a fixed string and `dropped` was accepted and ignored, so
 * `DROP_CLASS_COPY` — the table sitting directly above, written for exactly
 * this — had no reader at all. "Some state wasn't carried" is the sentence a
 * reader can do nothing with: it does not say whether they lost a filter they
 * can retype or three pinned panels they cannot reconstruct, which is the whole
 * difference between an inconvenience and a link they should ask to be resent.
 *
 * COMPOSED FROM THE TABLE, never restated beside it. A reworded entry has to
 * change this sentence too, and composition is what guarantees it does — the
 * same rule `attachRouter` applies to `REASONS` for the deferred-feature
 * notice, and the drift class this codebase keeps finding when it does not.
 *
 * Still ONE line for a whole settle, and still no raw ids: a viewer cannot act
 * on `ent_01H8…` and printing one leaks identifiers into a surface built to be
 * shared.
 */
export function dropNoticeText(dropped: readonly DropClass[]): string | null {
  if (dropped.length === 0) return null;
  /* Deduped and ordered by the table, not by arrival: the same class can be
     dropped by more than one tier in one settle, and a sentence whose word
     order depends on the drop order would read differently for the same loss. */
  const named = (Object.keys(DROP_CLASS_COPY) as DropClass[])
    .filter((cls) => dropped.includes(cls))
    .map((cls) => DROP_CLASS_COPY[cls]);
  if (named.length === 0) return null;
  const list =
    named.length === 1
      ? named[0]
      : `${named.slice(0, -1).join(', ')} and ${named[named.length - 1]}`;
  /* CAUSE-NEUTRAL, DELIBERATELY. One function serves two callers: `parse`
     discards params that were UNPARSEABLE, `build` drops them to respect the
     2048 cap. The old sentence hedged across both with "too long or malformed",
     and naming one cause here would make the notice confidently wrong half the
     time. The CLASS is what R4-7 requires and what the reader can act on; the
     cause is not knowable at this seam and is not claimed. */
  return `Some of this link couldn’t be carried: ${list}.`;
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

/**
 * THE ADDRESS THAT NAMES NOTHING — what the bar reads when this browser is not
 * pointed at anybody's space.
 *
 * `parse` returns a null route for it (the space picker renders) and
 * `createBrowserTarget` already treats an absent hash as this string, so it is
 * the one form that means "no destination" rather than "a destination that
 * failed to load". It was written as a bare `'#/'` literal in three places
 * before it had a name — the Server-switch address reset, both transport
 * fallbacks — and the sign-out reset made it four. A route the app can WRITE is
 * the codec's business (L8: never hand-assemble a hash), even when the route is
 * the empty one.
 */
export const UNADDRESSED_HASH = '#/';

export function emptyPanels(): PanelState {
  return { stack: [], pinned: [], right: [], tabs: {}, contentSurface: {}, session: null };
}
