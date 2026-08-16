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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { EntityDetail, EntityId, EntitySummary, SpaceId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import type { ChatHomeL2Bridge } from '../chat-home/real-port';
import { ChatHomeSurface } from '../chat-home/ChatHomeSurface';
import type { TriggerOption } from '../rich-input';
import { Mermaid } from '../kit/Mermaid';
import { blueprintView, type RefTitles } from './blueprint-model';
import { BlueprintCanvas } from './BlueprintCanvas';
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
  /** The shell's entity-open verb — reference cards and chips route through it. */
  onOpenEntity?: (id: EntityId) => void;
  onNotice?: (text: string) => void;
}

let craftSeq = 0;
const cmid = (tag: string) => `craft:${tag}:${Date.now()}:${(craftSeq += 1)}`;

export function CraftScreen({
  seam,
  spaceId,
  nodeKey,
  bridge,
  skillOptions,
  viewerName,
  viewerId,
  onOpenEntity,
  onNotice,
}: CraftScreenProps) {
  const [graphs, setGraphs] = useState<readonly EntitySummary[]>([]);
  const [selectedId, setSelectedId] = useState<EntityId | null>(null);
  const [detail, setDetail] = useState<EntityDetail | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [refTitles, setRefTitles] = useState<RefTitles>(new Map());
  /** The craft thread the approval posts into — tracked via the chat's own selection. */
  const [activeThreadId, setActiveThreadId] = useState<EntityId | null>(null);
  const [approving, setApproving] = useState(false);
  const selectedRef = useRef<EntityId | null>(null);
  selectedRef.current = selectedId;

  const refreshList = useCallback(async () => {
    const result = await seam.query({ spaceId, kinds: ['graph'], sort: 'activityAt_desc', limit: 50 });
    setGraphs(result.page.items);
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
    const nodes = (content as { nodes?: { id?: string }[] }).nodes ?? [];
    const wanted = [...new Set(nodes.map((node) => node.id).filter((id): id is string => typeof id === 'string'))]
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

  return (
    <div className="crf-root" data-testid="craft-screen">
      <header className="crf-bar">
        <span className="crf-bar__title">Craft</span>
        <label className="crf-bar__pick">
          <span className="crf-bar__label">Graph</span>
          <select
            data-testid="crf-picker"
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
        <button type="button" className="crf-bar__new" data-testid="crf-new" onClick={() => void createGraph()}>
          + New graph
        </button>
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
      <div className="crf-split">
        <section className="crf-chat" aria-label="Craft conversation">
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
            onOpenEntity={onOpenEntity}
            onThreadSelected={setActiveThreadId}
            viewerName={viewerName}
            viewerId={viewerId}
          />
        </section>
        <section className="crf-canvas" aria-label="Blueprint canvas" data-testid="crf-canvas-pane">
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
                onOpenEntity={onOpenEntity}
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
        </section>
      </div>
    </div>
  );
}
