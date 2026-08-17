/**
 * CHAT ENTITY GRAPH — the entities this conversation read or edited, and the
 * relations those entities ACTUALLY HAVE in the tm8 graph. Nothing else is in
 * the picture.
 *
 * THE CONVERSATION IS THE SELECTOR, NOT A NODE (R1): it decides what is on
 * screen and never appears on screen. No hub, no centre, no anchor card —
 * this replaces the hub-and-spoke `LiveGraphStrip` in Chat Home, whose star
 * was not a claim about structure but the only drawing its data structure
 * could produce.
 *
 * NO TOOL NAMES ANYWHERE (R8): edge labels are relation types, humanised.
 * The word "touch" is retired (R13) — it meant "mutated" on one surface and
 * "mentioned" on the other.
 *
 * This is the INLINE HOST: it folds the thread, reads connections for the
 * DRAWN seeds only (the reads are the real cost of a bigger canvas, plan
 * 01a0094b D3), resolves late titles, and hands the drawing to the shared
 * `InducedGraphCanvas` the fullscreen view reuses.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { EntityId } from '@tm8/contract';
import type { ConnectionsReader } from '../session-graph/load';
import '../session-graph/session-graph.css';
import './chat-entity-graph.css';
import { resolveChatEntity, type ChatEntityResolver } from './EntityChip';
import type { ChatEntityRef } from './entity-refs';
import { ChatEntityGraphFullscreen, MAX_DRAWN_FULL } from './ChatEntityGraphFullscreen';
import { foldGraphSeeds } from './graph-seeds';
import { buildInducedGraph } from './induced-graph';
import {
  anyGraphFilterActive,
  applyGraphFilters,
  decodeGraphFilters,
  encodeGraphFilters,
} from './graph-view';
import { InducedGraphCanvas } from './InducedGraphCanvas';
import { layoutInducedGraph } from './induced-layout';
import type { ChatTurn } from './types';
import { useInducedConnections } from './use-induced-connections';

export interface ChatEntityGraphProps {
  turns: readonly ChatTurn[];
  /** This thread's own message ids — already the transcript, never nodes. */
  suppressEntityIds?: ReadonlySet<string> | undefined;
  /** The host's `entities.connections` reader. Absent ⇒ every card says its
   *  edges were not read (R11) — never a fabricated line. */
  connections?: ConnectionsReader | undefined;
  /** Shared lazy title resolution (R7c) for ids no edge payload named. */
  resolveEntity?: ChatEntityResolver | undefined;
  onOpenEntity?: ((id: EntityId) => void) | undefined;
  /**
   * FULLSCREEN IS A URL (plan 01a0094b D2): the host maps `?graph=full` here
   * and `onExpandedChange` navigates the param on/off — this component never
   * owns the open state, so Back closes and a reload restores. Hosts without
   * routing simply omit the pair and get the inline strip unchanged.
   */
  expanded?: boolean | undefined;
  onExpandedChange?: ((open: boolean) => void) | undefined;
  /**
   * `?gf=` — the graph's serialised filter state (step 5), carried by the
   * host the same route-owned way `expanded` is. This component decodes it
   * (leniently — graph-view.ts owns the vocabulary), applies it to the
   * inline canvas, and hands the fullscreen rail's edits back encoded.
   * Filters chosen fullscreen keep shaping the inline strip after Back.
   */
  graphFilters?: string | null | undefined;
  onGraphFiltersChange?: ((encoded: string | null) => void) | undefined;
}

