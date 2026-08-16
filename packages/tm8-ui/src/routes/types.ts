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
export type ContentSurface = 'terminal' | 'chat' | 'git' | 'debug' | 'graph';
export const CONTENT_SURFACES: readonly ContentSurface[] = ['terminal', 'chat', 'git', 'debug', 'graph'];

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
       * `?graph=full` — the conversation's entity graph opened fullscreen
       * (plan 01a0094b D2). A URL rather than component state so Back closes
       * it, a reload restores it and the view can be linked. LOSSY-TOLERANT:
       * any value other than `full` is silently ignored at parse — a stale
       * link must degrade to the plain conversation, never crash or notice.
       */
      graph?: 'full' | null;
    };

/** Where the view host points. One member per WLT §2.2 route line. */
export type NavView =
  | { view: 'home'; root?: HomeRootTarget | null }
  | { view: 'feed' }
  | { view: 'inbox' }
  | { view: 'workspace' }
  | { view: 'kind'; slug: string; mode: CollectionMode | null; q: QValue | null }
  | { view: 'entity'; entityId: EntityId; origin: Origin | null }
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
