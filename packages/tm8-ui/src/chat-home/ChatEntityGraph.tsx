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
 * Visual language is the session-graph family's (`sg-*` classes, registry
 * icon art), so the fourth chip's graph and this one read as relatives.
 */
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import type { EntityId } from '@tm8/contract';
import { getKind } from '../domain';
import { HUB_DEGREE } from '../session-graph/model';
import type { ConnectionsReader } from '../session-graph/load';
import '../session-graph/session-graph.css';
import './chat-entity-graph.css';
import { resolveChatEntity, type ChatEntityResolver } from './EntityChip';
import type { ChatEntityRef } from './entity-refs';
import { foldGraphSeeds } from './graph-seeds';
import { buildInducedGraph, type InducedNode } from './induced-graph';
import { CARD_H, CARD_W, layoutInducedGraph, type PlacedLine } from './induced-layout';
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
}

export function ChatEntityGraph({
  turns,
  suppressEntityIds,
  connections,
  resolveEntity,
  onOpenEntity,
}: ChatEntityGraphProps) {
  const [open, setOpen] = useState(true);
  const { seeds, overflow } = useMemo(
    () => foldGraphSeeds(turns, suppressEntityIds),
    [turns, suppressEntityIds],
  );
  const seedIds = useMemo(() => seeds.map((seed) => seed.id), [seeds]);
  const read = useInducedConnections(seedIds, connections);
  const graph = useMemo(() => buildInducedGraph(seeds, read), [seeds, read]);

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

  /* R12 — degenerate cases. Zero seeds: nothing at all, not even a header. */
  if (seeds.length === 0) return null;

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
      {open ? (
        <div className="ceg__canvas">
          {allIsolated ? (
            <p className="ceg__note">These entities hold no relations to each other.</p>
          ) : null}
          <svg
            className="sg-svg"
            viewBox={`0 0 ${placement.width} ${placement.height}`}
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label={
              single
                ? 'Entity graph: 1 entity'
                : `Entity graph: ${n} entities, ${graph.relationCount} relations`
            }
          >
            {placement.lines.map((line) => (
              <RelationLine key={line.edge.key} line={line} />
            ))}
            {placement.cards.map((card) => (
              <EntityCard
                key={card.node.id}
                node={card.node}
                x={card.x}
                y={card.y}
                late={late.get(card.node.id)}
                onOpen={onOpenEntity}
              />
            ))}
          </svg>
        </div>
      ) : null}
    </div>
  );
}

/** One merged line (R4): the pair's whole relation set, each relation keeping
 *  its own direction. Labels are humanised relation types — never tool names. */
function RelationLine({ line }: { line: PlacedLine }) {
  return (
    <g className="ceg-line">
      <path className="sg-link" d={`M ${line.x1} ${line.y1} Q ${line.cx} ${line.cy} ${line.x2} ${line.y2}`} />
      <text className="sg-meta ceg-line__labels" x={line.lx} y={line.ly} textAnchor="middle">
        {line.edge.relations.map((relation, index) => (
          <tspan key={`${relation.type}:${relation.from}`} x={line.lx} dy={index === 0 ? 0 : 12}>
            {relation.from === line.edge.a ? `${relation.label} ⟶` : `⟵ ${relation.label}`}
          </tspan>
        ))}
      </text>
    </g>
  );
}

function EntityCard({
  node,
  x,
  y,
  late,
  onOpen,
}: {
  node: InducedNode;
  x: number;
  y: number;
  late: ChatEntityRef | undefined;
  onOpen?: ((id: EntityId) => void) | undefined;
}) {
  const kind = node.resolvedTitle ? node.kind : (late?.kind ?? node.kind);
  const title = node.resolvedTitle ? node.title : (late?.title ?? node.title);
  const config = getKind(kind);
  const hub = node.degree !== null && node.degree > HUB_DEGREE;
  const status = !node.edgesRead
    ? 'edges not read'
    : node.mutated
      ? 'edited in this conversation'
      : 'read';
  const label = `${config.label}: ${title} — ${status}`;
  /* A card is a BUTTON only where the host can open the entity — the same
     conditional-pressable rule the chips and the live-graph nodes hold. */
  const pressable = onOpen
    ? {
        role: 'button',
        tabIndex: 0,
        onClick: () => onOpen(node.id as EntityId),
        onKeyDown: (event: KeyboardEvent<SVGGElement>) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onOpen(node.id as EntityId);
          }
        },
      }
    : {};
  return (
    <g
      className={`sg-cell ceg-cell${node.mutated ? ' ceg-cell--mutated' : ''}`}
      transform={`translate(${x} ${y})`}
      aria-label={label}
      {...pressable}
    >
      <rect
        className="sg-box"
        width={CARD_W}
        height={CARD_H}
        rx={8}
        data-unread={node.edgesRead ? undefined : 'true'}
        data-hub={hub ? 'true' : undefined}
      />
      <g className="sg-icon" transform={`translate(11 ${CARD_H / 2 - 8})`}>
        {config.iconArt.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
      <text className="sg-title" x={33} y={17}>
        {truncate(title, 17)}
      </text>
      <text className="sg-meta" x={33} y={30}>
        {config.label}
      </text>
      {node.mutated ? (
        <text className="sg-meta ceg-cell__flag" x={33} y={CARD_H - 14}>
          edited here
        </text>
      ) : null}
      {!node.edgesRead ? (
        <text className="sg-meta ceg-cell__flag" x={33} y={CARD_H - 14}>
          edges not read
        </text>
      ) : null}
      {hub ? (
        <text className="sg-count" x={CARD_W - 10} y={15} textAnchor="end">
          {`${node.degree}${node.pageCapped ? '+' : ''} links`}
        </text>
      ) : null}
    </g>
  );
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
