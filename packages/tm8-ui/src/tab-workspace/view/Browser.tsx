/**
 * Entity browser (Spec A §5): kind control · + New · search · filters · list.
 * Workstream B.
 *
 * REUSES, never forks: the kind control is `ListRootHeader`'s cell in its
 * opt-in menu-button mode, and the search, filters and rows are Home's own
 * `EntityListPanel`. The panel is remounted per kind and seeded from that
 * kind's remembered state, so switching kind restores query, filters and
 * scroll and can never carry one kind's filters onto another.
 *
 * Every write goes through `workspace.browser.set`; nothing here touches tabs
 * or scope except a row click (`tabs.open`) and + New (`drafts.open`).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useAttentionOptional } from '../../attention';
import { needsMeListSource } from '../../attention/needs-me';
import type { EntityId } from '@tm8/contract';
import { getKind, isHomeRootKind, resolveAction, type ActionRef } from '../../domain';
import { composeListActions, useChatAbout } from '../../views/useChatAbout';
import { useLaunchPort } from '../../views/useLaunchPort';
import { usePanelPrimaries } from '../../views/usePanelPrimaries';
import { useRowLifecycle } from '../../views/useRowLifecycle';
import { useSessionStart } from '../../views/useSessionStart';
import { EntityListPanel, type ListEmptyState, type ListFilterState } from '../../panels/EntityListPanel';
import { ListRootHeader, type ListRootOption } from '../../panels/ListRootHeader';
import { getKindAdapter } from '../adapters/registry';
import { activeEntityId } from '../runtime/selectors';
import { workspaceCommands } from '@tm8/contract/workspace';

const { EMPTY_BROWSER_KIND_STATE } = workspaceCommands.browser;
import { WORKSPACE_KINDS, type KindId } from '../runtime/types';
import { useWorkspace, useWorkspaceState } from './context';
import { useListCursor } from './listCursor';
import './browser.css';

const BROWSER_ID = 'main';
/** Below this browser width + New is icon-only (design log §4). */
const NARROW_BELOW_PX = 300;
/** Loading skeleton appears after this, so a fast read never flashes (design log §11). */
const LOADING_DELAY_MS = 200;
/** After this the skeleton says so and offers Retry: no endless spinner. */
const STILL_LOADING_MS = 10_000;
/** Scroll is remembered per kind; written at most this often. */
const SCROLL_WRITE_MS = 150;
/** A remembered scroll waits this long for the rows to arrive, then gives up. */
const SCROLL_RESTORE_MS = 5_000;

function optionOf(kind: KindId): ListRootOption {
  const config = getKind(kind);
  return { kind, label: config.labelPlural, single: config.label };
}

/**
 * The dotted new box: a bold + that creates the browser's current kind, and
 * that kind's icon + ▾ opening the kind menu. Each click on + fires a one-shot
 * ripple; the key remounts it so rapid clicks each get their own.
 */
export function NewBox({
  noun,
  disabledReason,
  onCreate,
  header,
}: {
  noun: string;
  disabledReason: string | null;
  onCreate: () => void;
  header: ReactNode;
}) {
  const [pulse, setPulse] = useState(0);
  return (
    <div
      className="tws-browser-new"
      role="group"
      aria-label={`New ${noun}`}
      data-testid="tws-browser-newbox"
      data-disabled={disabledReason !== null || undefined}
    >
      <button
        type="button"
        className="tws-browser-new__plus"
        aria-label={`Create ${noun}`}
        aria-disabled={disabledReason !== null || undefined}
        title={disabledReason ?? `New ${noun}`}
        data-testid="tws-browser-new"
        onClick={(event) => {
          if (disabledReason !== null) {
            event.preventDefault();
            return;
          }
          setPulse((n) => n + 1);
          onCreate();
        }}
      >
        <svg className="tws-browser-new__glyph" viewBox="0 0 12 12" width="12" height="12" aria-hidden>
          <path d="M6 1.5v9M1.5 6h9" />
        </svg>
      </button>
      <span className="tws-browser-new__rule" aria-hidden />
      {header}
      {pulse > 0 ? <span key={pulse} className="tws-browser-new__ripple" aria-hidden /> : null}
    </div>
  );
}

