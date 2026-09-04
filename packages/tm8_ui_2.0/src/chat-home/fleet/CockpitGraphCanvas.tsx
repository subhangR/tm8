/**
 * THE GRAPH TAB'S DRAWING — cards and the relations between them.
 *
 * PORTED, NOT MOVED (coordinator ruling: the induced-graph canvas dies with
 * the rest of the old graph; port concepts only). What came across is the part
 * that is about the GRAPH: a card carries its kind mark, its title and the one
 * fact that matters about its edges, and a line carries the pair's whole
 * relation set with each relation keeping its own direction (R4).
 *
 * WHAT DID NOT COME ACROSS, because it existed for a UI that no longer does:
 * the search-match dimming, the selected-node 1-hop neighbourhood, the hover
 * line-raising and the `onSelect`/`viewBox`/`matches`/`selectedId` props that
 * drove them. Every one of those served the retired fullscreen dialog's facet
 * rail and detail pane. Carrying them forward would have meant shipping four
 * props nothing sets and three visual states nothing reaches — dead machinery
 * that reads as intentional and that the next person has to disprove.
 *
 * THE HONESTY RULES SURVIVE INTACT, since they are the graph:
 *  · "edges not read" is a card's own state and is NOT the same as isolated.
 *    An unread card says so on its face.
 *  · A hub declares its degree, with `+` when one page did not hold them all,
 *    so a floor never reads as a total.
 *  · A card is a button only where pressing it can DO something — a host with
 *    no open verb gets a plain card, never a dead control.
 */
import type { KeyboardEvent } from 'react';
import type { EntityId } from '@tm8/contract';
import { getKind } from '../../domain';
import { HUB_DEGREE } from '../../session-graph/model';
import type { ChatEntityRef } from '../entity-refs';
import type { InducedNode } from '../induced-graph';
import { CARD_H, CARD_W, type InducedPlacement, type PlacedLine } from '../induced-layout';

export function CockpitGraphCanvas({
  placement,
  ariaLabel,
  late,
  onOpenEntity,
}: {
  placement: InducedPlacement;
  /** The host's whole-graph description for assistive tech. */
  ariaLabel: string;
  /** Late title resolutions for ids no edge payload named. */
  late?: ReadonlyMap<string, ChatEntityRef> | undefined;
  onOpenEntity?: ((id: EntityId) => void) | undefined;
}) {
  return (
    <svg
      className="sg-svg"
      viewBox={`0 0 ${placement.width} ${placement.height}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={ariaLabel}
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
          late={late?.get(card.node.id)}
          onOpen={onOpenEntity}
        />
      ))}
    </svg>
  );
}

/** One merged line: the pair's whole relation set, each relation keeping its
 *  own direction. Labels are humanised relation types — never tool names. */
function RelationLine({ line }: { line: PlacedLine }) {
  return (
    <g className="cgs-line">
      <path
        className="sg-link"
        d={`M ${line.x1} ${line.y1} Q ${line.cx} ${line.cy} ${line.x2} ${line.y2}`}
      />
      <text className="sg-meta cgs-line__labels" x={line.lx} y={line.ly} textAnchor="middle">
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
      className={`sg-cell cgs-cell${node.mutated ? ' cgs-cell--mutated' : ''}`}
      transform={`translate(${x} ${y})`}
      aria-label={`${config.label}: ${title} — ${status}`}
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
      {/* Mutually exclusive by construction: an unread card cannot have been
          observed to be edited, and the read one says which it was. */}
      {node.mutated ? (
        <text className="sg-meta cgs-cell__flag" x={33} y={CARD_H - 14}>
          edited here
        </text>
      ) : !node.edgesRead ? (
        <text className="sg-meta cgs-cell__flag" x={33} y={CARD_H - 14}>
          edges not read
        </text>
      ) : null}
      {hub ? (
        <text className="sg-count" x={CARD_W - 10} y={15} textAnchor="end">
          {/* `+` says the number is a FLOOR: one page did not hold them all. */}
          {`${node.degree}${node.pageCapped ? '+' : ''} links`}
        </text>
      ) : null}
    </g>
  );
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
