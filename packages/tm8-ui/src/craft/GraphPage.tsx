/**
 * A GRAPH PAGE — the blueprint canvas, moved out of the old Craft studio into
 * a design page body (Craft → Designs, change list item 10). Its internals
 * are unchanged: the canvas dispatches on `graphType` (R3), a node selected
 * in any view is selected everywhere and opens its INSPECTOR, each agent
 * patch is DIFFED against the previous fold of the same row and the strip
 * over the canvas says what changed.
 *
 * LIVE BY EVENTS: the agent's guarded patches arrive as durable
 * `entity.upsert` events and the page re-reads the row on each one (R1).
 *
 * THE VIEW SWITCHER AND THE FINDINGS CHIP are this page's controls, so they
 * portal into the action strip's TOP section (`controlsSlot`); the design's
 * shared verbs sit in its BOTTOM.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { blueprintNodeRef, type EntityDetail, type EntityId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { Mermaid } from '../kit/Mermaid';
import { useElementWidth } from '../kit';
import { blueprintView, nodeRefId } from './blueprint-model';
import type { BlueprintView, RefInfo, RefTitles } from './blueprint-types';
import { BlueprintCanvas } from './BlueprintCanvas';
import { BlueprintOutline } from './BlueprintOutline';
import { BlueprintTable } from './BlueprintTable';
import { NodeInspector } from './NodeInspector';
import { FindingsChip, ViewSwitcher } from './GraphControls';
import { diffBlueprintViews, isEmptyDiff, summarizeDiff, type BlueprintDiff } from './blueprint-diff';
import { availableViews, resolveView, type CraftViewId } from './presentation';
import { nodeByKey, titleOf } from './canvas-nav';
import { BlueprintTurnNote, graphWriteOf, type ToolNoteCall } from './turn-notes';

export type ToolNote = (call: ToolNoteCall) => ReactNode;

/** Below this page width the inspector overlays the canvas instead of taking width from it. */
const OVERLAY_BELOW = 760;

export interface GraphPageProps {
  seam: Seam;
  graphId: EntityId;
  /** The strip's TOP section; the view switcher and the findings chip render here. */
  controlsSlot: HTMLElement | null;
  /** "Ask about this": seed the design's composer. */
  onAsk(text: string): void;
  onOpenEntity(id: EntityId): void;
  /** Publishes the transcript note for calls that wrote THIS graph (null on unmount). */
  onToolNote?: ((note: ToolNote | null) => void) | undefined;
}

