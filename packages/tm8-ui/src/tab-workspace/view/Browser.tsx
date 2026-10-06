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
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useAttentionOptional } from '../../attention';
import { needsMeListSource } from '../../attention/needs-me';
import { getKind, isHomeRootKind } from '../../domain';
import { EntityListPanel, type ListEmptyState, type ListFilterState } from '../../panels/EntityListPanel';
import { ListRootHeader, type ListRootOption } from '../../panels/ListRootHeader';
import { getKindAdapter } from '../adapters/registry';
import { activeEntityId } from '../runtime/selectors';
import { EMPTY_BROWSER_KIND_STATE } from '../runtime/commands/browser';
import { WORKSPACE_KINDS, type KindId } from '../runtime/types';
import { useWorkspace, useWorkspaceState } from './context';
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
      return (
        <ListState
          text={`No ${nounPlural} yet`}
          {...(disabledReason === null ? { action: { label: `New ${noun}`, run: createDraft } } : {})}
        />
      );
    },
    [retry, clearSearch, createDraft, disabledReason, noun, nounPlural],
  );

  const source = needsMeListSource(attentionApi, kind, data, {
    rowsFor: data.rowsFor(kind),
    pageStateOf: data.pageStateOf(kind),
    loadMore: data.loadMore(kind),
  });

  return (
    <section
      className="tws-browser"
      aria-label="Workspace browser"
      data-testid="tws-browser"
      data-narrow={narrow || undefined}
      data-scrolled={scroll.scrolled || undefined}
    >
      <div className="tws-browser-toolbar">
        <ListRootHeader
          rootsLabel="Workspace browser"
          kindMenuLabel="Entity kind in Workspace browser"
          cell={cell}
          cellActive
          onSelectCell={() => undefined}
          options={options}
          currentKind={kind}
          onPickKind={(next) => {
            if (next !== kind) set({ kind: next });
          }}
        />
        <button
          type="button"
          className="tws-browser-new"
          aria-label={`Create ${noun}`}
          aria-disabled={disabledReason !== null || undefined}
          title={disabledReason ?? `Create ${noun}`}
          data-testid="tws-browser-new"
          onClick={disabledReason === null ? createDraft : (event) => event.preventDefault()}
        >
          {narrow ? <span aria-hidden>+</span> : <span aria-hidden>+ New</span>}
        </button>
      </div>
      <div className="tws-browser-list">
        <EntityListPanel
          key={`${kind}:${generation}`}
          kind={kind}
          /* The toolbar above draws the kind control and + New. */
          selectorSlot="host"
          mode="list"
          chrome="toolbar"
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
