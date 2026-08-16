/**
 * INDUCED GRAPH CANVAS — the one SVG that draws an `InducedPlacement`, shared
 * by the inline strip (`ChatEntityGraph`) and the fullscreen view. Extracted
 * verbatim from `ChatEntityGraph` (plan 01a0094b step 3): the host owns the
 * fold, the connection reads, the caption and the late title resolution; this
 * component only draws what it is handed.
 *
 * NO TOOL NAMES ANYWHERE (R8): edge labels are relation types, humanised
 * upstream. Cards speak the session-graph family's visual language (`sg-*`).
 */
import type { KeyboardEvent } from 'react';
import type { EntityId } from '@tm8/contract';
import { getKind } from '../domain';
import { HUB_DEGREE } from '../session-graph/model';
import type { ChatEntityRef } from './entity-refs';
import type { InducedNode } from './induced-graph';
import { CARD_H, CARD_W, type InducedPlacement, type PlacedLine } from './induced-layout';

export interface InducedGraphCanvasProps {
  placement: InducedPlacement;
  /** The host's whole-graph description for assistive tech. */
  ariaLabel: string;
  /** Late title resolutions (R7c) for ids no edge payload named. */
  late?: ReadonlyMap<string, ChatEntityRef> | undefined;
  onOpenEntity?: ((id: EntityId) => void) | undefined;
  /** Pan/zoom hosts override the viewBox; default shows the whole placement. */
  viewBox?: string | undefined;
}

export function InducedGraphCanvas({
  placement,
  ariaLabel,
  late,
  onOpenEntity,
  viewBox,
}: InducedGraphCanvasProps) {
  return (
    <svg
      className="sg-svg"
      viewBox={viewBox ?? `0 0 ${placement.width} ${placement.height}`}
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
