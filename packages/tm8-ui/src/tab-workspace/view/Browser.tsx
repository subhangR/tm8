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
import { cloneElement, isValidElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { useAttentionOptional } from '../../attention';
import { needsMeListSource } from '../../attention/needs-me';
import type { EntityId } from '@tm8/contract';
import { getKind, isHomeRootKind, KIND_ART, resolveAction, type ActionRef } from '../../domain';
import { composeListActions, useChatAbout } from '../../views/useChatAbout';
import { useLaunchPort } from '../../views/useLaunchPort';
import { usePanelPrimaries } from '../../views/usePanelPrimaries';
import { useRowLifecycle } from '../../views/useRowLifecycle';
import { useSessionStart } from '../../views/useSessionStart';
import { useDismissable } from '../../panels/useDismissable';
import { useMarkEntitySeen } from '../../seen-entities/EntitySeen';
import { EntityListPanel, type ListEmptyState, type ListFilterState } from '../../panels/EntityListPanel';
import { requestLinkFocus } from '../../panels/list/linkFocus';
import { sidePatch } from './sideSection';
import { ListRootHeader, type ListRootOption } from '../../panels/ListRootHeader';
import { useStore } from 'zustand';
import { getBrowserSource } from '../adapters/browserSources';
import { getKindAdapter } from '../adapters/registry';
import { getBrowserSourceStore } from '../runtime/browserSourceStore';
import { activeEntityId } from '../runtime/selectors';
import { workspaceCommands } from '@tm8/contract/workspace';

const { EMPTY_BROWSER_KIND_STATE } = workspaceCommands.browser;
import { WORKSPACE_KINDS, type KindId } from '../runtime/types';
import { useShellFrame, useWorkspace, useWorkspaceState } from './context';
import { useListCursor } from './listCursor';
import { isNavigatorEnabled, isPinnedRailEnabled } from './navigatorFlag';
import { VectorIcon } from '../../kit/VectorIcon';
import { getRailStore } from '../runtime/railStore';
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

/**
 * The browser column: a kind's entity list, or the selected non-entity
 * source's panel (`adapters/browserSources.ts`, e.g. Project files), read
 * from the registry so the column never knows which source it shows.
 */
export function Browser() {
  const { spaceId } = useWorkspace();
  const sources = useMemo(() => getBrowserSourceStore(spaceId), [spaceId]);
  const source = getBrowserSource(useStore(sources, (s) => s.source));
  const pinnedRail = useMemo(() => isPinnedRailEnabled(), []);
  if (source) {
    return (
      <section className="tws-browser" aria-label={source.label} data-testid="tws-browser" data-source={source.id}>
        {pinnedRail ? <PanelTop searchable /> : null}
        <source.Panel />
      </section>
    );
  }
  return <EntityBrowser />;
}

/** The sidebar toggle: a panel outline with its left column drawn in. */
const SIDEBAR_ART = ['M2.5 3.5h11v9h-11z', 'M6 3.5v9'];
/** The ⌕ on `VectorIcon`'s 16×16 grid: a ring and its handle. */
const SEARCH_ART = ['M7 2.75a4.25 4.25 0 1 1 0 8.5a4.25 4.25 0 1 1 0-8.5', 'M10.25 10.25L13.25 13.25'];

/**
 * THE PANEL'S TOP ROW (pinned-only rail, Subhang 2026-10-17):
 *
 *     Space: transfer-e2e-scratch-2 ▾    [⌕] [▯]
 *
 * The space switcher is the panel's title (the tm8 mark heads the rail). ⌕
 * opens the app's own search — the palette `/` opens — never a box inline in
 * the column; ▯ collapses the panel, leaving the rail.
 */
export function PanelTop({ searchable = false }: { searchable?: boolean }) {
  /* The shell frame, not the workspace: the framed modes (Settings, …) draw
     this same row with no Work runtime mounted. */
  const { spaceId, gate } = useShellFrame();
  const collapse = () => getRailStore(spaceId).getState().setCollapsed(true);
  return (
    <div className="tws-paneltop" data-testid="tws-paneltop">
      <div
        className="tws-paneltop__space"
        data-testid="tws-paneltop-space"
        /* ONE TARGET: the "Space:" word opens the same menu its name does. */
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('.shell-switcher')) return;
          event.currentTarget.querySelector<HTMLButtonElement>('.shell-switcher__trigger')?.click();
        }}
      >
        <span className="tws-paneltop__label">Space:</span>
        {isValidElement<{ collapsed?: boolean; quiet?: boolean }>(gate.switcherSlot)
          ? cloneElement(gate.switcherSlot, { collapsed: false, quiet: true })
          : gate.switcherSlot}
      </div>
      <span className="tws-paneltop__spacer" />
      {searchable ? (
        <button
          type="button"
          className="tws-icon-btn"
          aria-label="Search"
          title="Search  /"
          aria-keyshortcuts="/"
          data-testid="tws-paneltop-search"
          onClick={() => gate.openPalette()}
        >
          <VectorIcon paths={SEARCH_ART} size={16} />
        </button>
      ) : null}
      <button
        type="button"
        className="tws-icon-btn"
        aria-label="Collapse panel"
        title="Collapse panel"
        data-testid="tws-paneltop-collapse"
        onClick={collapse}
      >
        <VectorIcon paths={SIDEBAR_ART} size={16} />
      </button>
    </div>
  );
}

