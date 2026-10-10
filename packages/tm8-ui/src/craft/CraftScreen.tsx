/**
 * ONE CRAFT — `/craft/{craft}[/{page}]` (Craft redesign doc 01a1255d §3).
 *
 *   ‹ Crafts · Title ▾
 *   [chat about the craft] ┃ [pages ▾][Overview][Plan ×][Brief ×]  [side] [strip]
 *                           ┃ [the selected tab's body]
 *
 *  · LEFT, the craft's chats and sessions (`CraftSidePanel`), in the app frame's second panel.
 *  · MIDDLE, THIS PERSON'S tabs on the craft (`CraftTabStrip`, backed by their
 *    craft workspace — `useCraftWorkspace`), Overview pinned first. Overview
 *    is `CraftOverview`; a graph page is the blueprint canvas (`GraphPage`); a
 *    page that is itself a craft opens inline as that craft's overview; every
 *    other kind is the Workspace entity body. Closing a tab never removes a
 *    page; pages are added and removed from [pages ▾].
 *  · RIGHT, ONLY the selected tab's entity strip, exactly as in Home: its
 *    options on top, Links · Messages · Chat, Run, Expand below. Overview
 *    selected ⇒ the craft's own strip. The tab keeps its own side column
 *    (Chat · Messages · Links), beside the body, never in place of it.
 *
 * The route mirrors the selected tab (no page ⇒ Overview).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from 'zustand';
import type { EntityId, SpaceId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import type { ChatHomeL2Bridge } from '../chat-home/real-port';
import type { TriggerOption } from '../rich-input';
import { getKind, KindIcon } from '../domain';
import { PanelResizer, useElementWidth, usePanelWidth } from '../kit';
import { build, emptyPanels, normalize } from '../routes';
import type { WorkspaceGateHandles } from '../tab-workspace';
import {
  ActionStrip,
  ChatDock,
  EmbeddedWorkspace,
  EntityChromeContext,
  EntityTabBody,
  getKindAdapter,
  useEmbeddedRuntime,
  useEntityChromeValue,
  type WorkspaceRuntime,
} from '../tab-workspace/embed';
import { HostedEntityColumn } from '../views/hostedEntityColumn';
import { useFrameSlots } from '../shell/AppFrame';
import { CraftSidePanel } from './CraftSidePanel';
import { GraphPage, type ToolNote } from './GraphPage';
import { CraftOverview } from './CraftOverview';
import { CraftTabStrip } from './CraftTabStrip';
import { craftWorkspacesPortOf, useCraftWorkspace } from './useCraftWorkspace';
import { useCraft, type CraftHandle } from './useCraft';
import type { CraftPageRow, CraftSource, NewPageKind } from './craft-source';
import type { CraftsSource } from './crafts-source';
import type { CraftPanelHostProps } from './types';
import { useEmbeddedTab } from './use-embedded-tab';
import '../session-graph/session-graph.css';
import './craft.css';
import './craft-screen.css';

/** Where the screen navigates: no craft ⇒ the Crafts home. */
export interface CraftTarget {
  craftId?: EntityId;
  pageId?: EntityId;
}

export interface CraftScreenProps {
  seam: Seam;
  spaceId: SpaceId;
  nodeKey: string;
  source: CraftSource;
  craftId: EntityId;
  pageId?: EntityId | undefined;
  onNavigate(target: CraftTarget): void;
  /** The home's source, for the title's ▾ craft switcher. Absent ⇒ the title is plain text. */
  crafts?: CraftsSource | undefined;
  /**
   * The Workspace handles. Present ⇒ non-graph pages render the Workspace
   * entity body and the action strip is mounted; absent (harness mounts) ⇒
   * a page that is not a graph or craft says what it is and offers Open.
   */
  gate?: WorkspaceGateHandles | undefined;
  /** Present ⇒ an entity opened from the chat lands in a column over the page. */
  panelHost?: CraftPanelHostProps | undefined;
  bridge?: ChatHomeL2Bridge | undefined;
  skillOptions?: readonly TriggerOption[] | undefined;
  viewerName?: string | undefined;
  viewerId?: string | undefined;
  onNotice?: ((text: string) => void) | undefined;
  /**
   * Inside the app frame: the craft's chats and sessions (`CraftSidePanel`)
   * fill the frame's own panel column beside the rail — the 2nd panel — and
   * this screen draws no header of its own (its title goes to the frame's
   * top band). Unframed hosts keep the chat as this screen's left column.
   */
  framed?: boolean | undefined;
}