export function Browser() {
  const { dispatch, gate } = useWorkspace();
  const { data } = gate;
  const kind = useWorkspaceState((s) => s.browsers.main.kind);
  const kindState = useWorkspaceState((s) => s.browsers.main.perKind[kind]) ?? EMPTY_BROWSER_KIND_STATE;
  const selectedId = useWorkspaceState(activeEntityId);
  const narrow = useWorkspaceState((s) => s.layout.browserWidth < NARROW_BELOW_PX);
  const attentionApi = useAttentionOptional();

  const adapter = getKindAdapter(kind);
  const disabledReason = adapter.creatable === true ? null : adapter.creatable.disabledReason;
  const noun = adapter.noun.toLowerCase();
  const nounPlural = adapter.nounPlural.toLowerCase();

  /* The D7 allow-list, filtered to the kinds this registry can list. */
  const options = useMemo(() => WORKSPACE_KINDS.filter(isHomeRootKind).map(optionOf), []);
  const cell = useMemo(() => optionOf(kind), [kind]);
  /* The viewer is named so the "me" filters can match. */
  const viewerActorId = data.viewerActor?.id;
  const ctx = useMemo(
    () => ({ spaceId: data.spaceId, ...(viewerActorId ? { viewerActorId } : {}) }),
    [data.spaceId, viewerActorId],
  );

  /* Bumped to remount the panel with the current remembered state (Clear
     search, Retry); the kind is the other half of the key. */
  const [generation, setGeneration] = useState(0);

  useEffect(() => data.ensureKind(kind), [data, kind]);

  const set = useCallback(
    (patch: { kind?: KindId; query?: string; filters?: unknown; scrollTop?: number }) =>
      dispatch({ command: 'workspace.browser.set', args: { browserId: BROWSER_ID, ...patch }, source: 'click' }),
    [dispatch],
  );
  const onQueryChange = useCallback((query: string) => set({ query }), [set]);
  const onFiltersChange = useCallback((filters: ListFilterState) => set({ filters }), [set]);
  const createDraft = useCallback(
    () => dispatch({ command: 'workspace.drafts.open', args: { kind }, source: 'click' }),
    [dispatch, kind],
  );
  const clearSearch = useCallback(() => {
    set({ query: '' });
    setGeneration((n) => n + 1);
  }, [set]);
  const retry = useCallback(() => {
    data.ensureKind(kind);
    setGeneration((n) => n + 1);
  }, [data, kind]);

  /* A row click opens or focuses the entity's tab. A scope-hidden tab comes
     back as `requires_user_choice`, which RevealPrompt renders from
     `store.pending`. */
  const openRow = useCallback(
    (entityId: string) => {
      dispatch({ command: 'workspace.tabs.open', args: { kind, entityId }, source: 'click' });
    },
    [dispatch, kind],
  );

  const scroll = useRememberedScroll(kindState.scrollTop, set, `${kind}:${generation}`);
  const listRef = useRef<HTMLDivElement>(null);
  useTierRowEdges(listRef);
  /* The keyboard row cursor (`l l`, then j/k, Enter, r, Esc). */
  const openRowByKey = useCallback(
    (entityId: string) => dispatch({ command: 'workspace.tabs.open', args: { kind, entityId }, source: 'keyboard' }),
    [dispatch, kind],
  );
  const { onNotice } = gate;
  const notify = useCallback(
    (text: string) => onNotice({ id: `tws-list-${Date.now()}`, tone: 'info', title: text, body: '', ttlMs: 4_000 }),
    [onNotice],
  );
  const cursor = useListCursor(listRef, openRowByKey, notify);

  const renderEmpty = useCallback(
    (state: ListEmptyState) => {
      if (state.reason === 'loading') return <ListLoading onRetry={retry} />;
      if (state.reason === 'search') {
        return (
          <ListState
            text={`No ${nounPlural} match “${state.query}”`}
            action={{ label: 'Clear search', run: clearSearch }}
          />
        );
      }
      if (state.tier) return <ListState text={`No ${state.tier.toLowerCase()} ${nounPlural}`} />;
      return (
        <ListState
          text={`No ${nounPlural} yet`}
          {...(disabledReason === null ? { action: { label: `New ${noun}`, run: createDraft } } : {})}
        />
      );
    },
    [retry, clearSearch, createDraft, disabledReason, noun, nounPlural],
  );

  const verbs = useRowVerbs(kind);

  const source = needsMeListSource(attentionApi, kind, data, {
    rowsFor: data.rowsFor(kind),
    pageStateOf: data.pageStateOf(kind),
    loadMore: data.loadMore(kind),
  });

  return (
    <section
      className="tws-browser"
      aria-label="Work browser"
      data-testid="tws-browser"
      data-narrow={narrow || undefined}
      data-scrolled={scroll.scrolled || undefined}
    >
      <div
        className="tws-browser-list"
        ref={listRef}
        data-testid="tws-browser-list"
        /* Focusable by script only (`l l`); Tab order is unchanged. */
        tabIndex={-1}
        aria-label={`${adapter.nounPlural} — j/k to move, ←/→ for status, Enter to open, r to launch`}
        aria-keyshortcuts="L L"
        onFocus={cursor.onFocus}
        onBlur={cursor.onBlur}
        onKeyDown={cursor.onKeyDown}
      >
        <EntityListPanel
          key={`${kind}:${generation}`}
          kind={kind}
          /* The new box below draws the kind control and + New. */
          selectorSlot="host"
          mode="list"
          chrome="toolbar"
          rowLead="icon"
          /* Row 1: the panel's own search, then the dotted new box —
             [+ | kind icon ▾]: the + creates the current kind, the icon
             half is the kind menu. */
          toolbarEnd={
            <NewBox
              noun={noun}
              disabledReason={disabledReason}
              onCreate={createDraft}
              header={
                <ListRootHeader
                  rootsLabel="Work browser"
                  kindMenuLabel={`${cell.label} — change kind`}
                  kindMenuIconOnly
                  cell={cell}
                  cellActive
                  onSelectCell={() => undefined}
                  options={options}
                  currentKind={kind}
                  onPickKind={(next) => {
                    if (next !== kind) set({ kind: next });
                  }}
                />
              }
            />
          }
          {...source}
          members={data.members}
          ctx={ctx}
          liveIds={data.liveIds}
          livenessOf={data.livenessOf}
          activity={data.activity}
          messagePulses={data.messagePulses}
          {...(data.linkedPullRequestsOf ? { linkedPullRequestsOf: data.linkedPullRequestsOf } : {})}
          capabilitiesOf={data.capabilitiesOf}
          connectionsOf={data.connectionsOf}
          /* The row verbs (hover bar, expanded strip) — Home's executors. */
          onSetState={verbs.rowLifecycle.setState}
          onArchive={verbs.rowLifecycle.archive}
          onComplete={verbs.rowLifecycle.complete}
          onTerminate={verbs.primaries.terminate}
          onShareSession={verbs.primaries.shareSession}
          onResume={verbs.primaries.resume}
          onSetValue={verbs.rowLifecycle.setValue}
          onAssign={verbs.rowLifecycle.assign}
          assignableActors={verbs.rowLifecycle.assignable}
          onMembership={verbs.rowLifecycle.membership}
          membershipSets={verbs.rowLifecycle.membershipSets}
          launch={verbs.launch}
          onAction={verbs.listActions.onAction}
          wiredActions={verbs.listActions.wiredActions}
          /* The active tab's row wears the list's own selected treatment; the
             list is not scrolled to it. */
          selectedId={selectedId}
          onSelect={openRow}
          compact
          initialQuery={kindState.query}
          onQueryChange={onQueryChange}
          initialFilters={kindState.filters}
          onFiltersChange={onFiltersChange}
          bodyRef={scroll.ref}
          renderEmpty={renderEmpty}
        />
      </div>
    </section>
  );
}

