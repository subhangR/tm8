/**
 * ONE DESIGN — `/craft/{design}[/{page}[/{nestedPage}]]` (Craft → Designs,
 * D2–D7 and change list items 10–12). It replaced the blueprint studio.
 *
 *   ‹ Designs · Title ▾
 *   [chat about the design] ┃ [page row ………………… ＋ page]           [strip]
 *                           ┃ [the active page, in its kind's full view] [TOP]
 *                           ┃                                            [BOT]
 *
 *  · LEFT, the design's chats (`DesignChatPane`): all ABOUT the design, mode
 *    pinned to craft; the agent picks which page to work on.
 *  · MIDDLE, the page row (`PageRow`, the tab strip's look) over the active
 *    page. A graph page is the blueprint canvas (`GraphPage`); a design page
 *    holds its own smaller row in place (D7); every other kind is the
 *    Workspace entity body.
 *  · RIGHT, the Workspace action strip, split by subject (D6): TOP is the
 *    active page's own controls, BOTTOM is the design's Run, Links, Messages,
 *    Expand and More.
 *
 * Opening a page, the active page and a nested page are all in the URL; there
 * is no per-user tab state, and the row is the same for everyone (D5).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
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
  EmbeddedWorkspace,
  EntityChromeContext,
  EntityTabBody,
  embeddedTab,
  getKindAdapter,
  useEmbeddedRuntime,
  useEntityChromeValue,
  type EntityChromeContextValue,
  type EntityTabRecord,
  type WorkspaceRuntime,
} from '../tab-workspace/embed';
import { HostedEntityColumn } from '../views/hostedEntityColumn';
import { DesignChatPane } from './DesignChatPane';
import { GraphPage, type ToolNote } from './GraphPage';
import { PageRow } from './PageRow';
import { useDesign, type DesignHandle } from './useDesign';
import type { DesignPageRow, DesignSource, NewPageKind } from './design-source';
import type { DesignCard, DesignsSource } from './designs-source';
import type { CraftPanelHostProps } from './types';
import '../session-graph/session-graph.css';
import './craft.css';
import './design-screen.css';

/** Where the screen navigates: no design ⇒ the Designs home. */
export interface DesignTarget {
  designId?: EntityId;
  pageId?: EntityId;
  nestedPageId?: EntityId;
}

export interface DesignScreenProps {
  seam: Seam;
  spaceId: SpaceId;
  nodeKey: string;
  source: DesignSource;
  designId: EntityId;
  pageId?: EntityId | undefined;
  nestedPageId?: EntityId | undefined;
  onNavigate(target: DesignTarget): void;
  /** The home's source, for the title's ▾ design switcher. Absent ⇒ the title is plain text. */
  designs?: DesignsSource | undefined;
  /**
   * The Workspace handles. Present ⇒ non-graph pages render the Workspace
   * entity body and the action strip is mounted; absent (harness mounts) ⇒
   * a page that is not a graph or design says what it is and offers Open.
   */
  gate?: WorkspaceGateHandles | undefined;
  /** Present ⇒ an entity opened from the chat lands in a column over the page. */
  panelHost?: CraftPanelHostProps | undefined;
  bridge?: ChatHomeL2Bridge | undefined;
  skillOptions?: readonly TriggerOption[] | undefined;
  viewerName?: string | undefined;
  viewerId?: string | undefined;
  onNotice?: ((text: string) => void) | undefined;
}

/** The chat pane's default and floor (the composer's: narrower wraps it to three rows). */
const CHAT_DEFAULT = 440;
const CHAT_MIN = 360;
/** The pages keep at least this much, so dragging can never erase them. */
const PAGES_MIN = 320;
/** The separator track (8px) plus the pane's 1px border. */
const PANE_CHROME = 8 + 1;

/** `/craft/{design}` as an absolute URL — what the design's "Copy link" copies. */
function designLinkUrl(spaceId: SpaceId, designId: EntityId): string {
  const { hash } = build(normalize({ spaceId, target: { view: 'craft', designId }, panels: emptyPanels() }));
  return new URL(hash, window.location.href).toString();
}

const noop = () => undefined;

