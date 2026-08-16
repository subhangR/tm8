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
import { ChatEntityGraphFullscreen } from './ChatEntityGraphFullscreen';
import { foldGraphSeeds } from './graph-seeds';
import { buildInducedGraph } from './induced-graph';
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
}

export function ChatEntityGraph({
  turns,
  suppressEntityIds,
  connections,
  resolveEntity,
  onOpenEntity,
  expanded,
  onExpandedChange,
}: ChatEntityGraphProps) {
  const [open, setOpen] = useState(true);
  const { drawn, overflow } = useMemo(
    () => foldGraphSeeds(turns, suppressEntityIds),
    [turns, suppressEntityIds],
  );
  const seedIds = useMemo(() => drawn.map((seed) => seed.id), [drawn]);
  const read = useInducedConnections(seedIds, connections);
  const graph = useMemo(() => buildInducedGraph(drawn, read), [drawn, read]);

  /* R7c — the resolver is the LAST resort: only ids that neither an edge
     payload nor the extraction titled, through the same cache the chips use. */
  const [late, setLate] = useState<ReadonlyMap<string, ChatEntityRef>>(new Map());
  const unresolvedKey = graph.nodes
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

  const placement = useMemo(() => layoutInducedGraph(graph), [graph]);

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
  const caption = [
    `${n} ${n === 1 ? 'entity' : 'entities'}`,
    ...(single ? [] : [`${graph.relationCount} ${graph.relationCount === 1 ? 'relation' : 'relations'}`]),
    ...(graph.unreadCount > 0 ? [`${graph.unreadCount} not read`] : []),
    ...(overflow > 0 ? [`+${overflow} more not drawn`] : []),
  ].join(' · ');

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
          graph={graph}
          caption={caption}
          late={late}
          onOpenEntity={onOpenEntity}
          onClose={() => onExpandedChange(false)}
        />
      ) : null}
      {open ? (
        <div className="ceg__canvas">
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