export function ChatEntityGraph({
  turns,
  suppressEntityIds,
  connections,
  resolveEntity,
  onOpenEntity,
  expanded,
  onExpandedChange,
  graphFilters,
  onGraphFiltersChange,
}: ChatEntityGraphProps) {
  const [open, setOpen] = useState(true);
  const fold = useMemo(
    () => foldGraphSeeds(turns, suppressEntityIds),
    [turns, suppressEntityIds],
  );
  const { drawn, overflow } = fold;

  /* STEP 7 (D3): fullscreen draws up to MAX_DRAWN_FULL, and the reads — the
     real cost — widen only once the viewer has actually opened it. Sticky by
     design: the per-id read cache lives for this mount, so closing the
     dialog keeps everything already read instead of forgetting it. */
  const [everExpanded, setEverExpanded] = useState(expanded === true);
  useEffect(() => {
    if (expanded) setEverExpanded(true);
  }, [expanded]);
  const fullFold = useMemo(
    () =>
      everExpanded
        ? foldGraphSeeds(turns, suppressEntityIds, { limit: MAX_DRAWN_FULL })
        : null,
    [everExpanded, turns, suppressEntityIds],
  );

  const seedIds = useMemo(
    () => (fullFold?.drawn ?? drawn).map((seed) => seed.id),
    [fullFold, drawn],
  );
  const read = useInducedConnections(seedIds, connections);
  /* Inline stays the 64-seed drawing (D3: no regression); the wider read map
     is harmless here — the build only looks up its own seeds. */
  const graph = useMemo(() => buildInducedGraph(drawn, read), [drawn, read]);
  const fullGraph = useMemo(
    () => (fullFold ? buildInducedGraph(fullFold.drawn, read) : null),
    [fullFold, read],
  );

  /* Step 5 — the URL's filters shape the inline drawing too, and the strip
     echoes the loss read-only: the honesty rule says a hidden card always
     leaves a visible count behind. */
  const filters = useMemo(() => decodeGraphFilters(graphFilters), [graphFilters]);
  const filtersActive = anyGraphFilterActive(filters);
  const filtered = useMemo(
    () => (filtersActive ? applyGraphFilters(graph, filters) : null),
    [filtersActive, graph, filters],
  );
  const shown = filtered?.graph ?? graph;

  /* R7c — the resolver is the LAST resort: only ids that neither an edge
     payload nor the extraction titled, through the same cache the chips use.
     The WIDER drawing's nodes resolve too once fullscreen has opened. */
  const [late, setLate] = useState<ReadonlyMap<string, ChatEntityRef>>(new Map());
  const unresolvedKey = (fullGraph ?? graph).nodes
    .filter((node) => !node.resolvedTitle && !late.has(node.id))
    .map((node) => node.id)
    .join(',');
  useEffect(() => {
    if (!resolveEntity || unresolvedKey === '') return;
    let alive = true;
    for (const id of unresolvedKey.split(',')) {
      resolveChatEntity(id, resolveEntity).then(
        (ref) => {
          if (!alive) return;
          setLate((prev) => new Map(prev).set(id, ref));
        },
        () => {
          /* Failure keeps the truncated id — the card stays honest. */
        },
      );
    }
    return () => {
      alive = false;
    };
  }, [resolveEntity, unresolvedKey]);

  const placement = useMemo(() => layoutInducedGraph(shown), [shown]);

  /* Focus returns to Expand when the fullscreen dialog closes (step 4). */
  const expandRef = useRef<HTMLButtonElement | null>(null);
  const wasExpanded = useRef(false);
  useEffect(() => {
    if (wasExpanded.current && !expanded) expandRef.current?.focus();
    wasExpanded.current = expanded === true;
  }, [expanded]);

  /* R12 — degenerate cases. Zero seeds: nothing at all, not even a header. */
  if (drawn.length === 0) return null;

  const n = graph.nodes.length;
  const single = n === 1;
  const allIsolated = !single && graph.edges.length === 0 && graph.unreadCount === 0;
  const caption = captionOf(graph, overflow);
  /* The dialog states ITS OWN drawing's numbers — at the wider cap the
     inline split's "+N more not drawn" would be a lie about this canvas. */
  const fullCaption = fullGraph && fullFold ? captionOf(fullGraph, fullFold.overflow) : caption;

  return (
    <div className="ceg" data-testid="chat-entity-graph">
      <div className="ceg__head">
        <button
          type="button"
          className="ceg__toggle"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          title="Entities this conversation referenced, and the relations they hold in the graph"
        >
          {`${open ? '▾' : '▸'} Entity graph`}
          <span className="ceg__count">{caption}</span>
        </button>
        {onExpandedChange ? (
          <button
            type="button"
            className="ceg__expand"
            ref={expandRef}
            title="Open the graph fullscreen"
            onClick={() => onExpandedChange(true)}
          >
            ⛶ Expand
          </button>
        ) : null}
      </div>
      {expanded && onExpandedChange ? (
        <ChatEntityGraphFullscreen
          graph={fullGraph ?? graph}
          fold={fullFold ?? fold}
          caption={fullCaption}
          filters={filters}
          onFiltersChange={(next) => onGraphFiltersChange?.(encodeGraphFilters(next))}
          late={late}
          onOpenEntity={onOpenEntity}
          onClose={() => onExpandedChange(false)}
        />
      ) : null}
      {open ? (
        <div className="ceg__canvas">
          {filtered ? (
            <p className="ceg__note" data-testid="ceg-filter-echo">
              {[
                `Filtered: showing ${filtered.graph.nodes.length} of ${graph.nodes.length}`,
                ...(filtered.hiddenNodes > 0 ? [`${filtered.hiddenNodes} hidden`] : []),
                ...(filtered.hiddenEdges > 0 ? [`${filtered.hiddenEdges} relations hidden`] : []),
              ].join(' · ')}
            </p>
          ) : null}
          {allIsolated ? (
            <p className="ceg__note">These entities hold no relations to each other.</p>
          ) : null}
          <InducedGraphCanvas
            placement={placement}
            ariaLabel={
              single
                ? 'Entity graph: 1 entity'
                : `Entity graph: ${n} entities, ${graph.relationCount} relations`
            }
            late={late}
            onOpenEntity={onOpenEntity}
          />
        </div>
      ) : null}
    </div>
  );
}

/** The strip's honest arithmetic: entities, relations, unread, undrawn. */
function captionOf(
  graph: { nodes: readonly unknown[]; relationCount: number; unreadCount: number },
  overflow: number,
): string {
  const n = graph.nodes.length;
  const single = n === 1;
  return [
    `${n} ${single ? 'entity' : 'entities'}`,
    ...(single
      ? []
      : [`${graph.relationCount} ${graph.relationCount === 1 ? 'relation' : 'relations'}`]),
    ...(graph.unreadCount > 0 ? [`${graph.unreadCount} not read`] : []),
    ...(overflow > 0 ? [`+${overflow} more not drawn`] : []),
  ].join(' · ');
}