/** The chat pane's default and floor (the composer's: narrower wraps it to three rows). */
const CHAT_DEFAULT = 440;
const CHAT_MIN = 360;
/** The pages keep at least this much, so dragging can never erase them. */
const PAGES_MIN = 320;
/** The separator track (8px) plus the pane's 1px border. */
const PANE_CHROME = 8 + 1;

/** `/craft/{craft}` as an absolute URL — what the craft's "Copy link" copies. */
function craftLinkUrl(spaceId: SpaceId, craftId: EntityId): string {
  const { hash } = build(normalize({ spaceId, target: { view: 'craft', designId: craftId }, panels: emptyPanels() }));
  return new URL(hash, window.location.href).toString();
}

const noop = () => undefined;

export function CraftScreen(props: CraftScreenProps) {
  const { seam, spaceId, nodeKey, source, craftId, pageId, onNavigate, gate, panelHost, onNotice, framed = false } = props;
  const frame = useFrameSlots();
  const frameTop = frame.top;
  const runtime = useEmbeddedRuntime(props.viewerId ?? 'viewer', spaceId);
  const expanded = useStore(runtime.store, (s) => s.layout.expanded);

  /* THE STRIP'S EXPAND IS THE FRAME'S: expanding hides the frame's rail, panel
     and header, as Work's does; the frame's own "Restore navigation" restores. */
  const setFrameExpanded = frame.setExpanded;
  useEffect(() => {
    setFrameExpanded?.(expanded);
  }, [expanded, setFrameExpanded]);
  const frameWasExpanded = useRef(frame.expanded);
  useEffect(() => {
    const was = frameWasExpanded.current;
    frameWasExpanded.current = frame.expanded;
    if (was && !frame.expanded && runtime.store.getState().layout.expanded) {
      runtime.dispatch({ command: 'workspace.layout.set', args: { expanded: false }, source: 'click' });
    }
  }, [frame.expanded, runtime]);

  const [composerSeed, setComposerSeed] = useState<{ text: string; nonce: number } | undefined>(undefined);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const seedPrompt = useCallback((text: string) => {
    setChatCollapsed(false);
    setComposerSeed((was) => ({ text, nonce: (was?.nonce ?? 0) + 1 }));
  }, []);

  /* The transcript note for calls that wrote the ACTIVE graph page. A function
     value, so it is stored through an updater, never as one. */
  const [toolNote, setToolNote] = useState<ToolNote | null>(null);
  const publishToolNote = useCallback((note: ToolNote | null) => setToolNote(() => note), []);

  /* The page on screen, fed back to `useCraft` for its "updated" marks. */
  const [lookingAt, setLookingAt] = useState<EntityId | null>(pageId ?? null);
  const handle = useCraft(source, craftId, lookingAt, onNotice);
  const pageIds = useMemo(
    () => (handle.state === 'ready' ? new Set<string>(handle.pages.map((page) => page.id)) : null),
    [handle.state, handle.pages],
  );
  /* THE SELECTED TAB: this person's active tab — a page of this craft, or the
     craft's own overview. */
  const tabs = useCraftWorkspace(craftWorkspacesPortOf(seam), spaceId, craftId, pageIds, onNotice);
  const activePage = tabs.activeTab.pinned ? null : (handle.pages.find((page) => page.id === tabs.activeTab.entityId) ?? null);
  useEffect(() => setLookingAt(activePage?.id ?? null), [activePage?.id]);
  const pagesRef = useRef(handle.pages);
  pagesRef.current = handle.pages;
  /* The updated mark clears on the page being looked at. */
  useEffect(() => {
    if (activePage) handle.seen(activePage.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePage?.id, handle.seen, handle.updated]);

  /* DELETED WHILE OPEN (the overview strip's Delete, or anyone's) ⇒ back to the
     Crafts home. A link to an already-deleted craft keeps its notice. */
  const craftGone = handle.state === 'deleted' || gate?.data.detailOf(craftId)?.deletedAt != null;
  const sawCraft = useRef(false);
  useEffect(() => {
    sawCraft.current = false;
  }, [craftId]);
  useEffect(() => {
    if (!craftGone) {
      if (handle.state === 'ready') sawCraft.current = true;
    } else if (sawCraft.current) {
      sawCraft.current = false;
      onNavigate({});
    }
  }, [craftGone, handle.state, onNavigate]);

  /* THE ROUTE MIRRORS THE ACTIVE TAB. The workspace's active tab is the
     truth (another window or the craft agent may move it); the URL follows it
     — no page ⇒ the overview — and a URL the viewer brought (a shared link,
     Back) opens or focuses its tab once. `routedRef` is the page the route
     was last reconciled to; a route that differs is the viewer's ask. */
  const openTab = tabs.open;
  const activateTab = tabs.activate;
  const routedRef = useRef<EntityId | undefined | null>(null);
  const activeRoute = tabs.activeTab.pinned ? undefined : (tabs.activeTab.entityId as EntityId);
  useEffect(() => {
    if (!tabs.loaded || routedRef.current !== pageId) return;
    if (activeRoute === pageId) return;
    routedRef.current = activeRoute;
    onNavigate(activeRoute ? { craftId, pageId: activeRoute } : { craftId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs.loaded, activeRoute]);
  useEffect(() => {
    if (!tabs.loaded || handle.state !== 'ready' || routedRef.current === pageId) return;
    routedRef.current = pageId;
    if (!pageId) {
      activateTab(craftId);
      return;
    }
    const page = handle.pages.find((row) => row.id === pageId);
    if (page) void openTab(page.kind, page.id);
    else onNavigate(activeRoute ? { craftId, pageId: activeRoute } : { craftId });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs.loaded, pageId, handle.state, handle.pages]);

  /* Open (or focus) a page's tab; the route follows. */
  const selectPage = useCallback(
    (id: EntityId) => {
      /* A page added a moment ago may not be on screen yet: read its kind. */
      const known = pagesRef.current.find((row) => row.id === id);
      const page = known ? Promise.resolve(known) : source.read(craftId).then((read) => read.pages.find((row) => row.id === id));
      void page.then((row) => row && openTab(row.kind, row.id), () => undefined);
    },
    [openTab, craftId, source],
  );

  /* An entity opened from the chat or a page: a page of this craft is
     selected; anything else opens in the column over the page (or leaves). */
  const [detailId, setDetailId] = useState<EntityId | null>(null);
  const openEntity = useCallback(
    (id: EntityId) => {
      if (pagesRef.current.some((page) => page.id === id)) {
        setDetailId(null);
        selectPage(id);
      } else if (panelHost) setDetailId(id);
      else if (gate) gate.navigateView({ view: 'entity', entityId: id, origin: null });
    },
    [panelHost, gate, selectPage],
  );
  useEffect(() => {
    if (!detailId) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      setDetailId(null);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [detailId]);

  /* THE WIDTH SOLVER: `usePanelWidth` holds what the viewer asked for; this
     screen clamps for paint against the measured split. */
  const splitRef = useRef<HTMLDivElement | null>(null);
  const splitWidth = useElementWidth(splitRef);
  const chatPref = usePanelWidth('craft.chat', CHAT_DEFAULT, CHAT_MIN);
  const chatMax = splitWidth > 0 ? Math.max(CHAT_MIN, splitWidth - PAGES_MIN - PANE_CHROME) : Number.POSITIVE_INFINITY;
  const chatWidth = Math.min(Math.max(CHAT_MIN, chatPref.width), chatMax);

  /* ONE STRIP, THE SELECTED TAB'S (Workspace hosts only): exactly Home's — the
     entity's own options on top; Links · Messages · Chat, Run, Expand and More
     below — over one chrome seam, for the one body mounted. The overview's
     subject is the craft itself. */
  const [mainEl, setMainEl] = useState<HTMLDivElement | null>(null);
  const chrome = useEntityChromeValue(mainEl);
  const ownerTab = useEmbeddedTab(runtime, gate && !activePage ? craftId : null, gate && !activePage ? 'design' : null);
  const pageTab = useEmbeddedTab(runtime, gate && activePage ? activePage.id : null, gate && activePage ? activePage.kind : null);
  const stripTab = activePage ? pageTab : ownerTab;
  const chatHidden = chatCollapsed || expanded;
  /* Without a strip, the graph's controls need a home of their own. */
  const [liteSlot, setLiteSlot] = useState<HTMLDivElement | null>(null);
  const controlsSlot = gate ? chrome.kindSlot : liteSlot;

  const title = handle.craft?.title ?? '';
  const onNewPage = useNewPage(handle, seedPrompt, (id) => selectPage(id));

  const body: ReactNode =
    handle.state === 'loading' ? (
      <p className="crf-empty" role="status">Loading the craft…</p>
    ) : handle.state === 'deleted' ? (
      <div className="crf-empty" data-testid="dsn-deleted">
        <p>This craft was deleted.</p>
        <button type="button" className="dsn-btn" onClick={() => onNavigate({})}>Back to Crafts</button>
      </div>
    ) : handle.state === 'error' ? (
      <div className="crf-empty" data-testid="dsn-error">
        <p>This craft could not be read.</p>
        <button type="button" className="dsn-btn" onClick={handle.retry}>Retry</button>
      </div>
    ) : activePage ? (
      <PageBody
        key={activePage.id}
        page={activePage}
        seam={seam}
        source={source}
        gate={gate}
        runtime={runtime}
        controlsSlot={controlsSlot}
        onAsk={seedPrompt}
        onOpenEntity={openEntity}
        onToolNote={publishToolNote}
      />
    ) : (
      /* THE OVERVIEW — the craft's own tab (its detail panel: every page live, stacked). */
      <CraftOverview
        tab={ownerTab}
        pages={handle.pages}
        panel={{ seam, source, gate, runtime, onOpenPage: selectPage, onAsk: seedPrompt, onOpenEntity: openEntity, onNotice }}
        onOpenEntity={openEntity}
        onClose={() => onNavigate({})}
      />
    );

  /* The craft's chats and sessions (spec §3, 2nd panel): framed, the frame's
     own panel column beside the rail; unframed, the left column here. */
  const sidePanel = (
    <CraftSidePanel
      seam={seam}
      spaceId={spaceId}
      nodeKey={nodeKey}
      craftId={craftId}
      title={title}
      gate={gate}
      runtime={runtime}
      bridge={props.bridge}
      skillOptions={props.skillOptions}
      viewerName={props.viewerName}
      viewerId={props.viewerId}
      composerSeed={composerSeed}
      onPrompt={seedPrompt}
      toolNote={toolNote ?? undefined}
      onOpenEntity={openEntity}
      onNotice={onNotice}
    />
  );
  const chatPane = (
    <section className="crf-chat" id="crf-chat-pane" aria-label="Craft chat" hidden={chatHidden}>
      {sidePanel}
    </section>
  );
  const chatResizer = (
    <PanelResizer
      side="left"
      label="Craft chat"
      controls="crf-chat-pane"
      width={chatWidth}
      minWidth={CHAT_MIN}
      maxWidth={chatMax}
      onResize={chatPref.setWidth}
      onReset={chatPref.reset}
    />
  );
  const toggleChat = () => {
    if (expanded) runtime.dispatch({ command: 'workspace.layout.set', args: { expanded: false }, source: 'click' });
    else setChatCollapsed((was) => !was);
  };
  const chatToggle = (
    <button
      type="button"
      className="crf-head__chat"
      data-testid="crf-chat-toggle"
      aria-pressed={!chatHidden}
      aria-controls="crf-chat-pane"
      title={chatHidden ? 'Show the chat' : 'Hide the chat'}
      onClick={toggleChat}
    >
      <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden>
        <rect x={1.5} y={2.5} width={13} height={11} rx={2} />
        <path d={chatHidden ? 'M6 2.5 V13.5' : 'M6 2.5 V13.5 M2 5 H5 M2 7.5 H5'} />
      </svg>
    </button>
  );

  const pagesSection = (
    <section className="dsn-main" aria-label={`Pages of ${title || 'the craft'}`} data-testid="dsn-main">
      {handle.state === 'ready' ? (
        <CraftTabStrip
          tabs={tabs.tabs}
          activeTabId={tabs.activeTab.id}
          pages={handle.pages}
          craftTitle={title}
          updated={handle.updated}
          onSelect={activateTab}
          onClose={tabs.close}
          onMove={tabs.move}
          onOpenPage={(page) => selectPage(page.id)}
          onRemovePage={(id) => {
            /* The node drops the page's tab; the strip hides it at once. */
            void handle.remove(id);
          }}
          onNew={onNewPage}
          onAddExisting={(id) => void handle.addExisting(id).then((ok) => ok && selectPage(id))}
          candidates={(text) => source.candidates(text)}
        />
      ) : null}
      <div className="dsn-band">
        <div className="dsn-content" ref={setMainEl}>
          <div className="dsn-page" data-testid="dsn-page">
            {gate ? <EntityChromeContext.Provider value={chrome}>{body}</EntityChromeContext.Provider> : body}
          </div>
          {detailId && panelHost ? (
            <aside className="crf-detail" data-overlay aria-label="Entity details" data-testid="crf-detail">
              <div className="crf-detail__entity">
                <HostedEntityColumn
                  {...panelHost}
                  entityId={detailId}
                  onOpenEntity={(id) => setDetailId(id as EntityId)}
                  onClose={() => setDetailId(null)}
                />
              </div>
            </aside>
          ) : null}
        </div>
        {/* The selected tab's side column — Links · Messages · Chat — as in
            the Workspace; each page (and the overview) keeps its own. */}
        {gate && stripTab ? <ChatDock tab={stripTab} onOpenEntity={(id) => openEntity(id as EntityId)} /> : null}
        {gate && stripTab ? (
          <EntityChromeContext.Provider value={chrome}>
            <ActionStrip tab={stripTab} linkUrl={activePage ? undefined : craftLinkUrl(spaceId, craftId)} />
          </EntityChromeContext.Provider>
        ) : gate ? null : (
          <div className="dsn-strip-lite" ref={setLiteSlot} data-testid="dsn-strip-lite" />
        )}
      </div>
    </section>
  );

  const screen = (
    <div className="crf-root dsn-root" data-testid="craft-screen">
      {framed ? (
        frameTop ? createPortal(
          <div className="dsn-frame-top" data-testid="dsn-head">
            <span className="dsn-frame-top__title">{title || 'Untitled craft'}</span>
          </div>,
          frameTop,
        ) : null
      ) : <header className="crf-head dsn-head" data-testid="dsn-head">
        {chatToggle}
        <button type="button" className="dsn-crumb" data-testid="dsn-back" onClick={() => onNavigate({})}>
          <span aria-hidden>‹</span> Crafts
        </button>
        <span className="crf-head__sep" aria-hidden>·</span>
        {/* Switching crafts is the top bar's job now (CraftHeaderSwitcher). */}
        <h1 className="dsn-title" data-testid="dsn-title">
          {title}
        </h1>
        <span className="crf-head__fill" />
      </header>}
      <div className="crf-split" ref={splitRef} style={{ '--crf-chat': `${chatWidth}px` } as CSSProperties}>
        {framed ? null : chatPane}
        {framed || chatHidden ? null : chatResizer}
        {pagesSection}
        {framed && frame.panel ? createPortal(sidePanel, frame.panel) : null}
      </div>
    </div>
  );

  return gate ? (
    <EmbeddedWorkspace runtime={runtime} gate={gate}>
      {screen}
    </EmbeddedWorkspace>
  ) : (
    screen
  );
}

/** `[+ page]`: create and open; Artifact asks the agent, which is the one door artifacts have. */
function useNewPage(handle: CraftHandle, ask: (text: string) => void, open: (id: EntityId) => void) {
  return useCallback(
    (kind: NewPageKind) => {
      if (kind === 'artifact') {
        ask('Add an artifact page to this craft: ');
        return;
      }
      void handle.createPage(kind).then((id) => id && open(id));
    },
    [handle, ask, open],
  );
}

interface PageBodyProps {
  page: CraftPageRow;
  seam: Seam;
  source: CraftSource;
  gate: WorkspaceGateHandles | undefined;
  runtime: WorkspaceRuntime;
  /** The strip TOP's kind slot (or the lite strip without a Workspace host). */
  controlsSlot: HTMLElement | null;
  onAsk(text: string): void;
  onOpenEntity(id: EntityId): void;
  onToolNote(note: ToolNote | null): void;
}

/**
 * One page's body, in its kind's full view. A page that is itself a craft is
 * that craft's overview, inline — no nested page rows.
 */
function PageBody(props: PageBodyProps) {
  const { page, seam, gate, runtime } = props;
  if (page.kind === 'craft' || page.kind === 'design') return <CraftPage {...props} />;
  if (page.kind === 'graph') {
    return (
      <>
        <GraphPage
          seam={seam}
          graphId={page.id}
          controlsSlot={props.controlsSlot}
          onAsk={props.onAsk}
          onOpenEntity={props.onOpenEntity}
          onToolNote={props.onToolNote}
        />
        {gate ? <GraphChrome page={page} runtime={runtime} onOpenEntity={props.onOpenEntity} /> : null}
      </>
    );
  }
  if (!gate) return <PlainPage page={page} onOpen={() => props.onOpenEntity(page.id)} />;
  return <WorkspacePage page={page} runtime={runtime} onOpenEntity={props.onOpenEntity} />;
}

/**
 * A PAGE THAT IS ITSELF A CRAFT (doc §3): one tab, showing that craft's own
 * overview in place. Its pages are not tabs here — they are not pages of
 * this craft.
 */
function CraftPage({ page, seam, source, gate, runtime, onAsk, onOpenEntity }: PageBodyProps) {
  const nested = useCraft(source, page.id, null);
  const tab = useEmbeddedTab(runtime, gate ? page.id : null, gate ? page.kind : null);
  return (
    <div className="dsn-nested" data-testid="dsn-nested" data-craft={page.id}>
      <CraftOverview tab={tab} pages={nested.pages} panel={{ seam, source, gate, runtime, onAsk, onOpenPage: onOpenEntity, onOpenEntity }} onOpenEntity={onOpenEntity} onClose={noop} />
    </div>
  );
}

/** A non-graph page: the Workspace entity adapter's body, in the private runtime. */
function WorkspacePage({
  page,
  runtime,
  onOpenEntity,
}: {
  page: CraftPageRow;
  runtime: WorkspaceRuntime;
  onOpenEntity(id: EntityId): void;
}) {
  const tab = useEmbeddedTab(runtime, page.id, page.kind);
  if (!tab) return null;
  return (
    <div className="dsn-entity tws-entity-main tws-entity-host">
      <EntityTabBody
        tab={tab}
        adapter={getKindAdapter(page.kind)}
        onOpenEntity={(id) => onOpenEntity(id as EntityId)}
        onClose={noop}
      />
    </div>
  );
}

/**
 * A GRAPH PAGE'S STRIP. The canvas is the body (Craft is where a graph is
 * built), but the strip must be the graph's own, exactly as in Home: Run,
 * Edit, Links · Messages, Rename and Delete. Those are drawn by the entity
 * panel into the strip's slots, so its body is mounted HIDDEN: only its
 * portals show, and it loads the detail the strip's Links/Messages read.
 */
function GraphChrome({ page, runtime, onOpenEntity }: { page: CraftPageRow; runtime: WorkspaceRuntime; onOpenEntity(id: EntityId): void }) {
  const tab = useEmbeddedTab(runtime, page.id, page.kind);
  if (!tab) return null;
  return (
    <div hidden className="dsn-graph-chrome" data-testid="dsn-graph-chrome">
      <EntityTabBody tab={tab} adapter={getKindAdapter(page.kind)} onOpenEntity={(id) => onOpenEntity(id as EntityId)} onClose={noop} />
    </div>
  );
}

/** Without a Workspace host (harness mounts): what the page is, and Open. */
function PlainPage({ page, onOpen }: { page: CraftPageRow; onOpen(): void }) {
  return (
    <div className="dsn-plain" data-testid="dsn-plain-page">
      <KindIcon kind={page.kind} size={24} />
      <h2 className="dsn-plain__title">{page.title}</h2>
      <p className="dsn-plain__line">{getKind(page.kind).label}</p>
      <button type="button" className="dsn-btn" onClick={onOpen}>Open</button>
    </div>
  );
}