/**
 * THE ROW VERBS, WIRED AS HOME WIRES THEM — the same executor hooks, so the
 * hover bar's Run / complete / terminate / chat-about carry the same gates,
 * refusals and launch flow. What differs is only where a result LANDS: a
 * started or spawned session, and a chat about an entity, open as tabs here.
 */
function useRowVerbs(kind: string) {
  const { dispatch, gate } = useWorkspace();
  const { data, onNotice, viewerMemberId } = gate;

  const openTab = useCallback(
    (tabKind: string, entityId: string, chat = false) => {
      const result = dispatch({ command: 'workspace.tabs.open', args: { kind: tabKind, entityId }, source: 'click' });
      if (chat && result.status === 'applied' && result.tabId) {
        dispatch({
          command: 'workspace.tabs.setUi',
          args: { tabId: result.tabId, patch: { chat: { open: true } } },
          source: 'click',
        });
      }
    },
    [dispatch],
  );
  const notifyFailed = useCallback(
    (verb: ActionRef, _entityId: string, error: unknown) => {
      onNotice({
        id: `tws-row-${verb}`,
        tone: 'error',
        title: `${resolveAction(verb).label} failed`,
        body: String((error as { message?: string })?.message ?? error),
        ttlMs: 6_000,
      });
    },
    [onNotice],
  );

  const launch = useLaunchPort(data, {
    onSpawn: async (input) => {
      const sessionId = await data.spawn(input);
      openTab('work_session', sessionId);
    },
  });
  const primaries = usePanelPrimaries({
    seam: data.seam,
    reconcileCommand: data.reconcileCommand,
    onError: notifyFailed,
    versionOf: (id) => data.detailOf(id)?.version,
  });
  const sessionStart = useSessionStart({
    spaceId: data.spaceId,
    seam: data.seam,
    reconcileCommand: data.reconcileCommand,
    projectId: data.launch.projects.find((p) => p.selectedByDefault && p.trusted)?.id ?? null,
    onOpen: (id: EntityId) => openTab('work_session', id),
    onError: (verb: ActionRef, error: unknown) => notifyFailed(verb, '', error),
  });
  const chatAbout = useChatAbout({
    open: (aboutId) => {
      if (aboutId) openTab(kind, aboutId, true);
    },
  });
  const listActions = useMemo(
    () =>
      composeListActions([
        { onAction: sessionStart.onAction, wiredActions: sessionStart.wiredActions },
        { onAction: chatAbout.onAction, wiredActions: chatAbout.wiredActions },
      ]),
    [sessionStart.onAction, sessionStart.wiredActions, chatAbout.onAction, chatAbout.wiredActions],
  );
  const rowLifecycle = useRowLifecycle({ data, viewerMemberId, onNotice });
  return { launch, primaries, listActions, rowLifecycle };
}

