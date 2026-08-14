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

/** WLT §5.2 / SPEC-FINAL: three pins, no more. */
export const MAX_PINNED = 3;

/** Which chrome a panel instance renders in. Anatomy never varies (LLD §3.2). */
export type PanelHost = 'stack' | 'pinned' | 'peek' | 'z4';

export interface NavState {
  spaceId: SpaceId;
  view: NavView;
  /** bottom → top. */
  stack: EntityId[];
  /** pin order. */
  pinned: EntityId[];
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
}

export type NavStore = NavState & NavActions;

const INITIAL: NavState = {
  spaceId: '',
  view: { view: 'home' },
  stack: [],
  pinned: [],
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

export const navStore: StoreApi<NavStore> = createStore<NavStore>()((set, get) => ({
  ...INITIAL,

  hydrate(route) {
    // Cross-set dedup with precedence pin > stack happens in `normalize`,
    // BEFORE first render (WLT §2.2).
    const canonical = normalize(route);
    set((s) => ({
      spaceId: canonical.spaceId,
      view: canonical.target,
      ...canonical.panels,
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
    set({ stack, history: 'push', revision: s.revision + 1 });
  },

  pop() {
    const s = get();
    if (s.stack.length === 0) return;
    const stack = s.stack.slice(0, -1);
    const open = new Set([...stack, ...s.pinned]);
    set({ stack, ...pruned(s, open), history: 'push', revision: s.revision + 1 });
  },

  close(id) {
    const s = get();
    if (!s.stack.includes(id) && !s.pinned.includes(id)) return;
    const stack = s.stack.filter((x) => x !== id);
    const pinned = s.pinned.filter((x) => x !== id);
    const open = new Set([...stack, ...pinned]);
    set({ stack, pinned, ...pruned(s, open), history: 'push', revision: s.revision + 1 });
  },

  pin(id) {
    const s = get();
    if (s.pinned.includes(id)) return { ok: true };
    if (s.pinned.length >= MAX_PINNED) return { ok: false, reason: `${MAX_PINNED} pins max` };
    set({
      stack: s.stack.filter((x) => x !== id),
      pinned: [...s.pinned, id],
      history: 'push',
      revision: s.revision + 1,
    });
    return { ok: true };
  },

  unpin(id) {
    const s = get();
    if (!s.pinned.includes(id)) return;
    set({
      pinned: s.pinned.filter((x) => x !== id),
      stack: [...s.stack.filter((x) => x !== id), id],
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
      ...pruned(s, open),
      history: 'replace',
      revision: s.revision + 1,
    });
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
  navStore.setState({ ...INITIAL, ...defaultRoute(spaceId, view).panels, spaceId, view });
}
