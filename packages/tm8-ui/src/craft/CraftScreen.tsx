/**
 * CRAFT — the blueprint studio (Craft P1, task 01a00a31; design doc
 * 01a00a17-2d18 v2.1, rulings R1-R3).
 *
 * SPLIT PANE: a craft-mode chat on the left, anchored to the selected `graph`
 * entity (contextual chat — `ChatRootInput.anchorId` — with the mode PINNED
 * to 'craft'); a canvas on the right rendering that entity's ROW directly.
 * The canvas dispatches on `graphType` (R3): 'entity' draws the card
 * blueprint, 'mermaid' renders the diagram source through the same Mermaid
 * component docs use, and an unknown type says so honestly.
 *
 * LIVE BY EVENTS: the agent's guarded patches to the row arrive as durable
 * `entity.upsert` events; the canvas re-reads the row on each one. No
 * polling, no transcript folding — the ROW is the one source of truth (R1).
 *
 * ORCHESTRATE: the affordance posts the APPROVAL into the selected craft
 * thread — nothing more (R2: materialization is the agent's, and it begins
 * only when approval lands in-thread). Zero new catalog ops anywhere here:
 * list = collections.query, create = entities.create, approve =
 * messages.post.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import type { EntityDetail, EntityId, EntitySummary, SpaceId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import type { ChatHomeL2Bridge } from '../chat-home/real-port';
import { ChatHomeSurface } from '../chat-home/ChatHomeSurface';
import type { ChatThreadSummary } from '../chat-home/types';
import type { TriggerOption } from '../rich-input';
import { Mermaid } from '../kit/Mermaid';
import { PanelResizer, useElementWidth, usePanelWidth } from '../kit';
import { screenKeyOf, useScreenStack } from '../stores/screenStackStore';
import { blueprintView, nodeRefId, type RefTitles } from './blueprint-model';
import { BlueprintCanvas } from './BlueprintCanvas';
import { CraftChatPicker } from './CraftChatPicker';
import { CraftEntityColumn } from './CraftEntityColumn';
import type { CraftPanelHostProps } from './types';
import '../session-graph/session-graph.css';
import '../chat-home/chat-entity-graph.css';
import './craft.css';

export interface CraftScreenProps {
  seam: Seam;
  spaceId: SpaceId;
  nodeKey: string;
  bridge?: ChatHomeL2Bridge;
  skillOptions?: readonly TriggerOption[];
  viewerName?: string;
  viewerId?: string;
  /**
   * The shell bundle region C is built from. Present ⇒ a chip press opens
   * the entity in Craft's OWN third column, and the studio survives the
   * press; absent ⇒ there is no column and chips fall back to `onOpenEntity`.
   */
  panelHost?: CraftPanelHostProps;
  /**
   * The shell's entity-open verb — the FALLBACK route, used only when no
   * `panelHost` is supplied. The shell's version leaves Craft entirely
   * (it navigates to the workspace and unmounts this screen, taking the
   * selected graph, thread and glow baseline with it), which is why an
   * in-screen column is the better answer wherever one can be built.
   */
  onOpenEntity?: (id: EntityId) => void;
  onNotice?: (text: string) => void;
}

let craftSeq = 0;
const cmid = (tag: string) => `craft:${tag}:${Date.now()}:${(craftSeq += 1)}`;

/** The chat pane's default and floor. The floor is the composer's: narrower
 *  than this and the mode chip, agent select and Send wrap onto three rows. */
const CHAT_DEFAULT = 520;
const CHAT_MIN = 360;
/** The canvas keeps at least this much, so dragging can never erase it. */
const CANVAS_MIN = 320;
/** Region C. Same numbers as every other reading column in the app. */
const DETAIL_DEFAULT = 440;
const DETAIL_MIN = 320;
/**
 * The separator track (8px) plus the aside's own 1px border — nothing in this
 * package sets `box-sizing: border-box` globally, so that border ADDS. Copied
 * from `ChannelView`'s `CHV_ASIDE_CHROME` for exactly the same reason.
 */
const PANE_CHROME = 8 + 1;

