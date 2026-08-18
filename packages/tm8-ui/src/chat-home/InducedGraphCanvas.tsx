/**
 * INDUCED GRAPH CANVAS — the one SVG that draws an `InducedPlacement`, shared
 * by the Cockpit's Graph stage and by Craft's blueprint canvas. The host
 * owns the fold, the connection reads, the caption, filters and the late
 * title resolution; this component only draws what it is handed.
 *
 * ATTENTION IS CSS, NEVER REMOVAL (plan 01a0094b steps 5–6): search dims
 * non-matches, selection dims everything outside the selected card's 1-hop
 * neighbourhood, hover raises incident lines. The drawn SET only changes
 * upstream, in `applyGraphFilters`, where the change carries a count.
 *
 * SELECTION vs OPEN: a host that passes `onSelect` (fullscreen) gets
 * click-to-select — opening moves to the detail panel's explicit button. A
 * host without it (inline) keeps click-to-open. Same conditional-pressable
 * rule as the chips either way.
 *
 * NO TOOL NAMES ANYWHERE (R8): edge labels are relation types, humanised
 * upstream. Cards speak the session-graph family's visual language (`sg-*`).
 */
import { useMemo, useState, type KeyboardEvent } from 'react';
import type { EntityId } from '@tm8/contract';
import { getKind } from '../domain';
import { HUB_DEGREE } from '../session-graph/model';
import type { ChatEntityRef } from './entity-refs';
import type { InducedNode } from './induced-graph';
import { CARD_H, CARD_W, type InducedPlacement, type PlacedLine } from './induced-layout';
/* THE CANVAS OWNS ITS OWN STYLES NOW. The retired inline strip used to import
   this on the canvas's behalf, which meant the drawing's appearance depended
   on which host happened to mount it. */
import './chat-entity-graph.css';

export interface InducedGraphCanvasProps {
  placement: InducedPlacement;
  /** The host's whole-graph description for assistive tech. */
  ariaLabel: string;
  /** Late title resolutions (R7c) for ids no edge payload named. */
  late?: ReadonlyMap<string, ChatEntityRef> | undefined;
  onOpenEntity?: ((id: EntityId) => void) | undefined;
  /** Pan/zoom hosts override the viewBox; default shows the whole placement. */
  viewBox?: string | undefined;
  /**
   * Search highlight set. `undefined` ⇒ no search active (nothing dims);
   * an EMPTY set is an active search matching nothing — everything dims.
   */
  matches?: ReadonlySet<string> | undefined;
  /** Selection (step 6). Non-null dims everything outside its 1-hop hood. */
  selectedId?: string | null | undefined;
  /** Present ⇒ clicking a card SELECTS it (fullscreen); absent ⇒ click opens. */
  onSelect?: ((id: string) => void) | undefined;
}

export function InducedGraphCanvas({
  placement,
  ariaLabel,
  late,
  onOpenEntity,
  viewBox,
  matches,
  selectedId,
  onSelect,
}: InducedGraphCanvasProps) {
  /** Transient hover — raises incident lines (step 6), never persisted. */
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  /* The selected card's 1-hop neighbourhood, from the drawn lines. */
  const hood = useMemo(() => {
    if (!selectedId) return null;
    const ids = new Set<string>([selectedId]);
    for (const line of placement.lines) {
      if (line.edge.a === selectedId) ids.add(line.edge.b);
      else if (line.edge.b === selectedId) ids.add(line.edge.a);
    }
    return ids;
  }, [selectedId, placement.lines]);

  const dimmed = (id: string): boolean =>
    (matches !== undefined && !matches.has(id)) || (hood !== null && !hood.has(id));
  const lineTouches = (line: PlacedLine, id: string | null): boolean =>
    id !== null && (line.edge.a === id || line.edge.b === id);

  return (
    <svg
      className="sg-svg"
      viewBox={viewBox ?? `0 0 ${placement.width} ${placement.height}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={ariaLabel}
    >
      {placement.lines.map((line) => (
        <RelationLine
          key={line.edge.key}
          line={line}
          hovered={lineTouches(line, hoveredId)}
          focused={lineTouches(line, selectedId ?? null)}
          dimmed={selectedId != null && !lineTouches(line, selectedId)}
        />
      ))}
      {placement.cards.map((card) => (
        <EntityCard
          key={card.node.id}
          node={card.node}
          x={card.x}
          y={card.y}
          late={late?.get(card.node.id)}
          onOpen={onOpenEntity}
          onSelect={onSelect}
          selected={selectedId === card.node.id}
          dimmed={dimmed(card.node.id)}
          onHover={setHoveredId}
        />
      ))}
    </svg>
  );
}

/** One merged line (R4): the pair's whole relation set, each relation keeping
 *  its own direction. Labels are humanised relation types — never tool names. */
function RelationLine({
  line,
  hovered,
  focused,
  dimmed,
}: {
  line: PlacedLine;
  hovered: boolean;
  focused: boolean;
  dimmed: boolean;
}) {
  const cls = [
    'ceg-line',
    ...(hovered ? ['ceg-line--hover'] : []),
    ...(focused ? ['ceg-line--focus'] : []),
    ...(dimmed && !hovered ? ['ceg-line--dim'] : []),
  ].join(' ');
  return (
    <g className={cls}>
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
  onSelect,
  selected,
  dimmed,
  onHover,
}: {
  node: InducedNode;
  x: number;
  y: number;
  late: ChatEntityRef | undefined;
  onOpen?: ((id: EntityId) => void) | undefined;
  onSelect?: ((id: string) => void) | undefined;
  selected: boolean;
  dimmed: boolean;
  onHover: (id: string | null) => void;
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
  /* A card is a BUTTON only where pressing it can do something — select
     where the host tracks selection, else open where the host can open. */
  const press = onSelect ?? onOpen;
  const pressable = press
    ? {
        role: 'button',
        tabIndex: 0,
        ...(onSelect ? { 'aria-pressed': selected } : {}),
        onClick: () => press(node.id as EntityId),
        onKeyDown: (event: KeyboardEvent<SVGGElement>) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            press(node.id as EntityId);
          }
        },
      }
    : {};
  const cls = [
    'sg-cell',
    'ceg-cell',
    ...(node.mutated ? ['ceg-cell--mutated'] : []),
    ...(selected ? ['ceg-cell--selected'] : []),
    ...(dimmed && !selected ? ['ceg-cell--dim'] : []),
  ].join(' ');
  return (
    <g
      className={cls}
      transform={`translate(${x} ${y})`}
      aria-label={label}
      onMouseEnter={() => onHover(node.id)}
      onMouseLeave={() => onHover(null)}
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
