/**
 * navStore — the URL-mirrored panel engine (LLD §5.2).
 *
 * FRESH code; the old `collab-v2/stores/nav.ts` machine over
 * `{stack, pinned, tabs}` is the BEHAVIORAL ORACLE, not a source: the codec and
 * `contentSurface` are new, so its code is not copied.
 *
 * What lives here (LLD §11: the URL owns all of it):
 *   space · view · stack · pinned · per-panel tab · per-panel contentSurface ·
 *   the `session` param.
 *
 * What deliberately does NOT live here: the C_min geometry law, the admission
 * predicate and the demotion loop (LLD §5.3). Those need a MEASURED centre
 * width, which only the shell layer can take, and the LLD §1.1 import DAG runs
 * stores → shell, never back. The shell runs its pure geometry pass and hands
 * the settled result to `applyNormalization`. There is exactly one demotion
 * loop in this codebase and it is not in this file.
 */
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { EntityId, SpaceId } from '@tm8/contract';
import { REASONS } from '../domain';
import {
  build,
  defaultRoute,
  dropNoticeText,
  normalize,
  parse,
  redirect,
  type ContentSurface,
  type DropClass,
  type NavView,
  type PanelState,
  type PanelTab,
  type Route,
  type RouterTarget,
} from '../routes';
import { reconcileScreenStacks } from './backContract';

/** WLT §5.2 / SPEC-FINAL: three pins, no more. */
export const MAX_PINNED = 3;

/** Which chrome a panel instance renders in. Anatomy never varies (LLD §3.2). */
export type PanelHost = 'stack' | 'pinned' | 'peek' | 'z4';

export interface NavState {
  spaceId: SpaceId;
  view: NavView;
  /**
   * bottom → top. On Home the stack IS the Trail (U4) — the whole walk, not
   * just what renders. On Work it is the panel stack, unchanged.
   */
  stack: EntityId[];
  /** pin order. */
  pinned: EntityId[];
  /**
   * WHERE THE VIEWER STANDS in Home's Trail: an INDEX into `stack`.
   *
   * AN INDEX HERE, AN ID ON THE WIRE (`pc=<entityId>`), and the split is
   * load-bearing rather than incidental. An index is what `trailBack`,
   * `trailForward` and the render want — they move along an array. But an
   * index is the WRONG thing to put in a URL, because `normalize` can remove
   * an entry from `stack` (it cross-filters against pins, codec.ts) and every
   * index after that entry then aims one place to the left. That is a silently
   * WRONG destination with correct-looking chrome. An id absorbs the shift:
   * re-resolved against the canonical stack it still names the same entity,
   * and when the entity itself is gone it is ABSENT — detectable, so the
   * cursor clamps to the top under the standard notice instead of guessing.
   *
   * The id is only well-defined because of the no-repeats ruling below: a
   * Trail that could repeat an entity could not be addressed by id at all.
   * The two rulings compose, and neither works without the other.
   *
   * (The design's D2 argued the opposite from `p=a,b,a` being a legal walk. It
   * is not — `normalize` dedupes the stack, so a repeat never round-trips. The
   * premise was withdrawn on 2026-09-22 and the conclusion with it.)
   *
   * `stack[cursor]` is what HOME renders. `stack[stack.length - 1]` is what
   * WORK renders, and that is left exactly as it was (U1). The two can only
   * disagree mid-Trail on Home, because every non-Trail verb parks the cursor
   * at the top.
   *
   * ALWAYS IN RANGE: 0 while the stack is empty, else `[0, stack.length - 1]`.
   * Every verb that touches `stack` writes an in-range cursor itself (`atTop`,
   * an index it just found, or 0), and `clampCursor` guards the one READ,
   * `selectTrailEntity` — so a raw `setState` that forgets the cursor still
   * renders an entry of the Trail rather than a blank centre under an address
   * that looks perfectly well-formed.
   */
  cursor: number;
  tabs: Record<EntityId, PanelTab>;
  contentSurface: Record<EntityId, ContentSurface>;
  session: EntityId | null;
  /**
   * How the NEXT URL write should enter history. `push` = user navigation and
   * explicit pin/unpin; `replace` = responsive normalization and surface
   * toggles (LLD §6 history discipline).
   */
  history: 'push' | 'replace';
  /** Bumped on every accepted transition so the router sync can detect one. */
  revision: number;
}

