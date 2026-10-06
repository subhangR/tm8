/**
 * Tab strip (Spec A §6, §16; design log §5). Workstream C.
 *
 * `[leading] [scroller: tablist of VISIBLE tabs] [⌄ overflow] [+] [scope]`.
 * Every write goes through the dispatcher; the strip only reads the store and
 * the live data (entity titles, session liveness) for labels and indicators.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useStore } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import { KindIcon } from '../../domain';
import { NOTICE_TTL_MS } from '../../shell';
import { build, defaultRoute } from '../../routes';
import type { SpaceId } from '@tm8/contract';
import { useTabLiveStatus } from '../adapters/entity';
import { draftTitle, getKindAdapter } from '../adapters/registry';
import { activeTabId, visibleTabs } from '../runtime/selectors';
import type { Source, TabId, TabRecord } from '../runtime/types';
import { ConfirmDiscard } from './ConfirmDiscard';
import { useWorkspace, useWorkspaceState } from './context';
import { ScopePicker } from './ScopePicker';
import './tabstrip.css';

/** Soft cap (Spec A §6): the toast fires as the open-tab count crosses it. */
export const SOFT_CAP = 21;

/**
 * The tab's display title. Entity tabs pass the live title when the data
 * layer has one; until then they read as their kind's noun.
 */
export function tabTitle(tab: TabRecord, entityTitle?: string | null): string {
  if (tab.type === 'chooser') return 'New tab';
  if (tab.type === 'draft') return draftTitle(tab.kind, tab.ordinal);
  return entityTitle?.trim() || getKindAdapter(tab.kind).noun;
}

export type TabState = 'unsaved' | 'running' | 'error' | 'deleted' | 'unavailable' | null;

const STATE_LABEL: Record<Exclude<TabState, null>, string> = {
  unsaved: 'Unsaved changes',
  running: 'Running',
  error: 'Error',
  deleted: 'Deleted',
  unavailable: 'Unavailable',
};

/**
 * Last title seen per entity, for the page's lifetime: a tab whose entity
 * drops out of the store (evicted, or deleted before this client connected)
 * keeps the name it was showing instead of falling back to the kind noun.
 */
const lastKnownTitles = new Map<string, string>();
/** Entities the node answered not_found / forbidden for, probed by the strip. */
const probed = new Map<string, 'deleted' | 'unavailable'>();
const PROBE_AFTER_MS = 1_500;

