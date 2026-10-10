/**
 * ONE CRAFT — `/craft/{craft}[/{page}]` (Craft → Crafts, D2–D5 and change
 * list items 10–12). It replaced the blueprint studio.
 *
 *   ‹ Crafts · Title ▾
 *   [chat about the craft] ┃ [Overview | page row …… ＋ page]  [side] [strip]
 *                           ┃ [overview, or the selected page]
 *
 *  · LEFT, the craft's chats (`CraftChatPane`): all ABOUT the craft, mode
 *    pinned to craft; the agent picks which page to work on.
 *  · MIDDLE, the page row (`PageRow`, the tab strip's look; Overview pinned
 *    first) over the selected tab. Overview is `CraftOverview`; a graph page
 *    is the blueprint canvas (`GraphPage`); every other kind, a craft page
 *    included, is the Workspace entity body.
 *  · RIGHT, ONLY the selected tab's entity strip, exactly as in Home: its
 *    options on top, Links · Messages · Chat, Run, Expand below. Overview
 *    selected ⇒ the craft's own strip. The tab keeps its own side column
 *    (Chat · Messages · Links), beside the body, never in place of it.
 *
 * The selected page is in the URL (no page ⇒ Overview); there is no per-user
 * tab state yet, and the row is the same for everyone (D5).
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
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
  embeddedTab,
  getKindAdapter,
  useEmbeddedRuntime,
  useEntityChromeValue,
  type EntityTabRecord,
  type WorkspaceRuntime,
} from '../tab-workspace/embed';
import { HostedEntityColumn } from '../views/hostedEntityColumn';
import { useFrameSlots } from '../shell/AppFrame';
import { CraftChatPane } from './CraftChatPane';
import { GraphPage, type ToolNote } from './GraphPage';
import { CraftOverview } from './CraftOverview';
import { PageRow } from './PageRow';
import { useCraft, type CraftHandle } from './useCraft';
import type { CraftPageRow, CraftSource, NewPageKind } from './craft-source';
import type { CraftCard, CraftsSource } from './crafts-source';
import type { CraftPanelHostProps } from './types';
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
   * Inside the app frame (round 2, R2-D1): the frame's panel lists the crafts
   * and pages, so this screen draws no header of its own — its title and chat
   * toggle go to the frame's top band — and the craft chat is a column on
   * the RIGHT, beside the page, as Work's side column is (never a second left
   * column next to the panel).
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

/** The private runtime's record for one entity, seeded after render. */
function useEmbeddedTab(runtime: WorkspaceRuntime, entityId: string | null, kind: string | null): EntityTabRecord | null {
  const record = useStore(runtime.store, (s) => (entityId ? s.tabs[entityId] : undefined));
  useLayoutEffect(() => {
    if (entityId && kind) embeddedTab(runtime, entityId, kind);
  }, [runtime, entityId, kind]);
  return record?.type === 'entity' && record.kind === kind ? record : null;
}