export type PinResult = { ok: true } | { ok: false; reason: string };

export interface NavActions {
  /** First-render hydration (and every external hash change). */
  hydrate(route: Route): void;
  navigate(view: NavView): void;
  /**
   * The ACTIVE SPACE, when it was chosen by something other than the URL.
   *
   * `hydrate` sets `spaceId` from a parsed hash, which was the only writer for
   * as long as `attachRouter` had no caller. But the space is also chosen by the
   * boot read, the space tab bar, and space creation — none of which go through
   * a hash. Without this the store's `spaceId` stays `''` for those paths and
   * every URL the router would build is discarded (`writeNow` bails on an empty
   * space), so navigation would silently stop being addressable.
   *
   * `replace` history, deliberately: choosing a space is not a navigation WITHIN
   * a space, and it must not leave a back-button entry that returns you to a
   * space you have already left.
   */
  setSpace(spaceId: SpaceId): void;
  /** Dedupes; an already-hosted id is RAISED to the stack top, never doubled. */
  push(id: EntityId): void;
  /** Esc: stack top only, never pins. */
  pop(): void;
  close(id: EntityId): void;
  /**
   * Store-side guard is ONLY the state-pure invariant (`< MAX_PINNED`). The
   * width refusal belongs to the shell's admission predicate, which checks
   * BEFORE calling — so a refusal here always means "3 pins max".
   */
  pin(id: EntityId): PinResult;
  unpin(id: EntityId): void;
  /** Z4. Removes the id from BOTH sets — the inherited `promotePanel` gap. */
  promote(id: EntityId): void;
  setTab(id: EntityId, tab: PanelTab): void;
  setContentSurface(id: EntityId, surface: ContentSurface): void;
  setSession(id: EntityId | null): void;
  /**
   * THE seam for the shell's demotion loop: hand back the settled
   * `{stack, pinned}`. Idempotent — an unchanged result is a no-op and writes
   * no history at all, which is what makes "exactly one replaceState per
   * settle" true.
   */
  applyNormalization(next: { stack: EntityId[]; pinned: EntityId[] }): void;
  /**
   * HOME'S TRAIL (task 01a0c864, U2-U5). One Trail, one cursor. Every verb
   * here is USER navigation (history: push) and NONE of them is `push`.
   *
   * WHY NOT `push`: the design's verb table rewrote `push` to truncate the
   * forward half and append without deduping. But `push` is WORK's verb — its
   * dedupe-and-raise is the single-host law (WLT §5.2c), it is declared in
   * `shell/nav-port.ts`'s `NavPort` contract, and `WorkspaceView`/`GateApp`
   * call it in sixteen places. U1 says Work stays as it is, so the Trail got
   * its own verbs and `push` was left alone.
   */
  /**
   * A LIST click roots the Trail (U10): it RESTARTS at this entity, cursor 0.
   */
  openCenter(id: EntityId): void;
  /**
   * A HOP — a connection hop and a hierarchy hop are the same gesture now (U2).
   *
   * A REVISIT MOVES THE CURSOR (ruled 2026-09-22): hopping to an entity already
   * on the Trail seeks to it rather than appending a second crumb, so the Trail
   * stays a PATH and not a log. Anywhere new from mid-Trail discards the
   * forward half (U5) — that is the one thing that truncates it.
   */
  trailPush(id: EntityId): void;
  /**
   * Crumb click (and the jump menu, D6): seek the cursor to `id`. THE TRAIL IS
   * NOT TOUCHED — what is ahead of you stays ahead of you (U5). This is the
   * verb that used to be `stackTo`, which truncated.
   */
  cursorTo(id: EntityId): void;
  /** Esc / one hop back along the Trail. Clamped; never truncates (U11/D7). */
  trailBack(): void;
  /** One hop forward along the Trail. Clamped. */
  trailForward(): void;
  /** Return the centre to its resting state (Home: the conversation). */
  clearStack(): void;
}

export type NavStore = NavState & NavActions;

const INITIAL: NavState = {
  spaceId: '',
  view: { view: 'home' },
  stack: [],
  pinned: [],
  cursor: 0,
  tabs: {},
  contentSurface: {},
  session: null,
  history: 'replace',
  revision: 0,
};