export function CraftScreen({
  seam,
  spaceId,
  nodeKey,
  bridge,
  skillOptions,
  viewerName,
  viewerId,
  panelHost,
  onOpenEntity,
  onNotice,
}: CraftScreenProps) {
  const [graphs, setGraphs] = useState<readonly EntitySummary[]>([]);
  const [selectedId, setSelectedId] = useState<EntityId | null>(null);
  const [detail, setDetail] = useState<EntityDetail | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [refTitles, setRefTitles] = useState<RefTitles>(new Map());
  /**
   * The craft thread the approval posts into.
   *
   * Fed by the chat surface's RESOLVED selection (`onSelectionChange`), not
   * by its navigation report — so the cold-start auto-open counts. It has to:
   * the pane header names the open conversation, and a header captioned
   * "New craft conversation" above a plainly-loaded thread would be a lie
   * the viewer can see. Orchestrate reads the same value and is enabled a
   * little sooner for it, which is correct — an auto-opened thread IS open.
   */
  const [activeThreadId, setActiveThreadId] = useState<EntityId | null>(null);
  /**
   * What the PICKER asked for, handed down as `routeThreadId`. `undefined`
   * means "nothing asked yet" — the chat screen keeps its cold-start
   * auto-open; `null` is the explicit ＋ (the new-conversation composer).
   *
   * IT TRACKS THE RESOLVED SELECTION, and it has to. `routeThreadId` is
   * compared BY VALUE, while the chat screen moves its own selection when a
   * send creates a thread — so a request left naming the value it asked for
   * last goes stale the moment those two diverge, and re-asking for it is
   * then a no-op React drops before the adoption effect can see it. That is
   * not hypothetical: ＋ after a send left the request on `null` while the
   * screen sat in the new thread, and the button stopped working for the
   * rest of the session. A request that mirrors what is actually open can
   * always be moved away from.
   */
  const [requestedThreadId, setRequestedThreadId] = useState<EntityId | null | undefined>(undefined);
  /** The conversation list, published up by the chat screen's ONE read. */
  const [threads, setThreads] = useState<readonly ChatThreadSummary[]>([]);
  const [approving, setApproving] = useState(false);
  /** Keys that arrived in the latest patch — the glow set (cleared on a timer). */
  const [fresh, setFresh] = useState<{ cards: ReadonlySet<string>; lines: ReadonlySet<string> } | null>(null);
  const prevKeysRef = useRef<{ id: EntityId; cards: Set<string>; lines: Set<string> } | null>(null);
  const freshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedRef = useRef<EntityId | null>(null);
  selectedRef.current = selectedId;

  const refreshList = useCallback(async () => {
    const result = await seam.query({ spaceId, kinds: ['graph'], sort: 'activityAt_desc', limit: 50 });
    setGraphs(result.page.items);
    /* A studio with nothing selected adopts the first graph that exists —
       the crafted-from-chat row appears without a manual pick. */
    const first = result.page.items[0]?.id as EntityId | undefined;
    if (first !== undefined && selectedRef.current === null) setSelectedId(first);
    return result.page.items;
  }, [seam, spaceId]);

  const readRow = useCallback(
    async (id: EntityId) => {
      try {
        const row = await seam.entity(id);
        /* Guard a stale settle: the read that matters is the selected row's. */
        if (selectedRef.current === id) {
          setDetail(row);
          setLoadState('ready');
        }
      } catch {
        if (selectedRef.current === id) setLoadState('error');
      }
    },
    [seam],
  );

  /* Hydrate: list, then select the most recent graph (if any). */
  useEffect(() => {
    let alive = true;
    setLoadState('loading');
    refreshList()
      .then((items) => {
        if (!alive) return;
        setSelectedId((current) => current ?? ((items[0]?.id as EntityId | undefined) ?? null));
        if (items.length === 0) setLoadState('ready');
      })
      .catch(() => alive && setLoadState('error'));
    return () => {
      alive = false;
    };
  }, [refreshList]);

  /* The selected row's read, and the switch reset. */
  useEffect(() => {
    setActiveThreadId(null);
    if (!selectedId) {
      setDetail(null);
      return;
    }
    setLoadState('loading');
    void readRow(selectedId);
  }, [selectedId, readRow]);

  /**
   * SWITCHING BLUEPRINTS SWITCHES CONVERSATIONS, because the two headers
   * claim to be one hierarchy: this graph, and the chats about it. Landing on
   * the space's most recent thread — which is what the chat screen's own
   * cold-start would do — could easily belong to a different blueprint, and
   * the header would then name a conversation the canvas has nothing to do
   * with. No craft thread on this graph yet ⇒ the composer, which is the
   * honest place to start one.
   *
   * IT WAITS FOR THE LIST. Resolving against an empty `threads` would answer
   * "no conversation here" before anything had been read, and the answer
   * would stick — so an unresolved graph re-tries on each publish. A space
   * with genuinely no threads never resolves and never needs to: the chat
   * screen has nothing to auto-open either, and both land on the composer.
   */
  const resolvedForRef = useRef<EntityId | null>(null);
  useEffect(() => {
    if (!selectedId || resolvedForRef.current === selectedId) return;
    if (threads.length === 0) return;
    resolvedForRef.current = selectedId;
    const scoped = threads.filter(
      (thread) => thread.config.mode === 'craft' && thread.anchorId === selectedId,
    );
    setRequestedThreadId(scoped[0]?.rootId ?? null);
  }, [selectedId, threads]);

  /**
   * THE RESOLVED SELECTION, ADOPTED — the header's subject and the request
   * move together.
   *
   * The chat screen is not only steered; it also STEERS ITSELF, and the send
   * that turns the composer into a real thread is the case that matters.
   * Recording that in `requestedThreadId` too is what keeps ＋ and the picker
   * able to move away from wherever the screen actually landed. Both writes
   * are no-ops when nothing changed, so this cannot cycle with the publish
   * effect that calls it.
   */
  const adoptSelection = useCallback((id: EntityId | null) => {
    setActiveThreadId(id);
    /* `undefined` is left alone. It means "nothing asked yet", and the mount
       publishes a null selection before anything has been read — collapsing
       that to an explicit `null` would forbid the chat's cold-start auto-open
       before the blueprint resolve above has had its say. */
    setRequestedThreadId((asked) => (asked === undefined ? asked : id));
  }, []);

  /* LIVE: a durable entity event for the selected row re-reads it; any graph
     upsert refreshes the picker (a rename, a new blueprint from chat). */
  useEffect(() => {
    return seam.onEvent((event) => {
      if (event.type !== 'entity.upsert' && event.type !== 'entity.deleted') return;
      if (event.entity.kind !== 'graph') return;
      void refreshList();
      if (event.entity.id === selectedRef.current) {
        if (event.type === 'entity.deleted') setSelectedId(null);
        else void readRow(event.entity.id as EntityId);
      }
    });
  }, [seam, refreshList, readRow]);

  /* Resolve reference-node titles the row names (bounded, cached by id). */
  const content = detail?.content;
  useEffect(() => {
    if (!content || (content as { kind?: string }).kind !== 'graph') return;
    /* Resolve through the SAME pin the canvas folds with (`nodeRefId`): a spec's
       row-local key is not an entity id, and fetching it was what printed
       "unavailable entity" on every spec card. */
    const nodes = (content as { nodes?: Parameters<typeof nodeRefId>[0][] }).nodes ?? [];
    const wanted = [...new Set(nodes.map((node) => nodeRefId(node)).filter((id): id is EntityId => id !== null))]
      .filter((id) => !refTitles.has(id))
      .slice(0, 24);
    if (wanted.length === 0) return;
    let alive = true;
    void Promise.allSettled(wanted.map((id) => seam.entity(id as EntityId))).then((settled) => {
      if (!alive) return;
      setRefTitles((current) => {
        const next = new Map(current);
        settled.forEach((result, index) => {
          const id = wanted[index];
          if (!id) return;
          if (result.status === 'fulfilled') {
            next.set(id, { kind: result.value.kind, title: result.value.title });
          } else {
            /* Honestly marked: the row references something this read cannot see. */
            next.set(id, { kind: 'entity', title: 'unavailable entity' });
          }
        });
        return next;
      });
    });
    return () => {
      alive = false;
    };
  }, [content, refTitles, seam]);

  const createGraph = useCallback(async () => {
    try {
      const result = await seam.commands.createEntity({
        clientMutationId: cmid('new'),
        spaceId,
        kind: 'graph',
        title: 'Untitled graph',
        content: { graphType: 'entity' },
      });
      await refreshList();
      const id = result.entity?.id as EntityId | undefined;
      if (id) setSelectedId(id);
    } catch (error) {
      onNotice?.(error instanceof Error ? error.message : 'Could not create the graph.');
    }
  }, [seam, spaceId, refreshList, onNotice]);

  const approveOrchestrate = useCallback(async () => {
    if (!selectedId || !activeThreadId || approving) return;
    setApproving(true);
    try {
      /* The whole affordance (design §4): approval lands IN the thread; the
         craft agent materializes from there via existing delegation. */
      await seam.commands.postMessage({
        clientMutationId: cmid('approve'),
        anchorIds: [selectedId],
        parentMessageId: activeThreadId,
        body: 'Approved — orchestrate this blueprint.',
      });
      onNotice?.('Approval posted into the craft thread.');
    } catch (error) {
      onNotice?.(error instanceof Error ? error.message : 'Could not post the approval.');
    } finally {
      setApproving(false);
    }
  }, [selectedId, activeThreadId, approving, seam, onNotice]);

  const view = useMemo(
    () => (content && (content as { kind?: string }).kind === 'graph' ? blueprintView(content, refTitles) : null),
    [content, refTitles],
  );

  /**
   * THE WIDTH SOLVER. `usePanelWidth` holds what the viewer ASKED FOR,
   * unclamped, so narrowing the window once cannot overwrite the preference
   * (see its docblock); this screen clamps for PAINT, because it is the one
   * holding the measurement. `maxWidth` is measured rather than assumed — the
   * shell's own rail is variable, so the space available here is not a
   * function of the window.
   */
  const splitRef = useRef<HTMLDivElement | null>(null);
  const splitWidth = useElementWidth(splitRef);
  const { width: askedWidth, setWidth: setChatWidth, reset: resetChatWidth } = usePanelWidth(
    'craft.chat',
    CHAT_DEFAULT,
    CHAT_MIN,
  );
  const detailPref = usePanelWidth('craft.detail', DETAIL_DEFAULT, DETAIL_MIN);

  /**
   * REGION C — the entity a chip opened.
   *
   * In the screen stack, NOT in `useState`: the rail unmounts Craft whenever
   * the viewer looks at another screen, and a local cell would drop the open
   * entity on the way out and back. Keyed by the view, which is what
   * `screenKeyOf.view` exists for.
   */
  const screen = useScreenStack(screenKeyOf.view('craft'));
  const canHostPanel = panelHost !== undefined;
  const detailId = canHostPanel ? screen.selected : null;

  /* Region C's room comes out of the split BEFORE the chat's ceiling is
     computed, or a wide chat plus an open panel would leave the canvas below
     its floor — the three-region arithmetic EntityView spells out. */
  const detailMax = splitWidth > 0
    ? Math.max(DETAIL_MIN, splitWidth - CHAT_MIN - CANVAS_MIN - PANE_CHROME * 2)
    : Number.POSITIVE_INFINITY;
  const detailWidth = Math.min(Math.max(DETAIL_MIN, detailPref.width), detailMax);
  const detailRoom = detailId ? detailWidth + PANE_CHROME : 0;
  /* Before the first measurement there is no honest ceiling, so the asked-for
     width paints as-is rather than being clamped against a zero. */
  const chatMax = splitWidth > 0
    ? Math.max(CHAT_MIN, splitWidth - CANVAS_MIN - PANE_CHROME - detailRoom)
    : Number.POSITIVE_INFINITY;
  const chatWidth = Math.min(Math.max(CHAT_MIN, askedWidth), chatMax);

  /**
   * A CHIP PRESS LANDS IN REGION C when the shell gave us one to land in, and
   * leaves the screen only when it did not. The blueprint cards and every
   * chat chip converge on this one verb.
   */
  const openEntity = useCallback(
    (id: EntityId) => {
      if (canHostPanel) screen.open(id);
      else onOpenEntity?.(id);
    },
    [canHostPanel, screen, onOpenEntity],
  );

  /* ESC CLOSES THE COLUMN — one rung, and only ours. `defaultPrevented`
     keeps a dialog or the conversation popover ahead of us in the queue. */
  useEffect(() => {
    if (!detailId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      screen.pop();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [detailId, screen]);

  /* LIVE CONSTRUCTION READS AS MOTION: diff consecutive folds of the SAME
     row and glow what the latest patch added. The drawn set never changes
     here — attention is CSS only — and switching graphs resets the baseline
     so a freshly opened blueprint does not arrive glowing wholesale. */
  useEffect(() => {
    if (!view || !selectedId) return;
    const cards = new Set(view.cards.map((card) => card.key));
    const lines = new Set(view.lines.map((line) => line.key));
    const prev = prevKeysRef.current;
    prevKeysRef.current = { id: selectedId, cards, lines };
    if (!prev || prev.id !== selectedId) return;
    const freshCards = new Set([...cards].filter((key) => !prev.cards.has(key)));
    const freshLines = new Set([...lines].filter((key) => !prev.lines.has(key)));
    if (freshCards.size === 0 && freshLines.size === 0) return;
    setFresh({ cards: freshCards, lines: freshLines });
    if (freshTimerRef.current) clearTimeout(freshTimerRef.current);
    freshTimerRef.current = setTimeout(() => setFresh(null), 2600);
  }, [view, selectedId]);

  useEffect(() => () => {
    if (freshTimerRef.current) clearTimeout(freshTimerRef.current);
  }, []);

  return (
    <div className="crf-root" data-testid="craft-screen">
      <header className="crf-bar">
        <span className="crf-bar__title">Craft</span>
        <span className="crf-bar__spacer" />
        <button
          type="button"
          className="crf-bar__orchestrate"
          data-testid="crf-orchestrate"
          disabled={!selectedId || !activeThreadId || approving}
          title={
            !selectedId
              ? 'Select a graph first.'
              : !activeThreadId
                ? 'Open or start a craft thread first — the approval posts into it.'
                : 'Post the approval into the craft thread; the agent orchestrates from there.'
          }
          onClick={() => void approveOrchestrate()}
        >
          Orchestrate ▸
        </button>
      </header>
      <div className="crf-split" ref={splitRef} style={{ '--crf-chat': `${chatWidth}px`, '--crf-detail': `${detailWidth}px` } as CSSProperties}>
        <section className="crf-chat" id="crf-chat-pane" aria-label="Craft conversation">
          <CraftChatPicker
            threads={threads}
            anchorId={selectedId}
            selectedId={activeThreadId}
            onSelect={(id) => setRequestedThreadId(id)}
            onNewChat={() => setRequestedThreadId(null)}
          />
          <div className="crf-chat__body">
            <ChatHomeSurface
              seam={seam}
              spaceId={spaceId}
              nodeKey={nodeKey}
              bridge={bridge}
              /* Contextual chat: new threads anchor to the BLUEPRINT row, so the
                 conversation and the object it crafts share one address. Falls
                 back to bare Home's anchor only when no graph exists yet. */
              {...(selectedId ? { anchorId: selectedId } : {})}
              pinnedMode="craft"
              skillOptions={skillOptions}
              onOpenEntity={openEntity}
              /* TWO PANES: the thread column is this screen's, drawn as the
                 picker above. `routeThreadId` is authoritative in solo mode. */
              soloConversation
              routeThreadId={requestedThreadId}
              onThreadsChange={setThreads}
              onSelectionChange={adoptSelection}
              viewerName={viewerName}
              viewerId={viewerId}
            />
          </div>
        </section>
        {/* The floor is the CANVAS's, measured — see `chatMax`. A handle that
            could drag the blueprint to nothing would be the zero-floored
            track the layout law forbids. */}
        <PanelResizer
          side="left"
          label="Craft conversation"
          controls="crf-chat-pane"
          width={chatWidth}
          minWidth={CHAT_MIN}
          maxWidth={chatMax}
          onResize={setChatWidth}
          onReset={resetChatWidth}
        />
        <section className="crf-canvas" aria-label="Blueprint canvas" data-testid="crf-canvas-pane">
          <div className="crf-pane-head">
            <label className="crf-pick crf-pick--graph">
              <span className="crf-pick__caret" aria-hidden>
                ▾
              </span>
              <select
                data-testid="crf-picker"
                aria-label="Blueprint"
                value={selectedId ?? ''}
                onChange={(event) => setSelectedId((event.target.value || null) as EntityId | null)}
              >
                {graphs.length === 0 ? <option value="">No graphs yet</option> : null}
                {graphs.map((graph) => (
                  <option key={graph.id} value={graph.id}>
                    {graph.title}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="crf-pane-head__plus"
              data-testid="crf-new"
              aria-label="New graph"
              title="Create a new blueprint"
              onClick={() => void createGraph()}
            >
              <span aria-hidden>＋</span>
            </button>
          </div>
          <div className="crf-canvas__body">
          {loadState === 'error' ? (
            <p className="crf-empty">This graph could not be read. Pick another, or retry from the picker.</p>
          ) : !selectedId ? (
            <p className="crf-empty" data-testid="crf-no-graph">
              No graph selected. Create one with “+ New graph”, or ask the craft chat to start a blueprint.
            </p>
          ) : !view ? (
            <p className="crf-empty" role="status">Loading the blueprint…</p>
          ) : view.graphType === 'mermaid' ? (
            view.source ? (
              <div className="crf-mermaid" data-testid="crf-mermaid">
                <Mermaid source={view.source} testId="crf-mermaid-svg" />
              </div>
            ) : (
              <p className="crf-empty">A mermaid graph with no source yet — ask the chat to sketch one.</p>
            )
          ) : view.graphType === 'entity' ? (
            <>
              <BlueprintCanvas
                view={view}
                ariaLabel={`Blueprint ${detail?.title ?? ''}: ${view.cards.length} nodes, ${view.lines.length} edges`}
                onOpenEntity={openEntity}
                fresh={fresh ?? undefined}
              />
              {view.danglingEdgeCount > 0 ? (
                <p className="crf-note" data-testid="crf-dangling">
                  {`${view.danglingEdgeCount} edge${view.danglingEdgeCount === 1 ? '' : 's'} name keys no node carries — not drawn.`}
                </p>
              ) : null}
            </>
          ) : (
            <p className="crf-empty" data-testid="crf-unknown-type">
              {`Graph type “${view.graphType}” has no renderer in this build — the row is intact; a future type renders here.`}
            </p>
          )}
          </div>
        </section>
        {/*
          REGION C — the entity a chip opened, in the app's shared detail
          mount. Rendered ONLY while something is open: an aside kept at
          `display:none` would still mount that entity's panel — its chat
          surface, its terminal, its polling — behind an invisible region,
          which is the rule `EntityView` states and obeys.

          `side="right"`, because the column this handle controls sits to its
          right; the chat's handle is `side="left"` for the mirror reason.
        */}
        {detailId && panelHost ? (
          <>
            <PanelResizer
              side="right"
              label="Entity details"
              controls="crf-detail-pane"
              width={detailWidth}
              minWidth={DETAIL_MIN}
              maxWidth={detailMax}
              onResize={detailPref.setWidth}
              onReset={detailPref.reset}
            />
            <aside className="crf-detail" id="crf-detail-pane" aria-label="Entity details" data-testid="crf-detail">
              <CraftEntityColumn
                {...panelHost}
                entityId={detailId}
                /* Drilling REPLACES this column's subject — never a fourth. */
                onOpenEntity={(id) => screen.open(id)}
                onClose={() => screen.clear()}
              />
            </aside>
          </>
        ) : null}
      </div>
    </div>
  );
}
