/**
 * THE PHONE LIST — one row anatomy for every entity kind (task t-lists).
 *
 * Built to the phone entity-lists mockup (artifact 01a14cc0): a header with
 * the count, ⚙ sort & filter and ＋; a 44px search field at 16px; rows of
 * glyph · title · time over one meta line; skeleton, empty, no-results,
 * paging and offline states; press-and-hold for a row's actions.
 *
 * WHY NOT THE DESKTOP LIST, SQUEEZED. `EntityListPanel` is a dense tile list
 * with an inline control cluster per row, a filter bar and an expandable strip
 * — every one of which was made to fit 390px by shrinking it. A phone list's
 * whole job is to get you to the entity (CONTRACT §4: a list whose purpose is
 * navigation PUSHES), so its row carries what you scan by and nothing you
 * edit; the edits live on the entity screen one tap away.
 *
 * Mounted ONLY on the phone shell, by `EntityView` behind `oneSurface`. The
 * desktop list is untouched.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import type { EntityCapabilities, EntitySummary, SpaceId } from '@tm8/contract';
import { KindIcon, type KindConfig, type ListPageState, type SortKey } from '../domain';
import { VectorIcon } from '../kit';
import { MobileSheet } from '../mobile';
import { entityLinkUrl } from '../share';
import { afterOverlayBack } from '../stores/overlayHistory';
import type { ListPick } from '../routes/types';
import {
  CAT_ALL,
  activeLabels,
  defaultCategory,
  defaultSort,
  filterFor,
  pickForRoute,
  resolvePick,
  showModel,
  toggleOn,
  type ResolvedPick,
} from './list-query';
import { placeKey, readPlace, writePlace } from './list-memory';
import {
  matchesSearch,
  moreUrgent,
  phoneRowOf,
  phoneTree,
  sessionPill,
  type PhonePill,
  type PhoneRow,
} from './phone-row';
import './phone-list.css';

type Read<T> = (filter?: unknown, sort?: SortKey) => T;

export interface PhoneEntityListProps {
  config: KindConfig;
  spaceId: SpaceId;
  rowsFor: Read<readonly EntitySummary[]>;
  pageStateOf: Read<ListPageState>;
  loadMore: Read<void>;
  /** The space's counter for this kind — used only while nothing narrows the read. */
  total?: number;
  viewerActorId?: string;
  /** Route state. When `onPick` is absent the list keeps its choices locally. */
  pick?: ListPick;
  sortBy?: SortKey;
  onPick?: (next: { pick?: ListPick; sortBy?: SortKey }) => void;
  onOpen: (id: string) => void;
  /** Absent for a kind nobody can create from a list — the ＋ is then not drawn. */
  onCreate?: () => void;
  capabilitiesOf?: (id: string) => EntityCapabilities | undefined;
  onTerminate?: (id: string) => void;
  onComplete?: (id: string) => void;
  onArchive?: (id: string) => void;
}

/** Hold this long for the action sheet (mockup: ~450ms, cancels past 8px of travel). */
export const HOLD_MS = 450;
const HOLD_SLOP = 8;
/** After the lift that ends a hold, its click is swallowed for this long. */
const GHOST_CLICK_MS = 350;
/** The guard never outlives this, release heard or not. */
const GHOST_GUARD_MAX_MS = 2000;
/** Skeletons only after this, so a fast read never flashes. */
const SKELETON_DELAY_MS = 150;
const HINT_KEY = 'tm8.phoneList.holdHint.v1';

/* 16×16 strokes, the kit's grid. */
const SEARCH_ART = ['M7 12.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11Z', 'M11 11l3.5 3.5'];
const TUNE_ART = ['M2 4.5h7', 'M13 4.5h1', 'M2 11.5h2', 'M8 11.5h6', 'M11 2.5v4', 'M6 9.5v4'];
const PLUS_ART = ['M8 3v10', 'M3 8h10'];
const CHEVRON_ART = ['M6 4l4 4-4 4'];

const LIVE_STATUSES = new Set(['spawning', 'running', 'idle']);

/** The mockup's one sentence per kind for a truly empty list. */
const EMPTY_SENTENCE: Readonly<Record<string, string>> = {
  chat: 'Start a chat to ask the team for something, plan work or review a change.',
  channel: 'Channels are where the team talks. Start one to get going.',
  work_session: 'Sessions are teammates doing work. Launch one from a task.',
  doc: 'Docs hold plans, audits and decisions the team keeps coming back to.',
  task: 'No tasks yet. Create one to give the team something to pick up.',
};