/** Prune per-panel state for ids that are no longer open. */
function pruned(
  state: Pick<NavState, 'tabs' | 'contentSurface'>,
  open: ReadonlySet<EntityId>,
): Pick<NavState, 'tabs' | 'contentSurface'> {
  const tabs: Record<EntityId, PanelTab> = {};
  for (const [id, tab] of Object.entries(state.tabs)) if (open.has(id)) tabs[id] = tab;
  const contentSurface: Record<EntityId, ContentSurface> = {};
  for (const [id, s] of Object.entries(state.contentSurface)) if (open.has(id)) contentSurface[id] = s;
  return { tabs, contentSurface };
}

function sameIds(a: readonly EntityId[], b: readonly EntityId[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * The cursor invariant, in ONE place. Out of range is not a state this store
 * can hold: a cursor past the end renders a blank centre from an address that
 * looks well-formed, which is the hardest kind of wrong to see.
 */
function clampCursor(stack: readonly EntityId[], cursor: number): number {
  if (stack.length === 0) return 0;
  if (!Number.isInteger(cursor) || cursor < 0) return 0;
  return Math.min(cursor, stack.length - 1);
}

/**
 * Where every NON-TRAIL verb parks the cursor: the top.
 *
 * This is what keeps U1 true. Work moves `stack` through `push`/`pop`/`close`/
 * `pin`/`unpin`/`promote`/`applyNormalization` and reads `stack[length - 1]`;
 * parking the cursor at the top after each means Work's read and Home's
 * `stack[cursor]` cannot disagree on any path Work can take.
 */
function atTop(stack: readonly EntityId[]): number {
  return stack.length === 0 ? 0 : stack.length - 1;
}

export const navStore: StoreApi<NavStore> = createStore<NavStore>()((set, get) => ({
  ...INITIAL,

  hydrate(route) {
    // Cross-set dedup with precedence pin > stack happens in `normalize`,
    // BEFORE first render (WLT §2.2).
    const canonical = normalize(route);
    const { cursor: cursorId, ...panels } = canonical.panels;
    /* THE ONE PLACE THE WIRE ID BECOMES AN INDEX, and it resolves against the
       ALREADY-NORMALIZED stack — which is the whole reason the wire carries an
       id. Resolving before normalization would re-introduce exactly the shift
       the id exists to absorb. Absent (or omitted) ⇒ the top, per D2. */
    const at = cursorId === null ? -1 : panels.stack.indexOf(cursorId);
    set((s) => ({
      spaceId: canonical.spaceId,
      view: canonical.target,
      ...panels,
      cursor: at === -1 ? atTop(panels.stack) : at,
      history: 'replace',
      revision: s.revision + 1,
    }));
  },

  navigate(view) {
    set((s) => ({ view, history: 'push', revision: s.revision + 1 }));
  },

  setSpace(spaceId) {
    // Idempotent: re-selecting the space you are already in must not bump the
    // revision, or the router would write an identical URL and the debounced
    // replace loop would never settle.
    if (get().spaceId === spaceId) return;
    set((s) => ({ spaceId, history: 'replace', revision: s.revision + 1 }));
  },

  push(id) {
    const s = get();
    // Already pinned: opening it again RAISES/focuses rather than duplicating
    // it onto the stack (single-host law, WLT §5.2c).
    if (s.pinned.includes(id)) {
      set({ history: 'push', revision: s.revision + 1 });
      return;
    }
    const stack = [...s.stack.filter((x) => x !== id), id];
    set({ stack, cursor: atTop(stack), history: 'push', revision: s.revision + 1 });
  },

  pop() {
    const s = get();
    if (s.stack.length === 0) return;
    const stack = s.stack.slice(0, -1);
    const open = new Set([...stack, ...s.pinned]);
    set({ stack, cursor: atTop(stack), ...pruned(s, open), history: 'push', revision: s.revision + 1 });
  },

  close(id) {
    const s = get();
    if (!s.stack.includes(id) && !s.pinned.includes(id)) return;
    const stack = s.stack.filter((x) => x !== id);
    const pinned = s.pinned.filter((x) => x !== id);
    const open = new Set([...stack, ...pinned]);
    set({ stack, pinned, cursor: atTop(stack), ...pruned(s, open), history: 'push', revision: s.revision + 1 });
  },

  pin(id) {
    const s = get();
    if (s.pinned.includes(id)) return { ok: true };
    if (s.pinned.length >= MAX_PINNED) return { ok: false, reason: `${MAX_PINNED} pins max` };
    const stack = s.stack.filter((x) => x !== id);
    set({
      stack,
      pinned: [...s.pinned, id],
      cursor: atTop(stack),
      history: 'push',
      revision: s.revision + 1,
    });
    return { ok: true };
  },

  unpin(id) {
    const s = get();
    if (!s.pinned.includes(id)) return;
    const stack = [...s.stack.filter((x) => x !== id), id];
    set({
      pinned: s.pinned.filter((x) => x !== id),
      stack,
      cursor: atTop(stack),
      history: 'push',
      revision: s.revision + 1,
    });
  },

  promote(id) {
    const s = get();
    const stack = s.stack.filter((x) => x !== id);
    const pinned = s.pinned.filter((x) => x !== id);
    const open = new Set([...stack, ...pinned]);
    // `origin` is preserved across the promotion so the Z4 screen knows the
    // companion to return to (WLT §2.2 canonical-reload rule).
    const origin =
      s.view.view === 'kind' ? { slug: s.view.slug, mode: s.view.mode } : null;
    set({
      stack,
      pinned,
      cursor: atTop(stack),
      ...pruned(s, open),
      view: { view: 'entity', entityId: id, origin },
      history: 'push',
      revision: s.revision + 1,
    });
  },

  setTab(id, tab) {
    const s = get();
    if (s.tabs[id] === tab) return;
    const tabs = { ...s.tabs };
    // An omitted pair already means `content` — keeping it explicit would make
    // the URL non-canonical.
    if (tab === 'content') delete tabs[id];
    else tabs[id] = tab;
    set({ tabs, history: 'replace', revision: s.revision + 1 });
  },

  setContentSurface(id, surface) {
    const s = get();
    if (s.contentSurface[id] === surface) return;
    // A surface toggle is viewer-local presentation state: replaceState, not a
    // new history entry (WLT §2.2).
    set({
      contentSurface: { ...s.contentSurface, [id]: surface },
      history: 'replace',
      revision: s.revision + 1,
    });
  },

  setSession(id) {
    const s = get();
    if (s.session === id) return;
    set({ session: id, history: 'replace', revision: s.revision + 1 });
  },

  applyNormalization(next) {
    const s = get();
    if (sameIds(s.stack, next.stack) && sameIds(s.pinned, next.pinned)) return;
    const open = new Set([...next.stack, ...next.pinned]);
    set({
      stack: [...next.stack],
      pinned: [...next.pinned],
      cursor: atTop(next.stack),
      ...pruned(s, open),
      history: 'replace',
      revision: s.revision + 1,
    });
  },

  openCenter(id) {
    const s = get();
    if (s.stack.length === 1 && s.stack[0] === id && s.cursor === 0) {
      set({ history: 'push', revision: s.revision + 1 });
      return;
    }
    const stack = [id];
    const open = new Set([...stack, ...s.pinned]);
    set({ stack, cursor: 0, ...pruned(s, open), history: 'push', revision: s.revision + 1 });
  },

  trailPush(id) {
    const s = get();
    const at = s.stack.indexOf(id);
    /* A REVISIT SEEKS, it does not append (ruled 2026-09-22). Walking
       `a → b → a` leaves `[a, b]` with the cursor back at `a` and `b` still
       ahead of you, rather than growing a third crumb naming a place already
       on the Trail. Two reasons it has to be this way round and not the
       design's: `normalize` dedupes `p` (codec.ts), so a repeated crumb would
       be collapsed by the very next URL write and the Trail would disagree
       with its own address; and a Trail that can repeat is a LOG, while the
       thing this screen is for is a PATH. */
    if (at !== -1) {
      if (at === s.cursor) {
        set({ history: 'push', revision: s.revision + 1 });
        return;
      }
      set({ cursor: at, history: 'push', revision: s.revision + 1 });
      return;
    }
    /* SOMEWHERE NEW FROM MID-TRAIL DISCARDS THE FORWARD HALF (U5). This is
       the ONLY verb that shortens the Trail — `cursorTo` and `trailBack`
       deliberately do not, which is the whole of "keep forward". */
    /* A KNOWN STORE/ADDRESS DIVERGENCE, ACCEPTED (#653 review, Q1). An entity
       PINNED in Work is appended here like any other, so Home renders it —
       but `normalize`'s pin cross-filter (pin outranks stack: one id, one
       host) strips it from `p`, so the address never carries this hop and a
       reload lands one crumb back. `openCenter` has the same edge (a reload
       lands on the empty centre). The alternatives are worse: refusing the hop
       fails a legitimate click for a reason the viewer cannot see, unpinning
       lets Home mutate Work's pins (U1), and exempting `p` from the filter
       hosts one id twice. Needs an entity pinned in Work AND reached from Home
       in the same session. */
    const stack = [...s.stack.slice(0, s.cursor + 1), id];
    const open = new Set([...stack, ...s.pinned]);
    set({
      stack,
      cursor: stack.length - 1,
      ...pruned(s, open),
      history: 'push',
      revision: s.revision + 1,
    });
  },

  cursorTo(id) {
    const s = get();
    const at = s.stack.indexOf(id);
    if (at === -1 || at === s.cursor) return;
    // THE TRAIL IS UNTOUCHED — no `pruned` call, because nothing closed.
    set({ cursor: at, history: 'push', revision: s.revision + 1 });
  },

  trailBack() {
    const s = get();
    if (s.cursor <= 0) return;
    set({ cursor: s.cursor - 1, history: 'push', revision: s.revision + 1 });
  },

  trailForward() {
    const s = get();
    if (s.cursor >= s.stack.length - 1) return;
    set({ cursor: s.cursor + 1, history: 'push', revision: s.revision + 1 });
  },

  clearStack() {
    const s = get();
    if (s.stack.length === 0) return;
    const open = new Set([...s.pinned]);
    set({ stack: [], cursor: 0, ...pruned(s, open), history: 'push', revision: s.revision + 1 });
  },
}));

export function useNavStore<T>(selector: (state: NavStore) => T): T {
  return useStore(navStore, selector);
}

// ---------------------------------------------------------------------------
// Selectors (pure functions of NavState)
// ---------------------------------------------------------------------------

/**
 * The panels that RENDER AS COLUMNS, in order: pinned first, then the stack
 * TOP — because the stack is a stack, and only its top occupies a column.
 *
 * This used to return `[...pinned, ...stack]` while its docblock said "render
 * order", which put it in direct disagreement with `selectVisibleCount` two
 * functions below: one said N stack entries were columns, the other reserved
 * width for exactly one. A consumer rendering this list would have drawn more
 * columns than `cMin(V)` had reserved and squeezed every panel below its 320
 * floor — an L4 violation delivered by a selector whose NAME was right and
 * whose BODY was not. A1b read the docblock, reported what it implied, and was
 * reading it correctly; the body was the lie.
 *
 * The two are now derived from the same rule, and `panel-render-order` in the
 * test suite asserts `selectPanelIds(s).length === selectVisibleCount(s)` so
 * they cannot drift apart again.
 */
export function selectPanelIds(s: NavState): EntityId[] {
  const top = selectStackTop(s);
  return top === null ? [...s.pinned] : [...s.pinned, top];
}

/**
 * EVERY open panel id, pins and the whole stack — for membership questions
 * ("is this entity open?", pruning per-panel state), NOT for rendering. Named
 * apart from `selectPanelIds` on purpose: the two answer different questions
 * and conflating them is what produced the defect above.
 */
export function selectOpenPanelIds(s: NavState): EntityId[] {
  return [...s.pinned, ...s.stack];
}

/**
 * V — the C_min input. Named once, here, so the store and the shell's
 * `cMin(V)` cannot drift on the definition (LLD §5.1).
 */
export function selectVisibleCount(s: NavState): number {
  return s.pinned.length + (s.stack.length > 0 ? 1 : 0);
}

export function selectStackTop(s: NavState): EntityId | null {
  return s.stack.length ? s.stack[s.stack.length - 1] : null;
}

/**
 * WHAT HOME RENDERS — `stack[cursor]`, the entity the viewer is standing on.
 *
 * Named APART from `selectStackTop` on purpose, and both are kept: they answer
 * different questions and the difference is the whole feature. Work renders the
 * TOP of its panel stack (U1, untouched); Home renders the CURSOR's entry, which
 * is the top only until you walk back. Collapsing them into one selector is how
 * "keep forward" would quietly stop being true.
 */
export function selectTrailEntity(s: NavState): EntityId | null {
  if (s.stack.length === 0) return null;
  return s.stack[clampCursor(s.stack, s.cursor)] ?? null;
}

/** The Trail's root — crumb 0, which is where `openCenter` planted it. */
export function selectTrailRoot(s: NavState): EntityId | null {
  return s.stack.length ? s.stack[0]! : null;
}

export function selectIsPinned(s: NavState, id: EntityId): boolean {
  return s.pinned.includes(id);
}

export function selectTab(s: NavState, id: EntityId): PanelTab {
  return s.tabs[id] ?? 'content';
}

/**
 * The URL's surface value for a panel, PRESERVED verbatim (D12) — including
 * `chat`, which Phase 1 clamps at RENDER time, never in state and never in the
 * URL. `null` means the URL said nothing.
 */
export function selectSurface(s: NavState, id: EntityId): ContentSurface | null {
  return s.contentSurface[id] ?? null;
}

/** Empty centre: the live-session roster + grammar hint renders (02-LAYOUT §2.2). */
export function selectIsCentreEmpty(s: NavState): boolean {
  return s.stack.length === 0 && s.pinned.length === 0;
}

/** `?session=` auto-opens ONLY when `p` and `pin` are both absent (WLT §2.2). */
export function selectAutoOpenSession(s: NavState): EntityId | null {
  return selectIsCentreEmpty(s) ? s.session : null;
}

export function routeOf(s: NavState): Route {
  const panels: PanelState = {
    stack: s.stack,
    pinned: s.pinned,
    /* NULL AT THE TOP so `pc` is omitted — "omitted ⇒ the top" (D2) is what
       makes every link that exists today build byte-identically. */
    cursor: s.cursor >= s.stack.length - 1 ? null : (s.stack[s.cursor] ?? null),
    tabs: s.tabs,
    contentSurface: s.contentSurface,
    session: s.session,
  };
  return { spaceId: s.spaceId, target: s.view, panels };
}

// ---------------------------------------------------------------------------
// Router sync — the loop rebuilt fresh (the old `startRouter` is a pattern
// reference only; it was hard-coupled to the old nav store)
// ---------------------------------------------------------------------------

export interface RouterSyncOptions {
  lastActiveSpaceId?: SpaceId | null;
  /** One debounced write per settle (LLD §6). */
  replaceDebounceMs?: number;
  /** The ONE generalized R4-7 notice, plus the deferred-feature redirect notice. */
  onNotice?: (notice: RouteNotice) => void;
  /** No addressable space in the hash ⇒ the space picker renders. */
  onSpacePicker?: () => void;
}

export type RouteNotice =
  | { kind: 'dropped'; classes: DropClass[]; text: string }
  | { kind: 'deferred-feature'; feature: 'graph' | 'leaderboard'; text: string };

/**
 * Bidirectional URL mirroring. Returns a detach function.
 *
 * Direction in:  hash → redirect → parse → normalize → `hydrate`.
 * Direction out: state → `build` → `setHash`, `push` or debounced `replace`
 *                per the transition's own history discipline.
 */
export function attachRouter(target: RouterTarget, opts: RouterSyncOptions = {}): () => void {
  const debounceMs = opts.replaceDebounceMs ?? 50;
  let applying = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastWritten: string | null = null;

  const notice = (n: RouteNotice) => opts.onNotice?.(n);

  const readFromHash = (hash: string) => {
    const redirected = redirect(hash, { lastActiveSpaceId: opts.lastActiveSpaceId });
    let effective = hash;
    if (redirected) {
      effective = redirected.hash;
      if (redirected.deferredFeature) {
        // COMPOSED from the canonical reason, never restated. An earlier
        // version authored a second sentence here that merely resembled
        // REASONS — the drift class A1c found in the terminal surfaces, in
        // this file, written by me. A reworded REASONS entry must change this
        // notice too, and composition is what guarantees it does.
        // `graph` left the deferred set on 2026-08-14 (its screen shipped), so
        // the fork this composed across is gone and only the leaderboard
        // remains. Still COMPOSED rather than restated, for the same reason.
        notice({
          kind: 'deferred-feature',
          feature: redirected.deferredFeature,
          text: `${REASONS.leaderboardDeferred} You’ve landed on Home.`,
        });
      }
    }

    const outcome = parse(effective);
    if (outcome.route === null) {
      opts.onSpacePicker?.();
      return;
    }
    if (outcome.dropped.length) {
      const text = dropNoticeText(outcome.dropped);
      if (text) notice({ kind: 'dropped', classes: outcome.dropped, text });
    }

    applying = true;
    try {
      navStore.getState().hydrate(outcome.route);
      /*
       * THE ADDRESS LEADS THE SCREEN STACK — but ONLY here, and "here" is the
       * whole rule. This path runs for back, forward, a pasted hash and a
       * reload, and is already filtered against store-led writes by `applying`
       * and `lastWritten` above. So the split falls out of the loop's existing
       * shape rather than being asserted on top of it:
       *
       *   viewer moved the STACK   (a row, Esc) → stack leads, URL follows
       *   viewer moved the ADDRESS (back, paste) → address leads, stack follows
       *
       * WITHOUT THIS, BACK WAS A TRAP. `GateApp` seeds the stack from an address
       * that names an entity and has no branch for one that names none, so back
       * from `e/A?origin=tasks` to `k/tasks` left the stack holding `[A]` and the
       * screen→URL sync pushed `e/A` straight back — returning the viewer to the
       * entity they had just left, on the exact entry path a shared link creates.
       *
       * INSIDE the `applying` window deliberately: this and `hydrate` are one
       * atomic answer to one inbound address, and a subscriber that observed the
       * store between them would see a screen stack disagreeing with the view it
       * belongs to. See `backContract.ts` for the contract, and
       * `docs/features/mobile/BACK-CONTRACT.md` for why it is this way round.
       *
       * READ BACK THE HYDRATED VIEW rather than `outcome.route.target`. The two
       * are the same string today — `normalize` passes `target` through — but the
       * value that must drive the stack is the one that will RENDER, and taking
       * it from the store is what keeps that true if normalization ever gains a
       * target rule. A stack keyed off a pre-normalization target would be a
       * silent mis-seed, which is the failure class hardest to see.
       */
      reconcileScreenStacks(navStore.getState().view);
    } finally {
      applying = false;
    }
    // A redirect or a non-canonical hash is rewritten in place, never pushed.
    writeNow(true);
  };

  const writeNow = (replace: boolean) => {
    const state = navStore.getState();
    if (!state.spaceId) return;
    const outcome = build(normalize(routeOf(state)));
    if (outcome.dropped.length) {
      const text = dropNoticeText(outcome.dropped);
      if (text) notice({ kind: 'dropped', classes: outcome.dropped, text });
    }
    if (outcome.hash === lastWritten || outcome.hash === target.getHash()) {
      lastWritten = outcome.hash;
      return;
    }
    lastWritten = outcome.hash;
    target.setHash(outcome.hash, { replace });
  };

  const unsubscribeTarget = target.subscribe((hash) => {
    if (applying) return;
    if (hash === lastWritten) return;
    readFromHash(hash);
  });

  let lastRevision = navStore.getState().revision;
  const unsubscribeStore = navStore.subscribe((state) => {
    if (applying) return;
    if (state.revision === lastRevision) return;
    lastRevision = state.revision;
    if (state.history === 'push') {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      writeNow(false);
      return;
    }
    // Debounced, idempotent: exactly one replaceState per settle.
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      writeNow(true);
    }, debounceMs);
  });

  readFromHash(target.getHash());

  return () => {
    if (timer) clearTimeout(timer);
    unsubscribeTarget();
    unsubscribeStore();
  };
}

/** Test/boot helper: reset the store to a clean space. */
export function resetNav(spaceId: SpaceId = '', view: NavView = { view: 'home' }): void {
  const { cursor: _cursorId, ...panels } = defaultRoute(spaceId, view).panels;
  // `cursor` is an INDEX in state and an ID in `PanelState`; a default route
  // has an empty stack, so the index is 0 and the id it would resolve is none.
  navStore.setState({ ...INITIAL, ...panels, cursor: 0, spaceId, view });
}