/**
 * The tile's cells, left to right (Subhang 2026-10-20: "chat | task | terminal
 * | doc | drawing, only icons"). `terminal` is not a kind: it asks which
 * project and starts a shell; every other cell opens that kind's draft.
 */
const QUICK_NEW_CELLS = ['chat', 'task', 'terminal', 'doc', 'drawing'] as const satisfies readonly (KindId | 'terminal')[];

/** A project the tile's Terminal can open in (`data.launch.projects`). */
export interface TerminalProjectOption {
  id: string;
  name: string;
  trusted: boolean;
  /** `trusted · <working dir>` for a trusted project. */
  detail: string;
  reason?: string;
}

export interface QuickNewTerminal {
  /** Absent ⇒ no seam or space: Terminal is drawn refused, never live. */
  start?: (projectId: string | null) => void;
  projects: readonly TerminalProjectOption[];
}

/**
 * NEW CHAT · TASK · TERMINAL · DOC · DRAWING (pinned-only rail, Subhang
 * 2026-10-17; icons only, five cells, 2026-10-20): one row at the head of
 * every list. Each kind cell opens the same draft the list's own ＋ opens for
 * that kind — a new chat picks its project on the composer's own chip.
 * Terminal ASKS which project first (Subhang: "only terminal asks for the
 * project"; Bhargav: terminals start in the project's folder) and starts the
 * shell there, or in a scratch directory. One black-and-white paper tile, each
 * cell wearing its kind's mark, named by its tooltip and aria-label.
 */
