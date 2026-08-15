/**
 * Panel-engine unit tests (LLD §15.4) + the URL-mirroring loop.
 *
 * Covered: push dedup/raise · Esc pops stack only · pin refusal reason ·
 * promote removes from BOTH sets · hydration dedup pin > stack ·
 * `applyNormalization` as a no-op when nothing settled · history discipline
 * (push vs debounced replace) · the D12 surface value surviving state.
 *
 * NOT covered here, deliberately: `C_min`, the admission predicate and the
 * demotion loop. Those are A1b's pure geometry (LLD §5.3) and have their own
 * tests — this store consumes their RESULT and owns no copy of the law.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_PINNED,
  attachRouter,
  navStore,
  resetNav,
  routeOf,
  selectAutoOpenSession,
  selectIsCentreEmpty,
  selectIsPinned,
  selectPanelIds,
  selectOpenPanelIds,
  selectStackTop,
  selectSurface,
  selectTab,
  selectVisibleCount,
  type RouteNotice,
} from './navStore';
import { build, createMemoryTarget, parse } from '../routes';

const SPACE = 'space-1';
const A = 'entity-a';
const B = 'entity-b';
const C = 'entity-c';
const D = 'entity-d';

const nav = () => navStore.getState();

beforeEach(() => {
  resetNav(SPACE, { view: 'workspace' });
});

describe('stack', () => {
  it('pushes bottom→top and dedupes by RAISING, never doubling', () => {
    nav().push(A);
    nav().push(B);
    nav().push(A);
    // Single-host law: an already-open id is raised to the top, not duplicated.
    expect(nav().stack).toEqual([B, A]);
    expect(selectStackTop(nav())).toBe(A);
  });

  it('raises rather than re-stacking an already PINNED id', () => {
    nav().push(A);
    nav().pin(A);
    nav().push(A);
    expect(nav().pinned).toEqual([A]);
    expect(nav().stack).toEqual([]);
  });

  it('pops the stack top only — never a pin', () => {
    nav().push(A);
    nav().pin(A);
    nav().push(B);
    nav().pop();
    expect(nav().stack).toEqual([]);
    expect(nav().pinned).toEqual([A]);
    // Popping an empty stack is a no-op, not an error and not a pin removal.
    nav().pop();
    expect(nav().pinned).toEqual([A]);
  });

  it('prunes per-panel state when a panel closes', () => {
    nav().push(A);
    nav().setTab(A, 'activity');
    nav().setContentSurface(A, 'chat');
    nav().pop();
    expect(nav().tabs).toEqual({});
    expect(nav().contentSurface).toEqual({});
  });
});

describe('pin / unpin', () => {
  it('moves stack → pinned', () => {
    nav().push(A);
    expect(nav().pin(A)).toEqual({ ok: true });
    expect(nav().stack).toEqual([]);
    expect(nav().pinned).toEqual([A]);
    expect(selectIsPinned(nav(), A)).toBe(true);
  });

  it('refuses the fourth pin WITH A REASON — never a silent no-op (L6)', () => {
    for (const id of [A, B, C]) expect(nav().pin(id)).toEqual({ ok: true });
    const refusal = nav().pin(D);
    expect(refusal.ok).toBe(false);
    if (!refusal.ok) expect(refusal.reason).toBe(`${MAX_PINNED} pins max`);
    expect(nav().pinned).toHaveLength(MAX_PINNED);
  });

  it('treats re-pinning an already-pinned id as satisfied, not refused', () => {
    nav().pin(A);
    expect(nav().pin(A)).toEqual({ ok: true });
    expect(nav().pinned).toEqual([A]);
  });

  it('unpins onto the stack TOP', () => {
    nav().push(A);
    nav().pin(B);
    nav().unpin(B);
    expect(nav().pinned).toEqual([]);
    expect(nav().stack).toEqual([A, B]);
  });
});

describe('promote to Z4', () => {
  it('removes the id from BOTH sets (the inherited promotePanel gap)', () => {
    nav().push(A);
    nav().pin(B);
    nav().promote(B);
    expect(nav().pinned).toEqual([]);
    expect(nav().stack).toEqual([A]);
    expect(nav().view).toEqual({ view: 'entity', entityId: B, origin: null });
  });

  it('preserves origin when promoting out of a kind view', () => {
    navStore.setState({ view: { view: 'kind', slug: 'sessions', mode: 'tree', q: null } });
    nav().push(A);
    nav().promote(A);
    expect(nav().view).toEqual({
      view: 'entity',
      entityId: A,
      origin: { slug: 'sessions', mode: 'tree' },
    });
  });
});

describe('hydration', () => {
  it('dedupes across sets with precedence PIN > STACK, before first render', () => {
    nav().hydrate({
      spaceId: SPACE,
      target: { view: 'workspace' },
      panels: { stack: [A, B], pinned: [A], tabs: {}, contentSurface: {}, session: null },
    });
    expect(nav().pinned).toEqual([A]);
    expect(nav().stack).toEqual([B]);
  });

  it('preserves a chat surface value verbatim (D12)', () => {
    nav().hydrate({
      spaceId: SPACE,
      target: { view: 'workspace' },
      panels: { stack: [A], pinned: [], tabs: {}, contentSurface: { [A]: 'chat' }, session: null },
    });
    // State never clamps: clamping is a RENDER decision, so the value survives
    // for Phase 2 and for the URL the viewer will share.
    expect(selectSurface(nav(), A)).toBe('chat');
  });

  it('hydrates as a replace — a reload is not a new history entry', () => {
    nav().hydrate({
      spaceId: SPACE,
      target: { view: 'home' },
      panels: { stack: [], pinned: [], tabs: {}, contentSurface: {}, session: null },
    });
    expect(nav().history).toBe('replace');
  });
});

describe('applyNormalization — the shell geometry seam', () => {
  it('applies the settled result the shell hands back', () => {
    nav().push(A);
    nav().pin(B);
    nav().applyNormalization({ stack: [A, B], pinned: [] });
    expect(nav().pinned).toEqual([]);
    expect(nav().stack).toEqual([A, B]);
  });

  it('is a NO-OP when nothing settled — the "one replaceState per settle" law', () => {
    nav().push(A);
    const before = nav().revision;
    nav().applyNormalization({ stack: [A], pinned: [] });
    // No revision bump ⇒ the router sync never fires ⇒ no history write at all.
    expect(nav().revision).toBe(before);
  });

  it('settles as a replace, never a push', () => {
    nav().push(A);
    nav().pin(A);
    nav().applyNormalization({ stack: [A], pinned: [] });
    expect(nav().history).toBe('replace');
  });
});

describe('selectors', () => {
  it('computes V = pins + (stack non-empty ? 1 : 0) — the C_min input', () => {
    expect(selectVisibleCount(nav())).toBe(0);
    nav().push(A);
    expect(selectVisibleCount(nav())).toBe(1);
    nav().push(B);
    // A second stack entry does NOT add a column: only the top renders.
    expect(selectVisibleCount(nav())).toBe(1);
    nav().pin(A);
    expect(selectVisibleCount(nav())).toBe(2);
  });

  it('renders pinned columns then the stack TOP — not the whole stack', () => {
    nav().push(A);
    nav().push(B);
    nav().pin(C);
    // Only the top of the stack occupies a column; A is behind B, not beside it.
    expect(selectPanelIds(nav())).toEqual([C, B]);
    // Membership is a different question and has its own selector.
    expect(selectOpenPanelIds(nav())).toEqual([C, A, B]);
  });

  it('panel-render-order: the column list and V can never disagree', () => {
    // THE invariant. selectVisibleCount is A1b's cMin(V) input; if these two
    // drift, the geometry reserves width for a different number of columns
    // than the shell draws, and every panel is squeezed below its floor.
    const cases: (() => void)[] = [
      () => {},
      () => nav().push(A),
      () => {
        nav().push(A);
        nav().push(B);
      },
      () => {
        nav().push(A);
        nav().pin(B);
      },
      () => {
        nav().push(A);
        nav().push(B);
        nav().pin(C);
        nav().pin(D);
      },
    ];
    for (const setup of cases) {
      resetNav(SPACE, { view: 'workspace' });
      setup();
      expect(selectPanelIds(nav())).toHaveLength(selectVisibleCount(nav()));
    }
  });

  it('defaults an unrecorded tab to content and an unrecorded surface to null', () => {
    expect(selectTab(nav(), A)).toBe('content');
    // null means "the URL said nothing" — distinct from an explicit terminal.
    expect(selectSurface(nav(), A)).toBeNull();
  });

  it('auto-opens ?session= only when both p and pin are absent', () => {
    nav().setSession(A);
    expect(selectIsCentreEmpty(nav())).toBe(true);
    expect(selectAutoOpenSession(nav())).toBe(A);
    nav().push(B);
    // Explicit panel state wins; the param is preserved, just not acted on.
    expect(selectAutoOpenSession(nav())).toBeNull();
    expect(nav().session).toBe(A);
  });
});

describe('tab and surface writes', () => {
  it('drops an explicit content tab — an omitted pair already means content', () => {
    nav().push(A);
    nav().setTab(A, 'activity');
    expect(nav().tabs[A]).toBe('activity');
    nav().setTab(A, 'content');
    expect(nav().tabs).toEqual({});
  });

  it('treats a surface toggle as replace-history presentation state', () => {
    nav().push(A);
    nav().setContentSurface(A, 'chat');
    expect(nav().history).toBe('replace');
    expect(nav().contentSurface[A]).toBe('chat');
  });
});

describe('the router sync loop', () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

  it('hydrates from the hash on attach', async () => {
    const target = createMemoryTarget(`#/s/${SPACE}/workspace?p=${A}&pin=${B}`);
    const detach = attachRouter(target, { replaceDebounceMs: 0 });
    expect(nav().spaceId).toBe(SPACE);
    expect(nav().stack).toEqual([A]);
    expect(nav().pinned).toEqual([B]);
    detach();
  });

  it('applies a legacy redirect and reports the deferred feature (R7)', async () => {
    const notices: RouteNotice[] = [];
    const target = createMemoryTarget(`#/s/${SPACE}/leaderboard`);
    const detach = attachRouter(target, { replaceDebounceMs: 0, onNotice: (n) => notices.push(n) });
    expect(nav().view).toEqual({ view: 'home' });
    expect(notices).toContainEqual(
      expect.objectContaining({ kind: 'deferred-feature', feature: 'leaderboard' }),
    );
    detach();
  });

  it('hydrates the four newly-routed screens instead of deferring them', async () => {
    // graph/files/git/messages rendered from the rail with no route at all, so
    // none of them could be reloaded into or shared. `graph` additionally had
    // to be un-deferred: it was redirected to Home with a notice about a screen
    // that has been built and mounted for some time.
    for (const view of ['graph', 'files', 'git', 'messages'] as const) {
      const notices: RouteNotice[] = [];
      const target = createMemoryTarget(`#/s/${SPACE}/${view}`);
      const detach = attachRouter(target, {
        replaceDebounceMs: 0,
        onNotice: (n) => notices.push(n),
      });
      expect(nav().view, `${view} did not hydrate`).toEqual({ view });
      expect(notices, `${view} reported a notice`).toEqual([]);
      expect(target.getHash()).toBe(`#/s/${SPACE}/${view}`);
      detach();
    }
  });

  it('emits ONE generalized drop notice, class-named and free of raw IDs (R4-7)', async () => {
    const notices: RouteNotice[] = [];
    const target = createMemoryTarget(`#/s/${SPACE}/workspace?p=${A}&t=${A}:nonsense`);
    const detach = attachRouter(target, { replaceDebounceMs: 0, onNotice: (n) => notices.push(n) });
    const drops = notices.filter((n) => n.kind === 'dropped');
    expect(drops).toHaveLength(1);
    expect(drops[0].text).not.toContain(A);
    detach();
  });

  it('pushes user navigation and REPLACES a normalization settle', async () => {
    const target = createMemoryTarget(`#/s/${SPACE}/workspace`);
    const detach = attachRouter(target, { replaceDebounceMs: 0 });
    const entriesAtStart = target.entries.length;

    nav().push(A);
    await flush();
    expect(target.entries.length).toBe(entriesAtStart + 1);
    expect(target.getHash()).toContain(`p=${A}`);

    nav().pin(A);
    await flush();
    const afterPin = target.entries.length;

    // A settle rewrites in place: the back button must not walk demotions.
    nav().applyNormalization({ stack: [A], pinned: [] });
    await flush();
    expect(target.entries.length).toBe(afterPin);
    expect(target.getHash()).toContain(`p=${A}`);
    expect(target.getHash()).not.toContain('pin=');
    detach();
  });

  it('round-trips an external hash change back into the store', async () => {
    const target = createMemoryTarget(`#/s/${SPACE}/workspace`);
    const detach = attachRouter(target, { replaceDebounceMs: 0 });
    target.setHash(`#/s/${SPACE}/k/tasks?mode=board`);
    await flush();
    expect(nav().view).toEqual({ view: 'kind', slug: 'tasks', mode: 'board', q: null });
    detach();
  });

  it('reports the space picker when the hash addresses no space', () => {
    let picker = 0;
    const target = createMemoryTarget('#/');
    const detach = attachRouter(target, { replaceDebounceMs: 0, onSpacePicker: () => (picker += 1) });
    expect(picker).toBe(1);
    detach();
  });

  it('mirrors the store through the SAME codec the URL is read with', () => {
    nav().push(A);
    nav().pin(B);
    nav().setContentSurface(B, 'chat');
    const { hash } = build(routeOf(nav()));
    const reparsed = parse(hash).route!;
    expect(reparsed.panels.stack).toEqual([A]);
    expect(reparsed.panels.pinned).toEqual([B]);
    expect(reparsed.panels.contentSurface[B]).toBe('chat');
  });
});