export function CraftScreen(props: CraftScreenProps) {
  const { seam, spaceId, nodeKey, source, craftId, pageId, onNavigate, crafts, gate, panelHost, onNotice, framed = false } = props;
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

  const handle = useCraft(source, craftId, pageId ?? null, onNotice);
  /* THE SELECTED TAB: a page of this craft, or — no page in the route, or one
     that has left the craft — the craft's own overview. */
  const activePage = selectedPage(handle.pages, pageId);
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

  const selectPage = useCallback((id: EntityId) => onNavigate({ craftId, pageId: id }), [onNavigate, craftId]);
  const selectOverview = useCallback(() => onNavigate({ craftId }), [onNavigate, craftId]);

  /* An entity opened from the chat or a page: a page of this craft is
     selected; anything else opens in the column over the page (or leaves). */
  const [detailId, setDetailId] = useState<EntityId | null>(null);
  const pagesRef = useRef(handle.pages);
  pagesRef.current = handle.pages;
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

  const chatPane = (
    <section className="crf-chat" id="crf-chat-pane" aria-label="Craft chat" hidden={chatHidden} data-side={framed ? 'right' : 'left'}>
      <CraftChatPane
        seam={seam}
        spaceId={spaceId}
        nodeKey={nodeKey}
        craftId={craftId}
        bridge={props.bridge}
        skillOptions={props.skillOptions}
        viewerName={props.viewerName}
        viewerId={props.viewerId}
        composerSeed={composerSeed}
        onPrompt={seedPrompt}
        toolNote={toolNote ?? undefined}
        onOpenEntity={openEntity}
      />
    </section>
  );
  const chatResizer = (side: 'left' | 'right') => (
    <PanelResizer
      side={side}
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
        <path d={chatHidden ? (framed ? 'M10 2.5 V13.5' : 'M6 2.5 V13.5') : framed ? 'M10 2.5 V13.5 M11 5 H14 M11 7.5 H14' : 'M6 2.5 V13.5 M2 5 H5 M2 7.5 H5'} />
      </svg>
    </button>
  );

  const pagesSection = (
    <section className="dsn-main" aria-label={`Pages of ${title || 'the craft'}`} data-testid="dsn-main">
      {handle.state === 'ready' ? (
        <PageRow
          pages={handle.pages}
          activeId={activePage?.id ?? null}
          updated={handle.updated}
          label={`Pages of ${title}`}
          ownerId={craftId}
          onOverview={selectOverview}
          onSelect={selectPage}
          onMove={(id, index) => void handle.move(id, index)}
          onRemove={(id) => {
            void handle.remove(id).then((ok) => {
              if (ok && id === activePage?.id) selectOverview();
            });
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
        {/* Framed: the craft's chat is the right-hand column, before the strip. */}
        {framed && !chatHidden ? chatResizer('right') : null}
        {framed ? chatPane : null}
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
            <span className="crf-head__fill" />
            {chatToggle}
          </div>,
          frameTop,
        ) : null
      ) : <header className="crf-head dsn-head" data-testid="dsn-head">
        {chatToggle}
        <button type="button" className="dsn-crumb" data-testid="dsn-back" onClick={() => onNavigate({})}>
          <span aria-hidden>‹</span> Crafts
        </button>
        <span className="crf-head__sep" aria-hidden>·</span>
        <CraftSwitcher title={title} crafts={crafts} currentId={craftId} onPick={(id) => onNavigate({ craftId: id })} />
        <span className="crf-head__fill" />
      </header>}
      <div className="crf-split" ref={splitRef} style={{ '--crf-chat': `${chatWidth}px` } as CSSProperties}>
        {framed ? null : chatPane}
        {framed || chatHidden ? null : chatResizer('left')}
        {pagesSection}
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

/** The route's page when it is still in the craft; null ⇒ the overview is the selected tab. */
function selectedPage(pages: readonly CraftPageRow[], id: EntityId | undefined): CraftPageRow | null {
  return (id && pages.find((page) => page.id === id)) || null;
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
 * that craft's own body, inline — no nested page rows.
 */
function PageBody(props: PageBodyProps) {
  const { page, seam, gate, runtime } = props;
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

/** The title and its ▾: switch to another craft without going home. */
function CraftSwitcher({
  title,
  crafts,
  currentId,
  onPick,
}: {
  title: string;
  crafts: CraftsSource | undefined;
  currentId: EntityId;
  onPick(id: EntityId): void;
}) {
  const [open, setOpen] = useState(false);
  const [cards, setCards] = useState<readonly CraftCard[] | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open || !crafts) return;
    let live = true;
    crafts.list().then(
      (list) => live && setCards(list),
      () => live && setCards([]),
    );
    const onDown = (event: MouseEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      live = false;
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, crafts]);

  if (!crafts) {
    return <h1 className="dsn-title" data-testid="dsn-title">{title}</h1>;
  }
  return (
    <div className="dsn-switch" ref={wrapRef}>
      <button
        type="button"
        className="crf-pick dsn-title"
        data-testid="dsn-title"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Switch craft"
        onClick={() => setOpen((was) => !was)}
      >
        <span className="crf-pick__title">{title}</span>
        <span className="crf-pick__caret" aria-hidden>
          ▾
        </span>
      </button>
      {open ? (
        <div className="crf-pop" role="menu" aria-label="Crafts" data-testid="dsn-switch-pop">
          <div className="crf-pop__list">
            {cards === null ? (
              <p className="crf-pop__hollow" role="status">Loading crafts…</p>
            ) : (
              cards.map((card) => (
                <button
                  type="button"
                  role="menuitem"
                  key={card.id}
                  className="crf-pop__row"
                  data-active={card.id === currentId || undefined}
                  onClick={() => {
                    setOpen(false);
                    if (card.id !== currentId) onPick(card.id);
                  }}
                >
                  <span className="crf-pop__row-title">{card.title}</span>
                  <span className="crf-pop__row-meta">{`${card.pageCount} page${card.pageCount === 1 ? '' : 's'}`}</span>
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
