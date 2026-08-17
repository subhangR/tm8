/**
 * BLUEPRINT CANVAS — draws a `graph` entity's ROW (graphType 'entity'),
 * speaking the session-graph family's visual language (`sg-*` cards,
 * relation-labelled bowed lines — the ChatEntityGraph idiom).
 *
 * PRESCRIPTIVE, NOT DESCRIPTIVE: this is what SHOULD run, not a picture of
 * what is (the induced-edge honesty law governs those; this object has its
 * own law — see the design doc §2). The one honesty rule here is the
 * spec/reference distinction: a SPEC card (no entity behind it) is drawn
 * dashed with a "spec" flag so intent never passes as fact, and a reference
 * card opens its real entity.
 */
import type { KeyboardEvent } from 'react';
import type { EntityId } from '@tm8/contract';
import { getKind } from '../domain';
import { CARD_H, CARD_W } from '../chat-home/induced-layout';
import type { BlueprintCard, BlueprintLine, BlueprintView } from './blueprint-model';

export interface BlueprintCanvasProps {
  view: BlueprintView;
  ariaLabel: string;
  onOpenEntity?: ((id: EntityId) => void) | undefined;
  /**
   * Keys that arrived in the LATEST patch (the host diffs consecutive folds).
   * Drawn with a brief glow so live construction reads as motion — attention
   * is CSS, never a different drawn set (the induced-graph law, kept).
   */
  fresh?: { cards: ReadonlySet<string>; lines: ReadonlySet<string> } | undefined;
}

export function BlueprintCanvas({ view, ariaLabel, onOpenEntity, fresh }: BlueprintCanvasProps) {
  if (view.cards.length === 0) {
    return (
      <p className="crf-empty" data-testid="crf-empty">
        An empty blueprint. Ask the craft chat to sketch nodes and edges, and they render here live.
      </p>
    );
  }
  return (
    <svg
      className="sg-svg crf-svg"
      viewBox={`0 0 ${view.width} ${view.height}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={ariaLabel}
      data-testid="crf-canvas"
    >
      {view.lines.map((line) => (
        <IntentLine key={line.key} line={line} fresh={fresh?.lines.has(line.key) ?? false} />
      ))}
      {view.cards.map((card) => (
        <BlueprintNodeCard
          key={card.key}
          card={card}
          onOpen={onOpenEntity}
          fresh={fresh?.cards.has(card.key) ?? false}
        />
      ))}
    </svg>
  );
}

/** One edge of intent: the humanised relation riding the bow's apex. */
function IntentLine({ line, fresh }: { line: BlueprintLine; fresh: boolean }) {
  return (
    <g className={['ceg-line', ...(fresh ? ['crf-line--fresh'] : [])].join(' ')}>
      <path className="sg-link" d={`M ${line.x1} ${line.y1} Q ${line.cx} ${line.cy} ${line.x2} ${line.y2}`} />
      <text className="sg-meta ceg-line__labels" x={line.lx} y={line.ly} textAnchor="middle">
        {`${line.label} ⟶`}
        {line.note ? <tspan x={line.lx} dy={12}>{truncate(line.note, 24)}</tspan> : null}
      </text>
    </g>
  );
}

function BlueprintNodeCard({
  card,
  onOpen,
  fresh,
}: {
  card: BlueprintCard;
  onOpen?: ((id: EntityId) => void) | undefined;
  fresh: boolean;
}) {
  const config = getKind(card.kind);
  const status = card.isSpec ? 'spec — not materialized yet' : 'references a real entity';
  /* A card is a BUTTON only where pressing it can do something: a reference
     opens its entity; a spec has nothing to open — same conditional-pressable
     rule as the induced graph's cards. */
  const pressable = !card.isSpec && card.refId && onOpen
    ? {
        role: 'button',
        tabIndex: 0,
        onClick: () => onOpen(card.refId as EntityId),
        onKeyDown: (event: KeyboardEvent<SVGGElement>) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onOpen(card.refId as EntityId);
          }
        },
      }
    : {};
  return (
    <g
      className={[
        'sg-cell',
        'crf-cell',
        ...(card.isSpec ? ['crf-cell--spec'] : []),
        ...(fresh ? ['crf-cell--fresh'] : []),
      ].join(' ')}
      transform={`translate(${card.x} ${card.y})`}
      aria-label={`${config.label}: ${card.title} — ${status}`}
      {...pressable}
    >
      <rect className="sg-box" width={CARD_W} height={CARD_H} rx={8} />
      <g className="sg-icon" transform={`translate(11 ${CARD_H / 2 - 8})`}>
        {config.iconArt.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
      <text className="sg-title" x={33} y={17}>
        {truncate(card.title, 17)}
      </text>
      <text className="sg-meta" x={33} y={30}>
        {config.label}
      </text>
      <text className="sg-meta crf-cell__flag" x={33} y={CARD_H - 14}>
        {card.isSpec ? (card.hint ? truncate(card.hint, 20) : 'spec') : 'ref'}
      </text>
    </g>
  );
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