/**
 * The list's scroll, remembered per kind. On mount it waits (bounded) for the
 * rows to arrive and restores the remembered offset, unless the person
 * scrolls first; every later scroll is written back, throttled. `mountKey`
 * changes whenever the panel remounts.
 */
function useRememberedScroll(
  remembered: number,
  set: (patch: { scrollTop: number }) => void,
  mountKey: string,
) {
  const [body, setBody] = useState<HTMLDivElement | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const rememberedRef = useRef(remembered);
  rememberedRef.current = remembered;

  useLayoutEffect(() => {
    if (!body) return;
    let target: number | null = rememberedRef.current > 0 ? rememberedRef.current : null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const restore = () => {
      if (target === null) return;
      body.scrollTop = target;
      if (Math.abs(body.scrollTop - target) < 1) stopRestoring();
    };
    const observer = new MutationObserver(restore);
    const stopRestoring = () => {
      target = null;
      observer.disconnect();
    };
    const giveUp = setTimeout(stopRestoring, SCROLL_RESTORE_MS);
    const onUser = () => stopRestoring();
    const onScroll = () => {
      setScrolled(body.scrollTop > 0);
      if (target !== null) return;
      if (timer !== null) return;
      timer = setTimeout(() => {
        timer = null;
        set({ scrollTop: Math.round(body.scrollTop) });
      }, SCROLL_WRITE_MS);
    };
    observer.observe(body, { childList: true, subtree: true });
    restore();
    setScrolled(body.scrollTop > 0);
    body.addEventListener('scroll', onScroll, { passive: true });
    body.addEventListener('wheel', onUser, { passive: true });
    body.addEventListener('pointerdown', onUser);
    body.addEventListener('keydown', onUser);
    return () => {
      stopRestoring();
      clearTimeout(giveUp);
      if (timer !== null) clearTimeout(timer);
      body.removeEventListener('scroll', onScroll);
      body.removeEventListener('wheel', onUser);
      body.removeEventListener('pointerdown', onUser);
      body.removeEventListener('keydown', onUser);
    };
  }, [body, set, mountKey]);

  return { ref: setBody, scrolled };
}