/** A chrome that takes only a Run: a nested design's Run goes to the strip TOP, the rest stays hidden. */
function runOnlyChrome(commonVerbsSlot: HTMLElement | null): EntityChromeContextValue {
  return {
    verbsSlot: null,
    kindSlot: null,
    commonVerbsSlot,
    statsSlot: null,
    outlineSlot: null,
    titleSlot: null,
    menuSlot: null,
    dangerSlot: null,
    menuOpen: false,
    setMenuOpen: noop,
    contentWidth: Infinity,
    setVerbsSlot: noop,
    setKindSlot: noop,
    setCommonVerbsSlot: noop,
    setStatsSlot: noop,
    setOutlineSlot: noop,
    setTitleSlot: noop,
    setMenuSlot: noop,
    setDangerSlot: noop,
  };
}

/** The private runtime's record for one entity, seeded after render. */
function useEmbeddedTab(runtime: WorkspaceRuntime, entityId: string | null, kind: string | null): EntityTabRecord | null {
  const record = useStore(runtime.store, (s) => (entityId ? s.tabs[entityId] : undefined));
  useLayoutEffect(() => {
    if (entityId && kind) embeddedTab(runtime, entityId, kind);
  }, [runtime, entityId, kind]);
  return record?.type === 'entity' && record.kind === kind ? record : null;
}