function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine !== false));
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return online;
}

function useDelayed(on: boolean, ms: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!on) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), ms);
    return () => clearTimeout(timer);
  }, [on, ms]);
  return on && shown;
}

function readHintSeen(): boolean {
  try {
    return window.localStorage.getItem(HINT_KEY) === '1';
  } catch {
    return true;
  }
}

function markHintSeen(): void {
  try {
    window.localStorage.setItem(HINT_KEY, '1');
  } catch {
    /* Private mode: the hint simply shows again next time. */
  }
}

export function PhoneEntityList(props: PhoneEntityListProps): ReactNode {
  const { config, spaceId } = props;
  const kind = config.kind;
  const noun = config.label.toLowerCase();
  const nouns = config.labelPlural.toLowerCase();
  const memoryKey = placeKey(spaceId, kind);
  const remembered = useMemo(() => readPlace(memoryKey), [memoryKey]);

  /* ── the read ─────────────────────────────────────────────────────── */
  const model = useMemo(() => showModel(config), [config]);
  const [localRoute, setLocalRoute] = useState<{ pick?: ListPick; sortBy?: SortKey }>({});
  const routed = props.onPick ? { pick: props.pick, sortBy: props.sortBy } : localRoute;
  const resolved = useMemo(
    () => resolvePick(config, routed.pick, routed.sortBy, model),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config, model, JSON.stringify(routed.pick ?? null), routed.sortBy],
  );
  const filter = useMemo(
    () => filterFor(config, resolved, props.viewerActorId, model),
    [config, resolved, props.viewerActorId, model],
  );
  const sort = resolved.sort;
  const impossible = filter === null;
  const rows = impossible ? [] : props.rowsFor(filter, sort);
  const page: ListPageState = impossible ? { hasMore: false, loading: false } : props.pageStateOf(filter, sort);
  const labels = activeLabels(model, resolved, config);
  const narrowed = labels.length > 0;

  const applyRoute = useCallback(
    (next: ResolvedPick) => {
      const value = pickForRoute(config, next, model);
      if (props.onPick) props.onPick(value);
      else setLocalRoute(value);
    },
    [config, model, props.onPick], // eslint-disable-line react-hooks/exhaustive-deps
  );

  /* ── search, kept on this device and across the push ─────────────── */
  const [query, setQuery] = useState(remembered?.query ?? '');
  const searching = query.trim().length > 0;

  const now = Date.now();
  const tree = useMemo(() => {
    const roots = config.list.tree ? phoneTree(rows) : rows.map((row) => ({ row, children: [] as EntitySummary[] }));
    if (!searching) return roots;
    /* A root stays when it or any of its children match, so a hit on a worker
       still shows the run it belongs to. */
    return roots.filter((n) => matchesSearch(n.row, query) || n.children.some((c) => matchesSearch(c, query)));
  }, [rows, config.list.tree, searching, query]);

  /* ── where you were ───────────────────────────────────────────────── */
  const listRef = useRef<HTMLDivElement | null>(null);
  const scrollTop = useRef(remembered?.scrollTop ?? 0);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(remembered?.expanded ?? []));
  const [scrolled, setScrolled] = useState((remembered?.scrollTop ?? 0) > 2);
  const returning = useRef(Boolean(remembered?.openedId));

  const remember = useCallback(
    (openedId: string | null) => {
      writePlace(memoryKey, { scrollTop: scrollTop.current, openedId, query, expanded: [...expanded] });
    },
    [memoryKey, query, expanded],
  );
  /* Unmount writes too — a kind switch from the drawer is also a way out. */
  const rememberRef = useRef(remember);
  rememberRef.current = remember;
  useEffect(() => () => rememberRef.current(readPlace(memoryKey)?.openedId ?? null), [memoryKey]);

  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list || !remembered) return;
    list.scrollTop = remembered.scrollTop;
    if (remembered.openedId) {
      const item = [...list.querySelectorAll<HTMLElement>('[data-row-id]')].find(
        (el) => el.dataset.rowId === remembered.openedId,
      );
      /* A child row is its own button; a root's is `.pl-r`. */
      const row = item?.matches('li.pl-item') ? item.querySelector<HTMLElement>('.pl-r') : item?.querySelector<HTMLElement>('button');
      row?.focus({ preventScroll: true });
      /* Restored once. A later visit that is not a pop starts without the
         back-slide or a focus jump. */
      writePlace(memoryKey, { ...remembered, openedId: null });
    }
    // Once per mount: this is the pop path, not a reaction to new rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const open = useCallback(
    (id: string) => {
      remember(id);
      props.onOpen(id);
    },
    [remember, props.onOpen], // eslint-disable-line react-hooks/exhaustive-deps
  );

  /* ── paging: two screens from the end ─────────────────────────────── */
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const pageRef = useRef(page);
  pageRef.current = page;
  const loadNext = useCallback(() => {
    if (impossible) return;
    const p = pageRef.current;
    if (p.hasMore && !p.loading) props.loadMore(filter, sort);
  }, [impossible, filter, sort, props.loadMore]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const target = sentinelRef.current;
    const root = listRef.current;
    /* While searching, paging is a button: a search over a long collection
       that matches nothing would otherwise walk every page on its own. */
    if (!target || !root || searching || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadNext();
      },
      { root, rootMargin: '0px 0px 200% 0px' },
    );
    io.observe(target);
    return () => io.disconnect();
  }, [loadNext, searching, rows.length]);

  /* ── states ───────────────────────────────────────────────────────── */
  const online = useOnline();
  const firstLoad = rows.length === 0 && page.loading;
  const showSkeleton = useDelayed(firstLoad, SKELETON_DELAY_MS);

  const countText = (() => {
    if (impossible) return `0 ${nouns}`;
    if (firstLoad) return 'Loading…';
    const total = page.total ?? (!narrowed && !page.hasMore ? rows.length : !narrowed ? props.total : undefined);
    if (total !== undefined) return `${total} ${total === 1 ? noun : nouns}`;
    return `${rows.length}${page.hasMore ? '+' : ''} ${rows.length === 1 && !page.hasMore ? noun : nouns}`;
  })();

  /* ── sheets ───────────────────────────────────────────────────────── */
  const [sheet, setSheet] = useState<'filter' | { row: EntitySummary } | null>(null);
  const tuneRef = useRef<HTMLButtonElement | null>(null);
  const actionReturn = useRef<HTMLElement | null>(null);
  const closeSheet = useCallback(() => {
    const back = sheet === 'filter' ? tuneRef.current : actionReturn.current;
    setSheet(null);
    /* CONTRACT §5: dismissing a sheet returns focus to what opened it. */
    requestAnimationFrame(() => back?.focus({ preventScroll: true }));
  }, [sheet]);

  /*
   * OPEN FROM THE ACTIONS SHEET: CLOSE FIRST, PUSH WHEN THE CLOSE HAS LANDED.
   * The sheet's close takes its history marker off with `history.back()`,
   * which lands a task later. `open` is a screen-stack push whose address the
   * gate writes in an effect, so pushed alongside the close it would be the
   * entry that back removes: the sheet closes and the entity never opens.
   * This effect runs after the sheet's unmount (cleanups before effects), so
   * the back is already in flight and the push waits for it.
   */
  const openAfterClose = useRef<string | null>(null);
  useEffect(() => {
    const id = openAfterClose.current;
    if (sheet !== null || id === null) return;
    openAfterClose.current = null;
    afterOverlayBack(() => open(id));
  }, [sheet, open]);

  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 1600);
    return () => clearTimeout(timer);
  }, [toast]);

  /* ── press and hold ───────────────────────────────────────────────── */
  const [hintSeen, setHintSeen] = useState(readHintSeen);
  const hold = useRef<{ timer: ReturnType<typeof setTimeout> | null; x: number; y: number; fired: boolean }>({
    timer: null,
    x: 0,
    y: 0,
    fired: false,
  });
  const [pressed, setPressed] = useState<string | null>(null);
  const rowById = useMemo(() => new Map(rows.map((r) => [r.id, r])), [rows]);

  const openActions = useCallback(
    (id: string, from: HTMLElement | null) => {
      const row = rowById.get(id);
      if (!row) return;
      actionReturn.current = from;
      setSheet({ row });
      if (!hintSeen) {
        markHintSeen();
        setHintSeen(true);
      }
    },
    [rowById, hintSeen],
  );

  /*
   * THE RELEASE AFTER A HOLD IS NOT A TAP. The sheet opens under the finger,
   * so the click that follows the lift lands on whatever the sheet put there
   * (its Open row, or the backdrop) and the sheet closes the moment it opened.
   * Swallow that one click: from the hold until shortly after the release.
   */
  const ghostGuard = useRef<(() => void) | null>(null);
  const armGhostGuard = useCallback(() => {
    ghostGuard.current?.();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const disarm = () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener('click', swallow, true);
      window.removeEventListener('pointerup', onRelease, true);
      window.removeEventListener('pointercancel', onRelease, true);
      window.removeEventListener('pointerdown', disarm, true);
      if (ghostGuard.current === disarm) ghostGuard.current = null;
    };
    const swallow = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      disarm();
    };
    const onRelease = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(disarm, GHOST_CLICK_MS);
    };
    window.addEventListener('click', swallow, true);
    window.addEventListener('pointerup', onRelease, true);
    window.addEventListener('pointercancel', onRelease, true);
    /* A fresh press is a real tap, whatever came before. */
    window.addEventListener('pointerdown', disarm, true);
    /* A release the window never hears still ends the guard. */
    timer = setTimeout(disarm, GHOST_GUARD_MAX_MS);
    ghostGuard.current = disarm;
  }, []);
  useEffect(() => () => ghostGuard.current?.(), []);

  const cancelHold = useCallback(() => {
    if (hold.current.timer) clearTimeout(hold.current.timer);
    hold.current.timer = null;
    setPressed(null);
  }, []);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-hold-id]');
    if (!el || e.button > 0) return;
    const id = el.dataset.holdId!;
    hold.current.fired = false;
    hold.current.x = e.clientX;
    hold.current.y = e.clientY;
    setPressed(id);
    if (hold.current.timer) clearTimeout(hold.current.timer);
    hold.current.timer = setTimeout(() => {
      hold.current.fired = true;
      hold.current.timer = null;
      setPressed(null);
      navigator.vibrate?.(10);
      armGhostGuard();
      openActions(id, el);
    }, HOLD_MS);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!hold.current.timer) return;
    if (Math.abs(e.clientX - hold.current.x) + Math.abs(e.clientY - hold.current.y) > HOLD_SLOP) cancelHold();
  };

  const onRowKey = (e: ReactKeyboardEvent<HTMLElement>, id: string) => {
    /* The keyboard's way to the same sheet: the context-menu key or Shift+F10. */
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      e.preventDefault();
      openActions(id, e.currentTarget);
    }
  };

  const onRowClick = (id: string) => {
    /* The release after a hold is not a tap. */
    if (hold.current.fired) {
      hold.current.fired = false;
      return;
    }
    open(id);
  };

  /* ── render ───────────────────────────────────────────────────────── */
  const pillFor = (row: EntitySummary, children: readonly EntitySummary[]): PhonePill | undefined => {
    const own = phoneRowOf(row, now).pill;
    if (!own || kind !== 'work_session') return own;
    return children.reduce<PhonePill>((acc, c) => {
      const p = sessionPill(c);
      return p ? moreUrgent(acc, p) : acc;
    }, own);
  };

  let body: ReactNode;
  if (impossible) {
    body = (
      <Empty
        config={config}
        title="Nothing can match"
        sentence="These filters exclude each other, so nothing was asked for."
        action={<button type="button" className="pl-ghost" onClick={() => applyRoute(resetPick(config))}>Clear filters</button>}
      />
    );
  } else if (rows.length === 0 && page.loading) {
    body = showSkeleton ? <Skeleton count={9} /> : null;
  } else if (rows.length === 0 && narrowed) {
    body = (
      <Empty
        config={config}
        title={`No ${nouns} match`}
        sentence={`Nothing here for ${labels.join(' · ')}.`}
        action={<button type="button" className="pl-ghost" onClick={() => applyRoute(resetPick(config))}>Clear filters</button>}
      />
    );
  } else if (rows.length === 0) {
    body = (
      <Empty
        config={config}
        title={`No ${nouns} yet`}
        sentence={EMPTY_SENTENCE[kind] ?? `Nothing in ${config.labelPlural} yet.`}
        action={
          props.onCreate ? (
            <button type="button" className="pl-new" onClick={props.onCreate}>
              <VectorIcon paths={PLUS_ART} size={16} strokeWidth={1.8} />
              New {noun}
            </button>
          ) : null
        }
      />
    );
  } else if (tree.length === 0) {
    body = (
      <Empty
        config={config}
        title={`No results for “${query.trim()}”`}
        sentence={page.hasMore ? `Searched the ${rows.length} ${nouns} loaded so far.` : `Searched all ${rows.length} ${nouns}.`}
        action={
          <>
            <button type="button" className="pl-ghost" onClick={() => setQuery('')}>Clear search</button>
            {page.hasMore ? (
              <button type="button" className="pl-ghost" disabled={page.loading} onClick={loadNext}>
                {page.loading ? 'Loading…' : 'Search more'}
              </button>
            ) : null}
          </>
        }
      />
    );
  } else {
    body = (
      <ul className="pl-rows" role="list">
        {tree.map(({ row, children }) => {
          const view = phoneRowOf(row, now);
          const pill = pillFor(row, children);
          const isOpen = expanded.has(row.id);
          const kidsId = `pl-kids-${row.id}`;
          return (
            <li key={row.id} className="pl-item" data-row-id={row.id}>
              <RowButton
                view={{ ...view, ...(pill ? { pill } : {}) }}
                pressed={pressed === row.id}
                stale={!online}
                onClick={() => onRowClick(row.id)}
                onKeyDown={(e) => onRowKey(e, row.id)}
              />
              {children.length > 0 ? (
                <>
                  <button
                    type="button"
                    className="pl-kids"
                    aria-expanded={isOpen}
                    aria-controls={kidsId}
                    onClick={() =>
                      setExpanded((prev) => {
                        const next = new Set(prev);
                        if (next.has(row.id)) next.delete(row.id);
                        else next.add(row.id);
                        return next;
                      })
                    }
                  >
                    <span className="pl-kids__cv" aria-hidden>
                      <VectorIcon paths={CHEVRON_ART} size={12} strokeWidth={1.8} />
                    </span>
                    +{children.length} {kind === 'work_session' ? (children.length === 1 ? 'worker' : 'workers') : children.length === 1 ? noun : nouns}
                  </button>
                  {isOpen ? (
                    <ul className="pl-kidrows" id={kidsId} role="list">
                      {children.map((child) => {
                        const cv = phoneRowOf(child, now);
                        return (
                          <li key={child.id} data-row-id={child.id}>
                            <button
                              type="button"
                              className="pl-kr"
                              data-hold-id={child.id}
                              onClick={() => onRowClick(child.id)}
                              onKeyDown={(e) => onRowKey(e, child.id)}
                              onContextMenu={(e) => e.preventDefault()}
                            >
                              <span className={`pl-sd pl-tone--${cv.pill?.tone ?? 'idle'}`} aria-hidden />
                              <span className="pl-kr__t">{cv.title}</span>
                              <span className="pl-tm">
                                {cv.pill ? `${cv.pill.label} · ` : ''}
                                {cv.time}
                              </span>
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  ) : null}
                </>
              ) : null}
            </li>
          );
        })}
      </ul>
    );
  }

  const showTail = !impossible && rows.length > 0 && tree.length > 0;

  return (
    <section className={`pl${returning.current ? ' pl--back' : ''}`} aria-label={`${config.labelPlural} list`} data-testid="phone-list" data-kind={kind}>
      <header className={`pl-hd${scrolled ? ' pl-hd--sc' : ''}`}>
        <div className="pl-bar">
          <span className="pl-count" data-testid="phone-list-count" aria-live="polite">
            {countText}
          </span>
          <button
            ref={tuneRef}
            type="button"
            className="pl-ib"
            data-testid="phone-list-tune"
            aria-haspopup="dialog"
            aria-label={narrowed ? `Sort and filter, ${labels.length} active` : 'Sort and filter'}
            onClick={() => setSheet('filter')}
          >
            <VectorIcon paths={TUNE_ART} size={18} strokeWidth={1.6} />
            {narrowed ? <span className="pl-ib__bd" aria-hidden>{labels.length}</span> : null}
          </button>
          {props.onCreate ? (
            <button
              type="button"
              className="pl-ib pl-ib--acc"
              data-testid="phone-list-new"
              aria-label={`New ${noun}`}
              onClick={props.onCreate}
            >
              <VectorIcon paths={PLUS_ART} size={20} strokeWidth={2} />
            </button>
          ) : null}
        </div>
        <label className="pl-srch">
          <VectorIcon paths={SEARCH_ART} size={16} strokeWidth={1.6} />
          <input
            type="search"
            value={query}
            placeholder={`Search ${nouns}`}
            enterKeyHint="search"
            aria-label={`Search ${nouns}`}
            data-testid="phone-list-search"
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        {narrowed ? (
          <div className="pl-fsum" data-testid="phone-list-filtered">
            <span className="pl-fsum__t">Filtered: {labels.join(' · ')}</span>
            <button type="button" onClick={() => applyRoute(resetPick(config))}>
              Clear
            </button>
          </div>
        ) : null}
      </header>

      <div
        ref={listRef}
        className="pl-list"
        data-testid="phone-list-scroller"
        onScroll={(e) => {
          scrollTop.current = e.currentTarget.scrollTop;
          const sc = e.currentTarget.scrollTop > 2;
          if (sc !== scrolled) setScrolled(sc);
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={cancelHold}
        onPointerCancel={cancelHold}
        onPointerLeave={cancelHold}
        onContextMenu={(e) => {
          if ((e.target as HTMLElement).closest('[data-hold-id]')) e.preventDefault();
        }}
      >
        {!online ? (
          <div className="pl-banner" role="status">
            <span className="pl-banner__t">
              <b>You’re offline</b>
              <i>Showing the {nouns} already loaded.</i>
            </span>
          </div>
        ) : null}
        {!hintSeen && rows.length > 0 && !returning.current ? (
          <div className="pl-hint" role="note">
            <span>Press and hold a row for its actions.</span>
            <button
              type="button"
              aria-label="Dismiss tip"
              onClick={() => {
                markHintSeen();
                setHintSeen(true);
              }}
            >
              ✕
            </button>
          </div>
        ) : null}
        {body}
        {showTail ? (
          <>
            <div ref={sentinelRef} className="pl-sentinel" aria-hidden />
            {page.hasMore ? (
              page.loading ? (
                <>
                  <Skeleton count={1} />
                  <div className="pl-more" role="status">
                    <span className="pl-spin" aria-hidden />
                    Loading more…
                  </div>
                </>
              ) : searching ? (
                <div className="pl-more">
                  <button type="button" className="pl-ghost" onClick={loadNext}>
                    Search more {nouns}
                  </button>
                </div>
              ) : (
                <div className="pl-more">
                  <button type="button" className="pl-ghost" onClick={loadNext}>
                    Load more
                  </button>
                </div>
              )
            ) : (
              <div className="pl-endl">
                {searching ? `${tree.length} of ${rows.length}` : `That’s all ${rows.length}`}
              </div>
            )}
          </>
        ) : null}
        {toast ? (
          <div className="pl-toast" role="status">
            {toast}
          </div>
        ) : null}
      </div>

      {sheet === 'filter' ? (
        <FilterSheet
          config={config}
          model={model}
          resolved={resolved}
          viewerKnown={Boolean(props.viewerActorId)}
          onApply={(next) => {
            applyRoute(next);
            closeSheet();
          }}
          onDismiss={closeSheet}
        />
      ) : null}
      {sheet && sheet !== 'filter' ? (
        <ActionSheet
          row={sheet.row}
          spaceId={spaceId}
          capabilities={props.capabilitiesOf?.(sheet.row.id) ?? sheet.row.capabilities}
          onOpen={() => {
            openAfterClose.current = sheet.row.id;
            setSheet(null);
          }}
          onCopied={(ok) => setToast(ok ? 'Link copied' : 'Could not copy the link')}
          {...(props.onTerminate ? { onTerminate: props.onTerminate } : {})}
          {...(props.onComplete ? { onComplete: props.onComplete } : {})}
          {...(props.onArchive ? { onArchive: props.onArchive } : {})}
          onDismiss={closeSheet}
        />
      ) : null}
    </section>
  );
}

function resetPick(config: KindConfig): ResolvedPick {
  return { cat: defaultCategory(config), on: [], sort: defaultSort(config) };
}

/* ── the row ──────────────────────────────────────────────────────────── */

function RowButton(props: {
  view: PhoneRow;
  pressed: boolean;
  stale: boolean;
  onClick: () => void;
  onKeyDown: (e: ReactKeyboardEvent<HTMLElement>) => void;
}): ReactNode {
  const { view } = props;
  const cls = [
    'pl-r',
    view.unread ? 'pl-r--unread' : '',
    view.excerpt !== undefined ? 'pl-r--doc' : '',
    props.pressed ? 'pl-r--prs' : '',
    props.stale ? 'pl-r--stale' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      type="button"
      className={cls}
      data-hold-id={view.id}
      data-testid="phone-list-row"
      onClick={props.onClick}
      onKeyDown={props.onKeyDown}
    >
      <span className={`pl-g pl-g--${view.tint}${view.pill && view.kind === 'work_session' ? ` pl-tone--${view.pill.tone}` : ''}`} aria-hidden>
        <KindIcon kind={view.kind} size={18} />
      </span>
      <span className="pl-b">
        <span className="pl-l1">
          <span className="pl-t">{view.title || 'Untitled'}</span>
          {view.time ? (
            <time className="pl-tm" dateTime={view.at}>
              {view.time}
            </time>
          ) : null}
        </span>
        {view.excerpt !== undefined ? <span className="pl-ex">{view.excerpt}</span> : null}
        <span className="pl-l2">
          <span className="pl-meta">
            {view.who ? (
              <span className="pl-av" aria-hidden>
                {view.who.initial}
              </span>
            ) : null}
            {view.meta}
          </span>
          {view.pill ? <span className={`pl-st pl-tone--${view.pill.tone}`}>{view.pill.label}</span> : null}
          {view.rank ? <span className={`pl-pr${view.rank.hot ? ' pl-pr--hot' : ''}`}>{view.rank.label}</span> : null}
          {view.unread ? <span className="pl-dot" aria-label="unread" /> : null}
        </span>
      </span>
    </button>
  );
}

/* ── states ───────────────────────────────────────────────────────────── */

function Skeleton({ count }: { count: number }): ReactNode {
  return (
    <div className="pl-skel" aria-hidden data-testid="phone-list-skeleton">
      {Array.from({ length: count }, (_, j) => (
        <div key={j} className="pl-sk">
          <span className="pl-g pl-sk__g" />
          <span className="pl-b">
            <span className="pl-sk__ln" style={{ width: `${55 + ((j * 17) % 35)}%` }} />
            <span className="pl-sk__ln" style={{ width: `${35 + ((j * 23) % 40)}%` }} />
          </span>
        </div>
      ))}
    </div>
  );
}

function Empty(props: { config: KindConfig; title: string; sentence: string; action: ReactNode }): ReactNode {
  return (
    <div className="pl-empty" data-testid="phone-list-empty">
      <span className={`pl-empty__g pl-g--${tintOfKind(props.config.kind)}`} aria-hidden>
        <KindIcon kind={props.config.kind} size={28} />
      </span>
      <h2>{props.title}</h2>
      <p>{props.sentence}</p>
      {props.action ? <div className="pl-empty__acts">{props.action}</div> : null}
    </div>
  );
}

function tintOfKind(kind: string): PhoneRow['tint'] {
  if (kind === 'chat' || kind === 'channel') return 'chat';
  if (kind === 'work_session') return 'session';
  if (kind === 'doc') return 'doc';
  if (kind === 'task') return 'task';
  return 'other';
}

/* ── ⚙ sort & filter ──────────────────────────────────────────────────── */

function FilterSheet(props: {
  config: KindConfig;
  model: ReturnType<typeof showModel>;
  resolved: ResolvedPick;
  viewerKnown: boolean;
  onApply: (next: ResolvedPick) => void;
  onDismiss: () => void;
}): ReactNode {
  const { config, model } = props;
  const [draft, setDraft] = useState<ResolvedPick>(props.resolved);
  const multiOf = (specId: string) => Boolean(config.list.filters.find((f) => f.id === specId)?.multi);
  return (
    <MobileSheet title="Sort & filter" onDismiss={props.onDismiss} testId="phone-list-filter-sheet">
      <div className="pl-sheet">
        <p className="pl-sheet__s">{config.labelPlural} · kept in the address, so a shared link keeps it</p>
        {config.list.sort.length > 1 ? (
          <fieldset className="pl-grp">
            <legend>Sort</legend>
            {config.list.sort.map((s) => (
              <label key={s.key} className="pl-opt">
                <span className="pl-opt__t">{s.label}</span>
                <input
                  type="radio"
                  name="pl-sort"
                  className="pl-rad"
                  checked={draft.sort === s.key}
                  onChange={() => setDraft((d) => ({ ...d, sort: s.key }))}
                />
              </label>
            ))}
          </fieldset>
        ) : null}
        {model.categories.length > 0 ? (
          <fieldset className="pl-grp">
            <legend>Status</legend>
            {model.categories.map((c) => (
              <label key={c.id} className="pl-opt">
                <span className="pl-opt__t">{c.label}</span>
                <input
                  type="radio"
                  name="pl-cat"
                  className="pl-rad"
                  checked={(draft.cat ?? CAT_ALL) === c.id}
                  onChange={() => setDraft((d) => ({ ...d, cat: c.id }))}
                />
              </label>
            ))}
          </fieldset>
        ) : null}
        {model.toggles.length > 0 ? (
          <fieldset className="pl-grp">
            <legend>Show</legend>
            {model.toggles.map((t) => {
              const refused = t.needsViewer && !props.viewerKnown;
              return (
                <label key={t.key} className={`pl-opt${refused ? ' pl-opt--off' : ''}`}>
                  <span className="pl-opt__t">
                    {t.label}
                    {refused ? <i>Sign in to use this — it needs to know who you are.</i> : null}
                  </span>
                  <input
                    type="checkbox"
                    className="pl-box"
                    disabled={refused}
                    checked={draft.on.includes(t.key)}
                    onChange={() => setDraft((d) => ({ ...d, on: toggleOn(model, d.on, t.key, multiOf(t.specId)) }))}
                  />
                </label>
              );
            })}
          </fieldset>
        ) : null}
        <div className="pl-sfoot">
          <button type="button" className="pl-ghost" onClick={() => setDraft(resetPick(config))}>
            Reset
          </button>
          <button type="button" className="pl-new" data-testid="phone-list-apply" onClick={() => props.onApply(draft)}>
            Show {config.labelPlural.toLowerCase()}
          </button>
        </div>
      </div>
    </MobileSheet>
  );
}

/* ── press-and-hold actions ───────────────────────────────────────────── */

function ActionSheet(props: {
  row: EntitySummary;
  spaceId: SpaceId;
  capabilities: EntityCapabilities | undefined;
  onOpen: () => void;
  onCopied: (ok: boolean) => void;
  onTerminate?: (id: string) => void;
  onComplete?: (id: string) => void;
  onArchive?: (id: string) => void;
  onDismiss: () => void;
}): ReactNode {
  const { row, capabilities } = props;
  const label = row.title || 'Untitled';
  const state = row.state;
  const live = state.kind === 'work_session' && LIVE_STATUSES.has(state.status);
  const taskOpen = state.kind === 'task' && state.status !== 'done' && state.status !== 'cancelled';
  const act = (fn: () => void) => () => {
    fn();
    props.onDismiss();
  };
  return (
    <MobileSheet title={label} onDismiss={props.onDismiss} testId="phone-list-actions">
      <div className="pl-acts" role="group" aria-label={`Actions for ${label}`}>
        <button type="button" className="pl-act" onClick={props.onOpen}>
          <span className="pl-act__ic" aria-hidden>↗</span>Open
        </button>
        <button
          type="button"
          className="pl-act"
          onClick={act(() => {
            const url = entityLinkUrl({ spaceId: props.spaceId, entityId: row.id });
            if (!url || !navigator.clipboard?.writeText) {
              props.onCopied(false);
              return;
            }
            navigator.clipboard.writeText(url).then(
              () => props.onCopied(true),
              () => props.onCopied(false),
            );
          })}
        >
          <span className="pl-act__ic" aria-hidden>🔗</span>Copy link
        </button>
        {live && props.onTerminate ? (
          <button type="button" className="pl-act" onClick={act(() => props.onTerminate?.(row.id))}>
            <span className="pl-act__ic" aria-hidden>■</span>Stop session
          </button>
        ) : null}
        {taskOpen && props.onComplete && capabilities?.canComplete ? (
          <button type="button" className="pl-act" onClick={act(() => props.onComplete?.(row.id))}>
            <span className="pl-act__ic" aria-hidden>✓</span>Mark done
          </button>
        ) : null}
        {props.onArchive && capabilities?.canDelete && !row.deletedAt ? (
          <button type="button" className="pl-act" onClick={act(() => props.onArchive?.(row.id))}>
            <span className="pl-act__ic" aria-hidden>⌫</span>Archive
          </button>
        ) : null}
        <button type="button" className="pl-act pl-act--dim" onClick={props.onDismiss}>
          <span className="pl-act__ic" aria-hidden>✕</span>Cancel
        </button>
      </div>
    </MobileSheet>
  );
}