/**
 * The lifecycle tier row scrolls on one line (R37): the clipped edge fades
 * over 16px (`data-fade` = start | end | both), and the active tier is kept
 * in view. Watches the host, because the panel inside remounts per kind.
 */
function useTierRowEdges(hostRef: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let row: HTMLElement | null = null;
    let activeId: string | null = null;
    const measure = () => {
      if (!row) return;
      const start = row.scrollLeft > 1;
      const end = row.scrollLeft + row.clientWidth < row.scrollWidth - 1;
      const fade = start && end ? 'both' : start ? 'start' : end ? 'end' : null;
      if (fade) row.setAttribute('data-fade', fade);
      else row.removeAttribute('data-fade');
    };
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    const sync = () => {
      const next = host.querySelector<HTMLElement>('.lp__tierscroll');
      if (next !== row) {
        row?.removeEventListener('scroll', measure);
        resize?.disconnect();
        row = next;
        activeId = null;
        if (row) {
          row.addEventListener('scroll', measure, { passive: true });
          resize?.observe(row);
        }
      }
      if (!row) return;
      const active = row.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      const id = active?.textContent ?? null;
      if (active && id !== activeId) {
        activeId = id;
        const left = active.offsetLeft - row.offsetLeft;
        if (left < row.scrollLeft || left + active.offsetWidth > row.scrollLeft + row.clientWidth) {
          row.scrollLeft = Math.max(0, left - 16);
        }
      }
      measure();
    };
    const observer = new MutationObserver(sync);
    observer.observe(host, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-selected'] });
    sync();
    return () => {
      observer.disconnect();
      resize?.disconnect();
      row?.removeEventListener('scroll', measure);
    };
  }, [hostRef]);
}

/** The list's empty and no-match states (design log §11): one line and a text action. */
function ListState({ text, action }: { text: string; action?: { label: string; run: () => void } }) {
  return (
    <div className="tws-browser-state" role="status">
      <p className="tws-browser-state__text">{text}</p>
      {action ? (
        <button type="button" className="tws-browser-state__action" onClick={action.run}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Loading: nothing for 200ms, then three skeleton bars; after 10s it says it
 * is still loading and offers Retry, so it never spins forever.
 */
function ListLoading({ onRetry }: { onRetry: () => void }) {
  const [phase, setPhase] = useState<'quiet' | 'skeleton' | 'slow'>('quiet');
  useEffect(() => {
    const show = setTimeout(() => setPhase('skeleton'), LOADING_DELAY_MS);
    const slow = setTimeout(() => setPhase('slow'), STILL_LOADING_MS);
    return () => {
      clearTimeout(show);
      clearTimeout(slow);
    };
  }, []);
  if (phase === 'quiet') return null;
  if (phase === 'slow') return <ListState text="Still loading…" action={{ label: 'Retry', run: onRetry }} />;
  return (
    <div className="tws-browser-skeleton" aria-busy="true" aria-label="Loading">
      <span className="tws-browser-skeleton__bar" />
      <span className="tws-browser-skeleton__bar" />
      <span className="tws-browser-skeleton__bar" />
    </div>
  );
}