/** The live facts a tab's label needs: title, kind noun and state indicator. */
export function useTabFacts(tab: TabRecord): { title: string; noun: string | null; state: TabState } {
  const { gate } = useWorkspace();
  const data = gate.data as typeof gate.data & { pull?: (id: string) => void };
  const entityId = tab.type === 'entity' ? tab.entityId : null;
  const { title, deleted, known } = useStore(
    data.domain.store,
    useShallow((s) => {
      if (!entityId) return { title: null, deleted: false, known: false };
      const row = s.entities[entityId] ?? s.details[entityId];
      return { title: row?.title ?? null, deleted: Boolean(row?.deletedAt), known: row !== undefined };
    }),
  );
  if (entityId && title) lastKnownTitles.set(entityId, title);
  const live = useTabLiveStatus(tab);
  const [probe, setProbe] = useState(() => (entityId ? probed.get(entityId) : undefined));

  // A tab may name an entity no list page has loaded (restored, or deleted
  // before this client connected): ask the data layer, then ask the node why.
  const dataRef = useRef(data);
  dataRef.current = data;
  useEffect(() => {
    if (!entityId || known) return;
    const d = dataRef.current;
    d.pull?.(entityId);
    let alive = true;
    const timer = setTimeout(() => {
      if (!alive || probed.has(entityId)) return void setProbe(probed.get(entityId));
      d.seam.entity(entityId as never).then(
        () => {
          if (alive) dataRef.current.refetchDetail(entityId);
        },
        (error: unknown) => {
          const code = (error as { code?: unknown } | null)?.code;
          const verdict = code === 'not_found' ? 'deleted' : code === 'forbidden' ? 'unavailable' : undefined;
          if (!verdict) return;
          probed.set(entityId, verdict);
          if (alive) setProbe(verdict);
        },
      );
    }, PROBE_AFTER_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [entityId, known]);

  const noun = tab.type === 'chooser' ? null : getKindAdapter(tab.kind).noun;
  let state: TabState = null;
  let shownTitle = tabTitle(tab, title);
  if (tab.type === 'draft') {
    state = tab.dirty ? 'unsaved' : null;
  } else if (entityId) {
    const gone = deleted ? 'deleted' : known ? undefined : probe;
    if (gone) {
      state = gone;
      const remembered = title ?? lastKnownTitles.get(entityId);
      shownTitle = remembered ?? `${gone === 'deleted' ? 'Deleted' : 'Unavailable'} ${noun!.toLowerCase()}`;
    } else {
      state = live;
      if (!title) shownTitle = lastKnownTitles.get(entityId) ?? shownTitle;
    }
  }
  return { title: shownTitle, noun, state };
}

export function accessibleTabName(title: string, noun: string | null): string {
  return noun ? `${title} — ${noun}` : title;
}

// ---------------------------------------------------------------------------
// Glyphs (currentColor; sizes per design log §5)
// ---------------------------------------------------------------------------

function Svg({ size, children }: { size: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const SearchGlyph = ({ size = 14 }: { size?: number }) => (
  <Svg size={size}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.5 10.5 14 14" />
  </Svg>
);
const PlusGlyph = () => (
  <Svg size={16}>
    <path d="M8 3v10M3 8h10" />
  </Svg>
);
const ChevronGlyph = () => (
  <Svg size={16}>
    <path d="m4 6 4 4 4-4" />
  </Svg>
);
const CloseGlyph = () => (
  <Svg size={12}>
    <path d="m3.5 3.5 9 9M12.5 3.5l-9 9" />
  </Svg>
);
const AlertGlyph = () => (
  <Svg size={12}>
    <path d="M8 1.75 15 14H1z" />
    <path d="M8 6.5v3M8 11.75v.01" />
  </Svg>
);
const SidebarShowGlyph = () => (
  <Svg size={16}>
    <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
    <path d="M6 2.5v11" />
  </Svg>
);
const CheckGlyph = () => (
  <Svg size={14}>
    <path d="m3 8.5 3 3 7-7" />
  </Svg>
);

/** The state glyph (dirty, running, error), each a named image (Spec A §6). */
export function TabStateGlyph({ state, id }: { state: TabState; id?: string }) {
  if (!state) return null;
  return (
    <span id={id} className="tws-ts-state" data-state={state} role="img" aria-label={STATE_LABEL[state]}>
      {state === 'error' || state === 'deleted' || state === 'unavailable' ? <AlertGlyph /> : null}
    </span>
  );
}

export function TabLeadIcon({ tab }: { tab: TabRecord }) {
  return (
    <span className="tws-ts-icon" aria-hidden="true">
      {tab.type === 'chooser' ? <SearchGlyph /> : <KindIcon kind={tab.kind} size={14} />}
    </span>
  );
}

/** `click` for a pointer, `keyboard` for a synthesized (Enter/Space) click. */
function sourceOf(event: { detail: number }): Source {
  return event.detail === 0 ? 'keyboard' : 'click';
}

function isMod(event: globalThis.KeyboardEvent): boolean {
  const mac = typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform);
  return mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

// ---------------------------------------------------------------------------
// Menus (context menu and overflow): focus moves in, arrows move, Esc returns
// ---------------------------------------------------------------------------

interface MenuItem {
  key: string;
  label: ReactNode;
  disabled?: boolean;
  checked?: boolean;
  run(source: Source): void;
}

function StripMenu({
  items,
  label,
  at,
  onClose,
}: {
  items: MenuItem[];
  label: string;
  at: { x: number; y: number };
  onClose(restoreFocus: boolean): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(at);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Keep the menu on screen.
    const r = el.getBoundingClientRect();
    const x = Math.max(8, Math.min(at.x, window.innerWidth - r.width - 8));
    const y = Math.max(8, Math.min(at.y, window.innerHeight - r.height - 8));
    setPos({ x, y });
    el.querySelector<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])')?.focus();
  }, [at]);
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose(false);
    };
    const onBlur = () => onClose(false);
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [onClose]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const rows = [...(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const step = (delta: number) => {
      event.preventDefault();
      if (rows.length === 0) return;
      rows[(at + delta + rows.length) % rows.length]?.focus();
    };
    if (event.key === 'ArrowDown') step(1);
    else if (event.key === 'ArrowUp') step(-1);
    else if (event.key === 'Home') step(-at);
    else if (event.key === 'End') step(rows.length - 1 - at);
    else if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      onClose(true);
    }
  };

  return (
    <div
      ref={ref}
      className="tws-ts-menu"
      role="menu"
      aria-label={label}
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={onKeyDown}
    >
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          tabIndex={-1}
          role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
          aria-checked={item.checked}
          aria-disabled={item.disabled || undefined}
          className="tws-ts-menu-row"
          onClick={(event) => {
            if (item.disabled) return;
            const source = sourceOf(event);
            onClose(false);
            item.run(source);
          }}
        >
          {item.checked !== undefined ? (
            <span className="tws-ts-menu-check" aria-hidden="true">
              {item.checked ? <CheckGlyph /> : null}
            </span>
          ) : null}
          {item.label}
        </button>
      ))}
    </div>
  );
}