export function QuickNew({ terminal }: { terminal: QuickNewTerminal }) {
  const { dispatch } = useWorkspace();
  const [asking, setAsking] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setAsking(false), []);
  useDismissable(asking, boxRef, close);
  const start = terminal.start;
  const terminalRefusal = start ? null : 'Terminals cannot be started here — no node is connected';
  return (
    <div className="tws-quicknew-box" ref={boxRef}>
      <div className="tws-quicknew" role="group" aria-label="New" data-testid="tws-quicknew">
        {QUICK_NEW_CELLS.map((cell) => {
          if (cell === 'terminal') {
            return (
              <button
                key={cell}
                type="button"
                className="tws-quicknew__btn"
                aria-label="New terminal"
                aria-haspopup="menu"
                aria-expanded={asking}
                aria-disabled={terminalRefusal !== null || undefined}
                title={terminalRefusal ?? 'New terminal — pick the project folder it opens in'}
                data-kind="terminal"
                data-testid="tws-quicknew-terminal"
                onClick={() => {
                  if (terminalRefusal !== null) return;
                  setAsking((was) => !was);
                }}
              >
                <span className="tws-quicknew__glyph" aria-hidden>
                  <VectorIcon paths={KIND_ART.work_session} size={16} strokeWidth={1.5} />
                </span>
              </button>
            );
          }
          const adapter = getKindAdapter(cell);
          const disabledReason = adapter.creatable === true ? null : adapter.creatable.disabledReason;
          const label = `New ${adapter.noun.toLowerCase()}`;
          return (
            <button
              key={cell}
              type="button"
              className="tws-quicknew__btn"
              aria-label={label}
              aria-disabled={disabledReason !== null || undefined}
              title={disabledReason ?? label}
              data-kind={cell}
              data-testid={`tws-quicknew-${cell}`}
              onClick={() => {
                if (disabledReason !== null) return;
                dispatch({ command: 'workspace.drafts.open', args: { kind: cell }, source: 'click' });
              }}
            >
              <span className="tws-quicknew__glyph" aria-hidden>
                <VectorIcon paths={KIND_ART[cell]} size={16} strokeWidth={1.5} />
              </span>
            </button>
          );
        })}
      </div>
      {asking && start ? (
        <div className="tws-quicknew-menu" role="menu" aria-label="Open a terminal in" data-testid="tws-quicknew-terminal-menu">
          <p className="tws-quicknew-menu__heading">Open a terminal in</p>
          {terminal.projects.map((project) => {
            const refused = project.trusted ? null : project.reason ?? 'untrusted — trust it in Node settings';
            return (
              <button
                key={project.id}
                type="button"
                role="menuitem"
                className="tws-quicknew-menu__opt"
                aria-disabled={refused !== null || undefined}
                title={refused ?? project.detail}
                data-testid={`tws-quicknew-terminal-${project.id}`}
                onClick={() => {
                  if (refused !== null) return;
                  close();
                  start(project.id);
                }}
              >
                <span className="tws-quicknew-menu__name">{project.name}</span>
                <span className="tws-quicknew-menu__hint">{refused ?? workingDirOf(project.detail)}</span>
              </button>
            );
          })}
          <button
            type="button"
            role="menuitem"
            className="tws-quicknew-menu__opt"
            data-testid="tws-quicknew-terminal-scratch"
            onClick={() => {
              close();
              start(null);
            }}
          >
            <span className="tws-quicknew-menu__name">Scratch</span>
            <span className="tws-quicknew-menu__hint">a private empty directory</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** `trusted · ~/code/x` → `~/code/x`: the menu's hint is the folder itself. */
function workingDirOf(detail: string): string {
  return detail.replace(/^trusted · /, '');
}

function EntityBrowser() {
  const { dispatch, gate, store } = useWorkspace();
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
  /*
   * ＋ New AND THE KIND ▾ LEAVE THE TOOLBAR with the navigator on (§5): New is
   * the first thing in the column (`NavNew`) and the kind is chosen in ONE
   * place, the pins. Keeping the box here would put the ＋ twice on screen and
   * a second kind picker over the same selection — the "one selection, two
   * views of it" hazard `EntityListPanel`'s `selectorSlot` comment names.
   *
   * `workspace.drafts.open` is unchanged; only who draws the button moves.
   */
  const navigator = useMemo(() => isNavigatorEnabled(), []);
  /* THE PINNED-ONLY RAIL (`tm8.ui.navigator = 'rail'`): New chat and New task
     head every list, and the new box sits at the end of the one-row header. */
  const pinnedRail = useMemo(() => isPinnedRailEnabled(), []);

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
  /* The kind menu's per-row ＋ (pinned-only rail): New for THAT kind, in one
     press, refused with the registry's own reason where it cannot be made. */
  const createKindDraft = useCallback(
    (next: string) => dispatch({ command: 'workspace.drafts.open', args: { kind: next as KindId }, source: 'click' }),
    [dispatch],
  );
  const createKindUnavailable = useCallback((next: string) => {
    const creatable = getKindAdapter(next as KindId).creatable;
    return creatable === true ? null : { cause: creatable.disabledReason, remedy: 'open its own screen to make one' };
  }, []);
  const clearSearch = useCallback(() => {
    set({ query: '' });
    setGeneration((n) => n + 1);
  }, [set]);
  const retry = useCallback(() => {
    data.ensureKind(kind);
    setGeneration((n) => n + 1);
  }, [data, kind]);

  /**
   * THE COUNTS LINE'S DOOR (design doc 01a1465d §6): a click on `◇1` opens
   * the row's tab and its side column on LINKS, narrowed to that group —
   * never rows expanded inline under the list, which is the relation
   * accordion this replaced.
   *
   * The group is handed over through `requestLinkFocus` rather than through
   * the tab patch, because it is a request and not a persisted preference —
   * see `linkFocus.ts`. The ORDER matters: the request is filed before the
   * tab opens, so the Links section has it on its very first render and the
   * reader never sees the unfiltered list flash past.
   *
   * `toggle: false` on the patch. The default would CLOSE a column already
   * showing Links, so clicking a second row's count while the panel was open
   * would have shut it — a door that closes the room it is standing in.
   */
  const openLinks = useCallback(
    (entityId: string, groupKind: string) => {
      requestLinkFocus(entityId, groupKind);
      const result = dispatch({ command: 'workspace.tabs.open', args: { kind, entityId }, source: 'click' });
      if (result.status !== 'applied' || !result.tabId) return;
      const tab = result.tabId;
      const record = store.getState().tabs[tab];
      if (!record || record.type !== 'entity') return;
      dispatch({
        command: 'workspace.tabs.setUi',
        args: { tabId: tab, patch: sidePatch(record, 'links', true, false) },
        source: 'click',
      });
    },
    [dispatch, kind, store],
  );

  /* A row click opens or focuses the entity's tab. A scope-hidden tab comes
     back as `requires_user_choice`, which RevealPrompt renders from
     `store.pending`. */
  const openRow = useCallback(
    /* `rowKind`: a launched session nested in the chat list opens as a session. */
    (entityId: string, rowKind?: string) => {
      dispatch({ command: 'workspace.tabs.open', args: { kind: rowKind ?? kind, entityId }, source: 'click' });
    },
    [dispatch, kind],
  );

  const scroll = useRememberedScroll(kindState.scrollTop, set, `${kind}:${generation}`);
  const listRef = useRef<HTMLDivElement>(null);
  useTierRowEdges(listRef);
  /* The keyboard row cursor (`l l`, then j/k, Enter, r, Esc). */
  const markSeen = useMarkEntitySeen();
  const openRowByKey = useCallback(
    (entityId: string) => {
      dispatch({ command: 'workspace.tabs.open', args: { kind, entityId }, source: 'keyboard' });
      markSeen(entityId);
    },
    [dispatch, kind, markSeen],
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
      {pinnedRail ? (
        <PanelTop searchable />
      ) : null}
      {pinnedRail ? <QuickNew terminal={verbs.terminal} /> : null}
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
          /* 331: the chat list nests the sessions each chat launched. */
          rowsForKind={data.rowsFor}
          /* The new box below draws the kind control and + New. */
          selectorSlot="host"
          mode="list"
          chrome="toolbar"
          rowLead="icon"
          /* Row 1: the panel's own search, then the dotted new box —
             [+ | kind icon ▾]: the + creates the current kind, the icon
             half is the kind menu. */
          toolbarInline={pinnedRail}
          toolbarEnd={navigator ? undefined : (
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
                  {...(pinnedRail ? { onCreateKind: createKindDraft, createKindUnavailable } : {})}
                />
              }
            />
          )}
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
          onOpenLinks={openLinks}
          compact
          initialQuery={kindState.query}
          onQueryChange={onQueryChange}
          /* No inline search in this layout: ⌕ is the app's search (the
             palette), so the list draws no search row and is never left
             narrowed by text nobody can see. */
          {...(pinnedRail ? { query: '', searchInHost: true } : {})}
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
  const terminal = useMemo<QuickNewTerminal>(
    () => ({
      ...(sessionStart.onAction ? { start: (projectId: string | null) => sessionStart.startTerminal(projectId) } : {}),
      projects: data.launch.projects.filter((project) => !project.scratch),
    }),
    [sessionStart, data.launch.projects],
  );
  return { launch, primaries, listActions, rowLifecycle, terminal };
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