export function DesignScreen(props: DesignScreenProps) {
  const { seam, spaceId, nodeKey, source, designId, pageId, nestedPageId, onNavigate, designs, gate, panelHost, onNotice } = props;
  const runtime = useEmbeddedRuntime(props.viewerId ?? 'viewer', spaceId);
  const expanded = useStore(runtime.store, (s) => s.layout.expanded);

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

  const handle = useDesign(source, designId, pageId ?? null, onNotice);
  const activePage = pickPage(handle.pages, pageId);
  /* The updated mark clears on the page being looked at. */
  useEffect(() => {
    if (activePage) handle.seen(activePage.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activePage?.id, handle.seen, handle.updated]);

  const selectPage = useCallback((id: EntityId) => onNavigate({ designId, pageId: id }), [onNavigate, designId]);

  /* An entity opened from the chat or a page: a page of this design is
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
  const chatHidden = chatCollapsed || expanded;

  /* The strip's two subjects and their chrome seams (Workspace hosts only). */
  const [pageMainEl, setPageMainEl] = useState<HTMLDivElement | null>(null);
  const pageChrome = useEntityChromeValue(pageMainEl);
  const ownerChrome = useEntityChromeValue(null);
  const ownerTab = useEmbeddedTab(runtime, gate ? designId : null, gate ? 'design' : null);
  const pageTab = useEmbeddedTab(runtime, gate && activePage ? activePage.id : null, gate && activePage ? activePage.kind : null);
  const ownerSection = ownerTab?.ui.subview ?? 'entity';
  /* Without a strip, the graph's controls need a home of their own. */
  const [liteSlot, setLiteSlot] = useState<HTMLDivElement | null>(null);
  const controlsSlot = gate ? pageChrome.kindSlot : liteSlot;

  const title = handle.design?.title ?? '';
  const onNewPage = useNewPage(handle, seedPrompt, (id) => selectPage(id));

  const body: ReactNode =
    handle.state === 'loading' ? (
      <p className="crf-empty" role="status">Loading the design…</p>
    ) : handle.state === 'deleted' ? (
      <div className="crf-empty" data-testid="dsn-deleted">
        <p>This design was deleted.</p>
        <button type="button" className="dsn-btn" onClick={() => onNavigate({})}>Back to Designs</button>
      </div>
    ) : handle.state === 'error' ? (
      <div className="crf-empty" data-testid="dsn-error">
        <p>This design could not be read.</p>
        <button type="button" className="dsn-btn" onClick={handle.retry}>Retry</button>
      </div>
    ) : !activePage ? (
      <p className="crf-empty" data-testid="dsn-no-pages">
        No pages yet. Ask the chat to start one, or add a page with ＋.
      </p>
    ) : (
      <PageBody
        key={activePage.id}
        page={activePage}
        depth={0}
        seam={seam}
        source={source}
        gate={gate}
        runtime={runtime}
        controlsSlot={controlsSlot}
        runSlot={pageChrome.commonVerbsSlot}
        nestedPageId={nestedPageId}
        onSelectNested={(id) => onNavigate({ designId, pageId: activePage.id, nestedPageId: id })}
        onOpenDesign={(id) => onNavigate({ designId: id })}
        onAsk={seedPrompt}
        onOpenEntity={openEntity}
        onToolNote={publishToolNote}
        onNotice={onNotice}
      />
    );

  const pagesSection = (
    <section className="dsn-main" aria-label={`Pages of ${title || 'the design'}`} data-testid="dsn-main">
      {handle.state === 'ready' ? (
        <PageRow
          pages={handle.pages}
          activeId={activePage?.id ?? null}
          updated={handle.updated}
          label={`Pages of ${title}`}
          ownerId={designId}
          onSelect={selectPage}
          onMove={(id, index) => void handle.move(id, index)}
          onRemove={(id) => {
            const at = handle.pages.findIndex((page) => page.id === id);
            void handle.remove(id).then((ok) => {
              if (!ok || id !== activePage?.id) return;
              const next = handle.pages.filter((page) => page.id !== id)[Math.max(0, at - 1)];
              onNavigate(next ? { designId, pageId: next.id } : { designId });
            });
          }}
          onNew={onNewPage}
          onAddExisting={(id) => void handle.addExisting(id).then((ok) => ok && selectPage(id))}
          candidates={(text) => source.candidates(text)}
        />
      ) : null}
      <div className="dsn-band">
        <div className="dsn-content" ref={setPageMainEl}>
          <div className="dsn-page" hidden={ownerSection !== 'entity'} data-testid="dsn-page">
            {gate ? <EntityChromeContext.Provider value={pageChrome}>{body}</EntityChromeContext.Provider> : body}
          </div>
          {/* The DESIGN's own panel: always mounted under a Workspace host, so its
              Run and ⋯ portal into the strip's BOTTOM; shown when the strip's
              Links or Messages is chosen. */}
          {gate && ownerTab ? (
            <div className="dsn-owner" hidden={ownerSection === 'entity'} data-testid="dsn-owner">
              <EntityChromeContext.Provider value={ownerChrome}>
                <EntityTabBody
                  tab={ownerTab}
                  adapter={getKindAdapter('design')}
                  onOpenEntity={(id) => openEntity(id as EntityId)}
                  onClose={() => onNavigate({})}
                />
              </EntityChromeContext.Provider>
            </div>
          ) : null}
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
        {gate && pageTab && ownerTab ? (
          <EntityChromeContext.Provider value={pageChrome}>
            <ActionStrip
              tab={pageTab}
              owner={{ tab: ownerTab, chrome: ownerChrome, linkUrl: designLinkUrl(spaceId, designId) }}
            />
          </EntityChromeContext.Provider>
        ) : gate && ownerTab ? (
          <EntityChromeContext.Provider value={pageChrome}>
            <ActionStrip tab={ownerTab} owner={{ tab: ownerTab, chrome: ownerChrome, linkUrl: designLinkUrl(spaceId, designId) }} />
          </EntityChromeContext.Provider>
        ) : (
          <div className="dsn-strip-lite" ref={setLiteSlot} data-testid="dsn-strip-lite" />
        )}
      </div>
    </section>
  );

  const screen = (
    <div className="crf-root dsn-root" data-testid="design-screen">
      <header className="crf-head dsn-head" data-testid="dsn-head">
        <button
          type="button"
          className="crf-head__chat"
          data-testid="crf-chat-toggle"
          aria-pressed={!chatHidden}
          aria-controls="crf-chat-pane"
          title={chatHidden ? 'Show the chat' : 'Hide the chat'}
          onClick={() => {
            if (expanded) runtime.dispatch({ command: 'workspace.layout.set', args: { expanded: false }, source: 'click' });
            else setChatCollapsed((was) => !was);
          }}
        >
          <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden>
            <rect x={1.5} y={2.5} width={13} height={11} rx={2} />
            <path d={chatHidden ? 'M6 2.5 V13.5' : 'M6 2.5 V13.5 M2 5 H5 M2 7.5 H5'} />
          </svg>
        </button>
        <button type="button" className="dsn-crumb" data-testid="dsn-back" onClick={() => onNavigate({})}>
          <span aria-hidden>‹</span> Designs
        </button>
        <span className="crf-head__sep" aria-hidden>·</span>
        <DesignSwitcher title={title} designs={designs} currentId={designId} onPick={(id) => onNavigate({ designId: id })} />
        <span className="crf-head__fill" />
      </header>
      <div className="crf-split" ref={splitRef} style={{ '--crf-chat': `${chatWidth}px` } as CSSProperties}>
        <section className="crf-chat" id="crf-chat-pane" aria-label="Design chat" hidden={chatHidden}>
          <DesignChatPane
            seam={seam}
            spaceId={spaceId}
            nodeKey={nodeKey}
            designId={designId}
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
        {chatHidden ? null : (
          <PanelResizer
            side="left"
            label="Design chat"
            controls="crf-chat-pane"
            width={chatWidth}
            minWidth={CHAT_MIN}
            maxWidth={chatMax}
            onResize={chatPref.setWidth}
            onReset={chatPref.reset}
          />
        )}
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

/** The route's page when it is still in the design, else the first page. */
function pickPage(pages: readonly DesignPageRow[], id: EntityId | undefined): DesignPageRow | null {
  return pages.find((page) => page.id === id) ?? pages[0] ?? null;
}

/** `[+ page]`: create and open; Artifact asks the agent, which is the one door artifacts have. */
function useNewPage(handle: DesignHandle, ask: (text: string) => void, open: (id: EntityId) => void) {
  return useCallback(
    (kind: NewPageKind) => {
      if (kind === 'artifact') {
        ask('Add an artifact page to this design: ');
        return;
      }
      void handle.createPage(kind).then((id) => id && open(id));
    },
    [handle, ask, open],
  );
}

interface PageBodyProps {
  page: DesignPageRow;
  /** 0 = a page of the opened design; 1 = a page of a nested design. */
  depth: 0 | 1;
  seam: Seam;
  source: DesignSource;
  gate: WorkspaceGateHandles | undefined;
  runtime: WorkspaceRuntime;
  /** The strip TOP's kind slot (or the lite strip without a Workspace host). */
  controlsSlot: HTMLElement | null;
  /** The strip TOP's Run slot — where a nested design's Run goes. */
  runSlot: HTMLElement | null;
  nestedPageId?: EntityId | undefined;
  onSelectNested(id: EntityId): void;
  onOpenDesign(id: EntityId): void;
  onAsk(text: string): void;
  onOpenEntity(id: EntityId): void;
  onToolNote(note: ToolNote | null): void;
  onNotice?: ((text: string) => void) | undefined;
}

/** One page's body, in its kind's full view. */
function PageBody(props: PageBodyProps) {
  const { page, depth, seam, gate, runtime } = props;
  if (page.kind === 'graph') {
    return (
      <GraphPage
        seam={seam}
        graphId={page.id}
        controlsSlot={props.controlsSlot}
        onAsk={props.onAsk}
        onOpenEntity={props.onOpenEntity}
        onToolNote={props.onToolNote}
      />
    );
  }
  if (page.kind === 'design') {
    return depth === 0 ? <NestedDesign {...props} /> : <DesignCards {...props} />;
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
  page: DesignPageRow;
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

/** Without a Workspace host (harness mounts): what the page is, and Open. */
function PlainPage({ page, onOpen }: { page: DesignPageRow; onOpen(): void }) {
  return (
    <div className="dsn-plain" data-testid="dsn-plain-page">
      <KindIcon kind={page.kind} size={24} />
      <h2 className="dsn-plain__title">{page.title}</h2>
      <p className="dsn-plain__line">{getKind(page.kind).label}</p>
      <button type="button" className="dsn-btn" onClick={onOpen}>Open</button>
    </div>
  );
}

/**
 * A DESIGN PAGE, IN PLACE (D7): its own smaller page row under the parent's,
 * and its active page below it. The parent row stays. Its Run sits in the
 * strip's TOP section — it is the active page — through its own panel, kept
 * mounted and hidden for exactly that portal.
 */
function NestedDesign(props: PageBodyProps) {
  const { page, source, gate, runtime, nestedPageId, onSelectNested, onNotice } = props;
  const handle = useDesign(source, page.id, nestedPageId ?? null, onNotice);
  const active = pickPage(handle.pages, nestedPageId);
  useEffect(() => {
    if (active) handle.seen(active.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, handle.seen, handle.updated]);
  const onNew = useNewPage(handle, props.onAsk, onSelectNested);
  const ownTab = useEmbeddedTab(runtime, gate ? page.id : null, gate ? 'design' : null);
  const runChrome = useMemo(() => runOnlyChrome(props.runSlot), [props.runSlot]);

  return (
    <div className="dsn-nested" data-testid="dsn-nested">
      {handle.state === 'ready' ? (
        <PageRow
          size="nested"
          pages={handle.pages}
          activeId={active?.id ?? null}
          updated={handle.updated}
          label={`Pages of ${handle.design?.title ?? 'the nested design'}`}
          ownerId={page.id}
          onSelect={onSelectNested}
          onMove={(id, index) => void handle.move(id, index)}
          onRemove={(id) => void handle.remove(id)}
          onNew={onNew}
          onAddExisting={(id) => void handle.addExisting(id).then((ok) => ok && onSelectNested(id))}
          candidates={(text) => source.candidates(text)}
        />
      ) : null}
      <div className="dsn-nested__body">
        {handle.state === 'loading' ? (
          <p className="crf-empty" role="status">Loading the design…</p>
        ) : handle.state !== 'ready' ? (
          <p className="crf-empty">This design could not be read.</p>
        ) : !active ? (
          <p className="crf-empty" data-testid="dsn-nested-empty">This design has no pages yet. Add one with ＋.</p>
        ) : (
          <PageBody {...props} key={active.id} page={active} depth={1} />
        )}
      </div>
      {gate && ownTab ? (
        <div hidden inert data-testid="dsn-nested-run-host">
          <EntityChromeContext.Provider value={runChrome}>
            <EntityTabBody tab={ownTab} adapter={getKindAdapter('design')} onClose={noop} />
          </EntityChromeContext.Provider>
        </div>
      ) : null}
    </div>
  );
}

/** THE DEPTH CAP (D7): a design two levels down is its page cards and "Open". */
function DesignCards({ page, source, onOpenDesign, onNotice }: PageBodyProps) {
  const handle = useDesign(source, page.id, null, onNotice);
  return (
    <div className="dsn-cards" data-testid="dsn-design-cards">
      <div className="dsn-cards__head">
        <KindIcon kind="design" size={16} />
        <h2 className="dsn-cards__title">{handle.design?.title ?? page.title}</h2>
        <button type="button" className="dsn-btn" data-testid="dsn-open-design" onClick={() => onOpenDesign(page.id)}>
          Open
        </button>
      </div>
      {handle.state === 'ready' && handle.pages.length === 0 ? (
        <p className="crf-empty">No pages yet.</p>
      ) : (
        <ul className="dsn-cards__grid">
          {handle.pages.map((card) => (
            <li key={card.id} className="dsn-card" data-testid="dsn-page-card">
              <KindIcon kind={card.kind} size={16} />
              <span className="dsn-card__title">{card.title}</span>
              <span className="dsn-card__kind">{getKind(card.kind).label}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The title and its ▾: switch to another design without going home. */
function DesignSwitcher({
  title,
  designs,
  currentId,
  onPick,
}: {
  title: string;
  designs: DesignsSource | undefined;
  currentId: EntityId;
  onPick(id: EntityId): void;
}) {
  const [open, setOpen] = useState(false);
  const [cards, setCards] = useState<readonly DesignCard[] | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open || !designs) return;
    let live = true;
    designs.list().then(
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
  }, [open, designs]);

  if (!designs) {
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
        title="Switch design"
        onClick={() => setOpen((was) => !was)}
      >
        <span className="crf-pick__title">{title}</span>
        <span className="crf-pick__caret" aria-hidden>
          ▾
        </span>
      </button>
      {open ? (
        <div className="crf-pop" role="menu" aria-label="Designs" data-testid="dsn-switch-pop">
          <div className="crf-pop__list">
            {cards === null ? (
              <p className="crf-pop__hollow" role="status">Loading designs…</p>
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