function OverflowRow({ tab }: { tab: TabRecord }) {
  const { title, noun, state } = useTabFacts(tab);
  return (
    <span className="tws-ts-menu-tab" aria-label={accessibleTabName(title, noun)}>
      <TabLeadIcon tab={tab} />
      <span className="tws-ts-title">{title}</span>
      <TabStateGlyph state={state} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// One tab
// ---------------------------------------------------------------------------

interface TabProps {
  tab: TabRecord;
  active: boolean;
  focusable: boolean;
  dragging: boolean;
  onActivate(tabId: TabId, source: Source): void;
  onClose(tabId: TabId, source: Source): void;
  onKeyDown(event: KeyboardEvent<HTMLDivElement>, tabId: TabId): void;
  onFocus(tabId: TabId): void;
  onContextMenu(tabId: TabId, at: { x: number; y: number }, title: string): void;
  onDragStart(event: DragEvent<HTMLDivElement>, tabId: TabId): void;
  onDragOver(event: DragEvent<HTMLDivElement>, tabId: TabId): void;
  onDragEnd(): void;
}

function Tab(props: TabProps) {
  const { tab, active } = props;
  const { title, noun, state } = useTabFacts(tab);
  const stateId = `tws-ts-state-${tab.id}`;
  return (
    <div
      className="tws-ts-tab"
      data-tab-id={tab.id}
      data-active={active || undefined}
      data-dragging={props.dragging || undefined}
      data-state={state ?? undefined}
      title={accessibleTabName(title, noun)}
      draggable
      onDragStart={(event) => props.onDragStart(event, tab.id)}
      onDragOver={(event) => props.onDragOver(event, tab.id)}
      onDragEnd={props.onDragEnd}
      onMouseDown={(event) => {
        // Middle-click closes; stop the browser's autoscroll from starting.
        if (event.button === 1) event.preventDefault();
      }}
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        props.onClose(tab.id, 'click');
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        props.onContextMenu(tab.id, { x: event.clientX, y: event.clientY }, title);
      }}
    >
      <div
        role="tab"
        id={`tws-ts-tab-${tab.id}`}
        className="tws-ts-tab-main"
        aria-selected={active}
        aria-label={accessibleTabName(title, noun)}
        aria-describedby={state ? stateId : undefined}
        tabIndex={props.focusable ? 0 : -1}
        onClick={(event) => props.onActivate(tab.id, event.detail === 0 ? 'keyboard' : 'click')}
        onKeyDown={(event) => props.onKeyDown(event, tab.id)}
        onFocus={() => props.onFocus(tab.id)}
      >
        <TabLeadIcon tab={tab} />
        <span className="tws-ts-title">{title}</span>
      </div>
      <span className="tws-ts-slot">
        <TabStateGlyph state={state} id={stateId} />
        <button
          type="button"
          className="tws-ts-close"
          // The focused tab's × follows it in the Tab order; the rest stay out (roving).
          tabIndex={props.focusable ? 0 : -1}
          aria-label={`Close ${title}`}
          onClick={(event) => {
            event.stopPropagation();
            props.onClose(tab.id, sourceOf(event));
          }}
        >
          <CloseGlyph />
        </button>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The strip
// ---------------------------------------------------------------------------

export interface TabStripProps {
  /**
   * Far-left slot (design log §5 "Restore navigation"), pinned outside the
   * scroller. Omitted ⇒ the strip draws its own Restore button while expanded.
   */
  leading?: ReactNode;
}

type Drop = { beforeTabId: TabId | undefined; x: number };

export function TabStrip({ leading }: TabStripProps = {}) {
  const { runtime, dispatch, spaceId, gate } = useWorkspace();
  const tabs = useWorkspaceState(useShallow(visibleTabs));
  const active = useWorkspaceState(activeTabId);
  const expanded = useWorkspaceState((s) => s.layout.expanded);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const [focusId, setFocusId] = useState<TabId | null>(null);
  const [menu, setMenu] = useState<
    | { type: 'tab'; tabId: TabId; at: { x: number; y: number }; trigger: HTMLElement | null }
    | { type: 'overflow'; at: { x: number; y: number }; trigger: HTMLElement | null }
    | null
  >(null);
  const [dragId, setDragId] = useState<TabId | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const [overflow, setOverflow] = useState<{ over: boolean; start: boolean; end: boolean }>({
    over: false,
    start: false,
    end: false,
  });
  /** Set by a close the strip asked for: focus follows to the newly active tab. */
  const refocusAfterClose = useRef(false);

  const tabIds = useMemo(() => tabs.map((t) => t.id), [tabs]);
  const rovingId = focusId && tabIds.includes(focusId) ? focusId : active && tabIds.includes(active) ? active : tabIds[0];

  const tabEl = useCallback(
    (tabId: TabId) => document.getElementById(`tws-ts-tab-${tabId}`) as HTMLElement | null,
    [],
  );

  // ---- soft cap toast (a runtime effect, so every opener is covered) -------
  useEffect(
    () =>
      runtime.registerEffect(({ env, prev, next }) => {
        // A restored session is not "opening" tabs.
        if (env.source === 'restore') return;
        const before = prev.orderedTabIds.length;
        const after = next.orderedTabIds.length;
        if (before < SOFT_CAP && after >= SOFT_CAP) {
          runtime.hooks.toast({
            text: `You have ${after} open tabs — inactive tabs are paused to save memory.`,
          });
        }
      }),
    [runtime],
  );

  // ---- commands -------------------------------------------------------------
  const activateTab = useCallback(
    (tabId: TabId, source: Source) => {
      setFocusId(tabId);
      dispatch({ command: 'workspace.tabs.activate', args: { tabId }, source });
    },
    [dispatch],
  );
  const closeTab = useCallback(
    (tabId: TabId, source: Source) => {
      refocusAfterClose.current = true;
      dispatch({ command: 'workspace.tabs.close', args: { tabId }, source });
    },
    [dispatch],
  );
  const closeVisible = useCallback(
    (source: Source, except?: TabId) => {
      refocusAfterClose.current = true;
      dispatch({ command: 'workspace.tabs.closeVisible', args: except ? { except } : {}, source });
    },
    [dispatch],
  );

  // After a close (immediate, or once the discard dialog resolves), focus the
  // newly active tab — unless focus has already gone somewhere meaningful.
  const pending = useWorkspaceState((s) => s.pending);
  useLayoutEffect(() => {
    if (!refocusAfterClose.current || pending) return;
    refocusAfterClose.current = false;
    const strip = scrollerRef.current?.parentElement;
    const focused = document.activeElement;
    const lost = !focused || focused === document.body || (strip?.contains(focused) ?? false);
    if (!lost) return;
    const target = active && tabIds.includes(active) ? active : tabIds[0];
    if (target) {
      setFocusId(target);
      tabEl(target)?.focus();
    }
  }, [tabIds, active, pending, tabEl]);

  // ---- global shortcuts: Mod+Alt+←/→, Mod+Alt+W (never Mod+W) ---------------
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!event.altKey || event.shiftKey || !isMod(event) || event.defaultPrevented) return;
      const { store } = runtime;
      const state = store.getState();
      if (state.pending) return;
      const ids = visibleTabs(state).map((t) => t.id);
      const current = activeTabId(state);
      if (event.code === 'ArrowLeft' || event.code === 'ArrowRight') {
        if (ids.length === 0) return;
        event.preventDefault();
        const at = current ? ids.indexOf(current) : -1;
        const delta = event.code === 'ArrowRight' ? 1 : -1;
        const nextId = ids[at < 0 ? (delta > 0 ? 0 : ids.length - 1) : (at + delta + ids.length) % ids.length]!;
        activateTab(nextId, 'keyboard');
        if (scrollerRef.current?.parentElement?.contains(document.activeElement)) tabEl(nextId)?.focus();
      } else if (event.code === 'KeyW') {
        if (!current) return;
        event.preventDefault();
        closeTab(current, 'keyboard');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [runtime, activateTab, closeTab, tabEl]);

  // ---- roving focus inside the tablist ---------------------------------------
  const onTabKeyDown = (event: KeyboardEvent<HTMLDivElement>, tabId: TabId) => {
    const at = tabIds.indexOf(tabId);
    const focusAt = (index: number) => {
      event.preventDefault();
      const id = tabIds[(index + tabIds.length) % tabIds.length];
      if (!id) return;
      setFocusId(id);
      tabEl(id)?.focus();
    };
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    switch (event.key) {
      case 'ArrowRight':
        return focusAt(at + 1);
      case 'ArrowLeft':
        return focusAt(at - 1);
      case 'Home':
        return focusAt(0);
      case 'End':
        return focusAt(tabIds.length - 1);
      case 'Enter':
      case ' ':
        event.preventDefault();
        return activateTab(tabId, 'keyboard');
      case 'ContextMenu':
        break;
      case 'F10':
        if (!event.shiftKey) return;
        break;
      default:
        return;
    }
    event.preventDefault();
    const r = event.currentTarget.getBoundingClientRect();
    setMenu({ type: 'tab', tabId, at: { x: r.left, y: r.bottom }, trigger: event.currentTarget });
  };

  // ---- scroll: wheel → horizontal, edge fades, overflow detection -----------
  const measure = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const over = el.scrollWidth > el.clientWidth + 1;
    const start = over && el.scrollLeft > 1;
    const end = over && el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setOverflow((prev) => (prev.over === over && prev.start === start && prev.end === end ? prev : { over, start, end }));
  }, []);
  useLayoutEffect(measure, [measure, tabIds]);
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      // A trackpad's horizontal swipe scrolls natively; a vertical wheel is mapped across.
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX) || el.scrollWidth <= el.clientWidth) return;
      event.preventDefault();
      el.scrollLeft += event.deltaY;
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('scroll', measure, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(el);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  }, [measure]);

  // Activation scrolls the strip into view — the strip only, never the page.
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el || !active) return;
    const tab = el.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(active)}"]`);
    if (!tab) return;
    // The scroller is the tab's offsetParent (position: relative).
    const left = tab.offsetLeft;
    const right = left + tab.offsetWidth;
    if (left < el.scrollLeft) el.scrollLeft = left;
    else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth;
    measure();
  }, [active, tabIds, measure]);

  // ---- drag to reorder ----------------------------------------------------------
  const onDragStart = (event: DragEvent<HTMLDivElement>, tabId: TabId) => {
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', tabId);
    setDragId(tabId);
  };
  const onDragOver = (event: DragEvent<HTMLDivElement>, overId: TabId) => {
    if (!dragId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const after = event.clientX > rect.left + rect.width / 2;
    const index = tabIds.indexOf(overId) + (after ? 1 : 0);
    const beforeTabId = tabIds[index];
    const box = scroller.getBoundingClientRect();
    // The boundary the tab will land on (tabs sit flush, R27).
    const edge = (after ? rect.right : rect.left) - box.left + scroller.scrollLeft;
    setDrop((prev) => (prev?.beforeTabId === beforeTabId && prev.x === edge ? prev : { beforeTabId, x: edge }));
  };
  const endDrag = () => {
    setDragId(null);
    setDrop(null);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!dragId || !drop) return endDrag();
    event.preventDefault();
    const { beforeTabId } = drop;
    if (beforeTabId !== dragId) {
      // Past the last visible tab: land right after it, ahead of any hidden ones.
      const state = runtime.store.getState();
      const lastVisible = tabIds[tabIds.length - 1];
      let target = beforeTabId;
      if (target === undefined && lastVisible && lastVisible !== dragId) {
        const order = state.orderedTabIds.filter((id) => id !== dragId);
        target = order[order.indexOf(lastVisible) + 1];
      }
      dispatch({
        command: 'workspace.tabs.move',
        args: target === undefined ? { tabId: dragId } : { tabId: dragId, beforeTabId: target },
        source: 'click',
      });
    }
    endDrag();
  };

  // ---- menus --------------------------------------------------------------------
  const menuRef = useRef(menu);
  menuRef.current = menu;
  const closeMenu = useCallback((restoreFocus: boolean) => {
    if (restoreFocus) menuRef.current?.trigger?.focus();
    setMenu(null);
  }, []);

  const copyLink = useCallback(
    async (entityId: string) => {
      const hash = build(defaultRoute(spaceId as SpaceId, { view: 'tabs', tab: entityId as never })).hash;
      const url = `${window.location.origin}${window.location.pathname}${hash.startsWith('#') ? hash : `#${hash}`}`;
      try {
        await navigator.clipboard.writeText(url);
        gate.onNotice({ id: `tws-copy-${Date.now()}`, tone: 'info', title: 'Link copied', body: '', ttlMs: NOTICE_TTL_MS });
      } catch {
        gate.onNotice({
          id: `tws-copy-${Date.now()}`,
          tone: 'info',
          title: "Couldn't copy the link",
          body: url,
          ttlMs: NOTICE_TTL_MS,
        });
      }
    },
    [spaceId, gate],
  );

  const menuItems = useMemo<MenuItem[]>(() => {
    if (!menu) return [];
    if (menu.type === 'overflow') {
      return tabs.map((tab) => ({
        key: tab.id,
        label: <OverflowRow tab={tab} />,
        checked: tab.id === active,
        run: (source) => {
          activateTab(tab.id, source);
          tabEl(tab.id)?.focus();
        },
      }));
    }
    const tab = tabs.find((t) => t.id === menu.tabId);
    if (!tab) return [];
    return [
      { key: 'close', label: 'Close', run: (source) => closeTab(tab.id, source) },
      {
        key: 'others',
        label: 'Close others',
        disabled: tabs.length < 2,
        run: (source) => closeVisible(source, tab.id),
      },
      { key: 'visible', label: 'Close visible tabs', run: (source) => closeVisible(source) },
      {
        key: 'copy',
        label: 'Copy link',
        disabled: tab.type !== 'entity',
        run: () => {
          if (tab.type === 'entity') void copyLink(tab.entityId);
        },
      },
    ];
  }, [menu, tabs, active, activateTab, closeTab, closeVisible, copyLink, tabEl]);

  const restore = leading ?? (expanded ? (
    <button
      type="button"
      className="tws-ts-btn"
      aria-label="Restore navigation"
      title="Restore navigation"
      onClick={() => dispatch({ command: 'workspace.layout.set', args: { expanded: false }, source: 'click' })}
    >
      <SidebarShowGlyph />
    </button>
  ) : null);

  return (
    <div className="tws-strip tws-ts" data-testid="tws-strip" data-has-leading={restore ? true : undefined}>
      {restore ? <div className="tws-ts-leading">{restore}</div> : null}
      <div
        ref={scrollerRef}
        className="tws-ts-scroll"
        role="tablist"
        aria-label="Open tabs"
        aria-orientation="horizontal"
        data-fade-start={overflow.start || undefined}
        data-fade-end={overflow.end || undefined}
        onDragOver={(event) => {
          if (dragId) event.preventDefault();
        }}
        onDrop={onDrop}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(null);
        }}
      >
        {tabs.map((tab) => (
          <Tab
            key={tab.id}
            tab={tab}
            active={tab.id === active}
            focusable={tab.id === rovingId}
            dragging={tab.id === dragId}
            onActivate={activateTab}
            onClose={closeTab}
            onKeyDown={onTabKeyDown}
            onFocus={setFocusId}
            onContextMenu={(tabId, at) => setMenu({ type: 'tab', tabId, at, trigger: tabEl(tabId) })}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDragEnd={endDrag}
          />
        ))}
        {drop ? <span className="tws-ts-marker" aria-hidden="true" style={{ left: drop.x - 1 }} /> : null}
      </div>
      <div className="tws-ts-pinned">
        {overflow.over ? (
          <button
            type="button"
            className="tws-ts-btn"
            aria-label="All visible tabs"
            aria-haspopup="menu"
            aria-expanded={menu?.type === 'overflow'}
            onClick={(event) => {
              const r = event.currentTarget.getBoundingClientRect();
              setMenu(
                menu?.type === 'overflow'
                  ? null
                  : { type: 'overflow', at: { x: r.right - 240, y: r.bottom + 4 }, trigger: event.currentTarget },
              );
            }}
          >
            <ChevronGlyph />
          </button>
        ) : null}
        <button
          type="button"
          className="tws-ts-btn"
          aria-label="Open a new tab"
          title="Open a new tab"
          onClick={(event) => dispatch({ command: 'workspace.chooser.open', args: {}, source: sourceOf(event) })}
        >
          <PlusGlyph />
        </button>
        <ScopePicker />
      </div>
      {menu ? (
        <StripMenu
          key={menu.type === 'tab' ? `tab-${menu.tabId}` : 'overflow'}
          items={menuItems}
          label={menu.type === 'tab' ? 'Tab actions' : 'All visible tabs'}
          at={menu.at}
          onClose={closeMenu}
        />
      ) : null}
      <ConfirmDiscard
        onResolved={(choice) => {
          // Keep editing returns focus to where it was; a discard follows the close.
          refocusAfterClose.current = choice === 'discard';
        }}
      />
    </div>
  );
}