export function GraphPage({ seam, graphId, controlsSlot, onAsk, onOpenEntity, onToolNote }: GraphPageProps) {
  const [detail, setDetail] = useState<EntityDetail | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [refTitles, setRefTitles] = useState<RefTitles>(new Map());
  const [lastDiff, setLastDiff] = useState<BlueprintDiff | null>(null);
  /* Every patch diff seen live, by the row version it produced — what lets a
     turn in the transcript name the nodes ITS patch changed. */
  const [diffByVersion, setDiffByVersion] = useState<ReadonlyMap<number, BlueprintDiff>>(new Map());
  const prevViewRef = useRef<{ version: number; view: BlueprintView } | null>(null);
  const [pickedNode, setNodeKey] = useState<string | null>(null);
  const [viewChoice, setViewChoice] = useState<CraftViewId>('flow');

  const readRow = useCallback(async () => {
    try {
      setDetail(await seam.entity(graphId));
      setLoadState('ready');
    } catch {
      setLoadState('error');
    }
  }, [seam, graphId]);

  useEffect(() => {
    setLoadState('loading');
    void readRow();
  }, [readRow]);

  useEffect(
    () =>
      seam.onEvent((event) => {
        if (event.type === 'entity.upsert' && event.entity.id === graphId) void readRow();
      }),
    [seam, graphId, readRow],
  );

  /* Resolve reference-node titles the row names (bounded, cached by id),
     through the SAME pin the canvas folds with (`nodeRefId`). */
  const content = detail?.content;
  useEffect(() => {
    if (!content || (content as { kind?: string }).kind !== 'graph') return;
    const nodes = (content as { nodes?: Parameters<typeof nodeRefId>[0][] }).nodes ?? [];
    const wanted = [...new Set(nodes.map((node) => nodeRefId(node)).filter((id): id is EntityId => id !== null))]
      .filter((id) => !refTitles.has(id))
      .slice(0, 24);
    if (wanted.length === 0) return;
    let alive = true;
    void Promise.allSettled(wanted.map((id) => seam.entity(id))).then((settled) => {
      if (!alive) return;
      setRefTitles((current) => {
        const next = new Map(current);
        settled.forEach((result, index) => {
          const id = wanted[index];
          if (!id) return;
          next.set(id, result.status === 'fulfilled' ? refInfoOf(result.value) : { kind: 'entity', title: 'unavailable entity' });
        });
        return next;
      });
    });
    return () => {
      alive = false;
    };
  }, [content, refTitles, seam]);

  /* The live map: a durable upsert for an entity the blueprint references
     re-reads just that one, so the card's stripe and pulse follow it. */
  const refIdsRef = useRef(refTitles);
  refIdsRef.current = refTitles;
  useEffect(
    () =>
      seam.onEvent((event) => {
        if (event.type !== 'entity.upsert') return;
        const id = event.entity.id as EntityId;
        if (!refIdsRef.current.has(id)) return;
        void seam.entity(id).then(
          (entity) => setRefTitles((current) => new Map(current).set(id, refInfoOf(entity))),
          () => undefined,
        );
      }),
    [seam],
  );

  /* Lanes is the only view that changes the LAYOUT; Outline and Table read
     `lists`, which are layout-independent, from the flow fold. */
  const view = useMemo(
    () =>
      content && (content as { kind?: string }).kind === 'graph'
        ? blueprintView(content, refTitles, { mode: viewChoice === 'lanes' ? 'swimlane' : 'flow' })
        : null,
    [content, refTitles, viewChoice],
  );
  const viewId: CraftViewId = view ? resolveView(viewChoice, view) : 'flow';
  const selectedNode = view && pickedNode && nodeByKey(view, pickedNode) ? pickedNode : null;

  /* What the patch changed, keyed on the ROW VERSION: resolving a
     reference's title re-folds the view too, and that is not the agent. */
  const rowVersion = detail?.version ?? null;
  useEffect(() => {
    if (!view || rowVersion === null) return;
    const prev = prevViewRef.current;
    if (prev && prev.version === rowVersion) {
      prevViewRef.current = { ...prev, view };
      return;
    }
    prevViewRef.current = { version: rowVersion, view };
    if (!prev) return;
    const diff = diffBlueprintViews(prev.view, view);
    if (!isEmptyDiff(diff)) {
      setLastDiff(diff);
      setDiffByVersion((current) => new Map(current).set(rowVersion, diff));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowVersion, view]);

  /* Escape closes the inspector — only ours, and only if nothing inner took it. */
  useEffect(() => {
    if (!selectedNode) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      setNodeKey(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [selectedNode]);

  const askAbout = useCallback(
    (key: string) => {
      if (view) onAsk(blueprintNodeRef(graphId, key, titleOf(view, key)));
    },
    [view, graphId, onAsk],
  );

  /* The transcript side of chat ↔ canvas: a call that wrote THIS graph gets a
     line naming what it changed, each node a button onto the canvas. */
  const toolNote = useCallback<ToolNote>(
    (call) => {
      const write = graphWriteOf(call, graphId);
      if (!write) return null;
      const diff = write.version !== null ? diffByVersion.get(write.version) ?? null : null;
      return <BlueprintTurnNote write={write} diff={diff} view={view} onSelect={setNodeKey} />;
    },
    [graphId, diffByVersion, view],
  );
  useEffect(() => {
    onToolNote?.(toolNote);
  }, [onToolNote, toolNote]);
  useEffect(() => () => onToolNote?.(null), [onToolNote]);

  const isEntityGraph = view?.graphType === 'entity';
  const viewOptions = view && isEntityGraph && view.cards.length > 0 ? availableViews(view) : [];
  const findings = isEntityGraph && view ? view.findings : [];
  const marked = lastDiff ? { cards: lastDiff.marked, lines: lastDiff.markedLines } : undefined;
  const describedBy = `crf-canvas-help-${graphId}`;
  const pageRef = useRef<HTMLElement | null>(null);
  const pageWidth = useElementWidth(pageRef);
  const overlay = pageWidth > 0 && pageWidth < OVERLAY_BELOW;

  const controls = controlsSlot
    ? createPortal(
        <div className="dsn-graph-controls" data-testid="dsn-graph-controls">
          <ViewSwitcher options={viewOptions} value={viewId} onChange={setViewChoice} orientation="vertical" />
          <FindingsChip
            findings={findings}
            onClick={() => {
              const first = findings.find((finding) => finding.nodes.length > 0);
              if (first) setNodeKey(first.nodes[0]!);
            }}
          />
        </div>,
        controlsSlot,
      )
    : null;

  return (
    <section className="crf-canvas dsn-graph" aria-label="Blueprint" data-testid="crf-canvas-pane" ref={pageRef}>
      {controls}
      {lastDiff && isEntityGraph ? (
        <DiffStrip diff={lastDiff} view={view!} onSelect={setNodeKey} onDismiss={() => setLastDiff(null)} />
      ) : null}
      <div className="dsn-graph__row">
      <div className="crf-canvas__body">
        {loadState === 'error' ? (
          <p className="crf-empty">This graph could not be read.</p>
        ) : !view ? (
          <p className="crf-empty" role="status">Loading the graph…</p>
        ) : view.graphType === 'mermaid' ? (
          view.source ? (
            <div className="crf-mermaid" data-testid="crf-mermaid">
              <Mermaid source={view.source} testId="crf-mermaid-svg" />
            </div>
          ) : (
            <p className="crf-empty">A mermaid graph with no source yet — ask the chat to sketch one.</p>
          )
        ) : view.graphType === 'entity' ? (
          view.cards.length === 0 ? (
            <p className="crf-empty" data-testid="crf-empty">
              An empty graph. Ask the chat to draft it: the tasks, who owns them, and what they need and make.
            </p>
          ) : (
            <>
              <p id={describedBy} className="crf-sr">
                Arrow keys move between nodes, Enter inspects the selected node, f finds, 0 fits the whole plan,
                and full stop focuses a node&apos;s neighbourhood. The Outline and Table views list the same blueprint as text.
              </p>
              {viewId === 'outline' ? (
                <div className="crf-scroll">
                  <BlueprintOutline view={view} selectedKey={selectedNode} onSelect={setNodeKey} marked={lastDiff?.marked} />
                </div>
              ) : viewId === 'table' ? (
                <div className="crf-scroll">
                  <BlueprintTable view={view} selectedKey={selectedNode} onSelect={setNodeKey} marked={lastDiff?.marked} />
                </div>
              ) : (
                <BlueprintCanvas
                  /* A new layout gets a fresh camera. */
                  key={viewId}
                  view={view}
                  ariaLabel={`Blueprint ${detail?.title ?? ''}: ${view.cards.length} nodes, ${view.lines.length} edges`}
                  describedBy={describedBy}
                  selectedKey={selectedNode}
                  onSelect={setNodeKey}
                  marked={marked}
                />
              )}
            </>
          )
        ) : (
          <p className="crf-empty" data-testid="crf-unknown-type">
            {`Graph type “${view.graphType}” has no renderer in this build — the row is intact; a future type renders here.`}
          </p>
        )}
      </div>
        {/* The inspector DOCKS beside the canvas, so it never covers the canvas's
            own controls; a narrow page overlays the canvas's right edge. */}
        {view && selectedNode ? (
          <aside className="crf-detail" data-overlay={overlay || undefined} aria-label="Node inspector" data-testid="crf-detail">
            <NodeInspector
              view={view}
              selectedKey={selectedNode}
              onSelect={setNodeKey}
              onOpenEntity={(id) => onOpenEntity(id as EntityId)}
              onAsk={askAbout}
              onClose={() => setNodeKey(null)}
            />
          </aside>
        ) : null}
      </div>
    </section>
  );
}

/** The live overlay a reference node carries: its status, and whether a session is on it now. */
function refInfoOf(entity: EntityDetail): RefInfo {
  const state = entity.state as { kind?: string; status?: string } | undefined;
  return {
    kind: entity.kind,
    title: entity.title,
    status: state && typeof state.status === 'string' ? state.status : null,
    live: (entity.badges?.workingActors?.length ?? 0) > 0,
  };
}

/**
 * THE DIFF STRIP — what the latest agent patch changed, over the canvas. The
 * entries are buttons that select the node (and so open the inspector).
 */
function DiffStrip({
  diff,
  view,
  onSelect,
  onDismiss,
}: {
  diff: BlueprintDiff;
  view: BlueprintView;
  onSelect(key: string): void;
  onDismiss(): void;
}) {
  const entries = [
    ...diff.added.map((key) => ({ key, verb: 'added' })),
    ...diff.changed.map((key) => ({ key, verb: 'changed' })),
  ].slice(0, 6);
  const more = diff.added.length + diff.changed.length - entries.length;
  return (
    <div className="crf-diff" role="status" data-testid="crf-diff">
      <span className="crf-diff__lead">Blueprint updated</span>
      <span className="crf-diff__sum" data-testid="crf-diff-summary">{summarizeDiff(diff)}</span>
      <span className="crf-diff__items">
        {entries.map(({ key, verb }) => (
          <button type="button" key={key} className="crf-diff__item" data-verb={verb} onClick={() => onSelect(key)}>
            {titleOf(view, key)}
          </button>
        ))}
        {more > 0 ? <span className="crf-diff__more">{`+${more} more`}</span> : null}
        {diff.removed.slice(0, 3).map((node) => (
          <span key={node.key} className="crf-diff__item crf-diff__item--gone" title="Removed">{node.title}</span>
        ))}
      </span>
      <button type="button" className="crf-diff__close" aria-label="Dismiss the change summary" onClick={onDismiss}>
        ×
      </button>
    </div>
  );
}
