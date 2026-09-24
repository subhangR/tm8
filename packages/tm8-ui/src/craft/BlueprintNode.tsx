/**
 * BLUEPRINT NODE — one card, drawn in its KIND's shape.
 *
 * The old canvas drew every node as the same box, so a teammate, a task and a
 * doc were told apart only by a 10px word. Here the silhouette carries the
 * kind before any text is read:
 *
 *   task      a card with a status stripe and its assignees DOCKED on the
 *             bottom edge (assignment is attachment, not a long line)
 *   doc       a page with a folded corner
 *   artifact  a framed card with a preview band
 *   memory    a pill
 *   skill     a hexagonal badge
 *   other     a plain rounded box (an unknown kind still draws)
 *
 * Existence is the second channel and never depends on colour: a SPEC (does
 * not exist yet) is dashed with a SPEC tag; a MATERIALIZED node (was a spec,
 * now built) is solid with a "built" tag; a plain reference is solid.
 *
 * Geometry is the view model's (`card.width/height`) — the layout sized the
 * card, this only fills it.
 */
import type { KeyboardEvent, MouseEvent } from 'react';
import type { BlueprintAssignee, BlueprintCard } from './blueprint-types';
import { getKind } from '../domain';
import { humanStatus, initials, statusTone, truncate, wrapText } from './presentation';

export type NodeEmphasis = 'none' | 'selected' | 'neighbour' | 'dim' | 'hidden';

export interface BlueprintNodeProps {
  card: BlueprintCard;
  emphasis: NodeEmphasis;
  /** Changed by the latest agent patch — kept marked until the next one. */
  marked: boolean;
  /** A find match (the current one is also `selected`). */
  matched: boolean;
  /** Roving tabindex: only the selected card (or the first) is in the tab order. */
  tabbable: boolean;
  onPress?: ((key: string) => void) | undefined;
  onActivate?: ((key: string) => void) | undefined;
  onPressAssignee?: ((key: string) => void) | undefined;
}

const AVATAR_R = 10;
const MAX_AVATARS = 3;

export function BlueprintNode({
  card,
  emphasis,
  marked,
  matched,
  tabbable,
  onPress,
  onActivate,
  onPressAssignee,
}: BlueprintNodeProps) {
  const { width: w, height: h } = card;
  const config = getKind(card.kind);
  const tone = statusTone(card.status, card.live);
  const existence = card.isSpec ? 'spec' : card.materialized ? 'built' : 'ref';
  const compact = h < 46;
  const state = card.isSpec
    ? 'spec — not created yet'
    : card.materialized ? 'built from spec' : 'existing entity';
  const statusWords = card.live ? 'running' : humanStatus(card.status);
  const label = [
    `${card.kindLabel}: ${card.title}`,
    state,
    statusWords,
    card.assignees.length ? `assigned to ${card.assignees.map((a) => a.title).join(', ')}` : '',
    card.severity ? `${card.findings.length} ${card.findings.length === 1 ? 'issue' : 'issues'}` : '',
  ].filter(Boolean).join(' — ');

  const press = onPress
    ? {
        role: 'button',
        tabIndex: tabbable ? 0 : -1,
        'aria-pressed': emphasis === 'selected',
        onClick: (event: MouseEvent<SVGGElement>) => {
          event.stopPropagation();
          onPress(card.key);
        },
        onDoubleClick: (event: MouseEvent<SVGGElement>) => {
          event.stopPropagation();
          onActivate?.(card.key);
        },
        onKeyDown: (event: KeyboardEvent<SVGGElement>) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.stopPropagation();
            if (emphasis === 'selected') onActivate?.(card.key);
            else onPress(card.key);
          }
        },
      }
    : {};

  /* Text metrics: 12.5px semibold ≈ 6.6px a character; the title keeps a
     14px left inset (past the stripe) and a 12px right one. */
  const titleChars = Math.max(6, Math.floor((w - (compact ? 38 : 28)) / 6.6));
  /* Two title lines whenever the card has the height (≥ 58: kind row, two
     lines, a margin) — a title is the one thing on a card worth wrapping for.
     The hint takes the second line only when the title did not need it. */
  const titleLines = compact ? [truncate(card.title, titleChars)] : wrapText(card.title, titleChars, h >= 58 ? 2 : 1);
  const hintRoom = !compact && titleLines.length === 1 && h >= 58;

  return (
    <g
      className={[
        'crf-node',
        `crf-node--${shapeOf(card.kind)}`,
        `crf-node--${existence}`,
        ...(marked ? ['crf-node--marked'] : []),
        ...(matched ? ['crf-node--matched'] : []),
        ...(card.live ? ['crf-node--live'] : []),
      ].join(' ')}
      data-key={card.key}
      data-emphasis={emphasis === 'none' ? undefined : emphasis}
      data-tone={tone}
      data-testid="crf-node"
      transform={`translate(${card.x} ${card.y})`}
      aria-label={label}
      {...press}
    >
      <title>{label}</title>
      {/* Halo: selection / diff mark / live pulse ride OUTSIDE the silhouette. */}
      <rect className="crf-node__halo" x={-5} y={-5} width={w + 10} height={h + 10} rx={shapeOf(card.kind) === 'memory' ? (h + 10) / 2 : 12} />
      <Silhouette kind={shapeOf(card.kind)} w={w} h={h} />
      {shapeOf(card.kind) === 'task' ? (
        <rect className="crf-node__stripe" x={0} y={0} width={4} height={h} rx={2} />
      ) : null}

      {compact ? (
        <>
          <g className="crf-node__icon" transform={`translate(${shapeOf(card.kind) === 'skill' ? h / 2 - 2 : 12} ${h / 2 - 6}) scale(0.75)`}>
            {config.iconArt.map((d) => <path key={d} d={d} />)}
          </g>
          <text className="crf-node__title" x={shapeOf(card.kind) === 'skill' ? h / 2 + 14 : 30} y={h / 2} dominantBaseline="central">
            {titleLines[0]}
          </text>
        </>
      ) : (
        <>
          <g className="crf-node__icon" transform={`translate(14 10) scale(0.7)`}>
            {config.iconArt.map((d) => <path key={d} d={d} />)}
          </g>
          <text className="crf-node__kind" x={29} y={18}>
            {card.kindLabel.toUpperCase()}
          </text>
          {statusWords ? (
            <text className="crf-node__status" x={w - (existence === 'ref' ? 12 : 58)} y={18} textAnchor="end">
              {statusWords}
            </text>
          ) : null}
          <text className="crf-node__title" x={14} y={36}>
            {titleLines.map((line, index) => (
              <tspan key={index} x={14} dy={index === 0 ? 0 : 15}>
                {line}
              </tspan>
            ))}
          </text>
          {hintRoom && card.hint ? (
            <text className="crf-node__hint" x={14} y={52}>
              {truncate(card.hint, Math.floor((w - 28) / 5.6))}
            </text>
          ) : null}
        </>
      )}

      {existence !== 'ref' && !compact ? (
        <g className="crf-node__tag" transform={`translate(${w - 50} 8)`}>
          <rect width={42} height={14} rx={7} />
          <text x={21} y={7} textAnchor="middle" dominantBaseline="central">
            {existence === 'spec' ? 'SPEC' : '✓ BUILT'}
          </text>
        </g>
      ) : null}

      {card.severity ? (
        <g className="crf-node__issue" data-severity={card.severity} transform="translate(0 0)">
          <circle r={7} />
          <text textAnchor="middle" dominantBaseline="central">{card.severity === 'info' ? 'i' : '!'}</text>
        </g>
      ) : null}

      {card.assignees.length > 0 ? (
        <Avatars assignees={card.assignees} w={w} h={h} onPress={onPressAssignee} />
      ) : null}
    </g>
  );
}

type Shape = 'task' | 'doc' | 'artifact' | 'memory' | 'skill' | 'other';

export function shapeOf(kind: string): Shape {
  return kind === 'task' || kind === 'doc' || kind === 'artifact' || kind === 'memory' || kind === 'skill'
    ? kind
    : 'other';
}

function Silhouette({ kind, w, h }: { kind: Shape; w: number; h: number }) {
  switch (kind) {
    case 'doc': {
      const f = Math.min(14, h / 3);
      return (
        <>
          <path
            className="crf-node__body"
            d={`M6 0 H${w - f} L${w} ${f} V${h - 6} Q${w} ${h} ${w - 6} ${h} H6 Q0 ${h} 0 ${h - 6} V6 Q0 0 6 0 Z`}
          />
          <path className="crf-node__fold" d={`M${w - f} 0 V${f} H${w}`} />
        </>
      );
    }
    case 'artifact':
      return (
        <>
          <rect className="crf-node__body" width={w} height={h} rx={4} />
          <rect className="crf-node__band" x={1} y={1} width={w - 2} height={5} rx={3} />
          <rect className="crf-node__frame" x={4} y={9} width={w - 8} height={h - 13} rx={2} />
        </>
      );
    case 'memory':
      return <rect className="crf-node__body" width={w} height={h} rx={h / 2} />;
    case 'skill': {
      const s = h / 2;
      return (
        <polygon
          className="crf-node__body"
          points={`${s},0 ${w - s},0 ${w},${s} ${w - s},${h} ${s},${h} 0,${s}`}
        />
      );
    }
    case 'task':
      return <rect className="crf-node__body" width={w} height={h} rx={10} />;
    default:
      return <rect className="crf-node__body" width={w} height={h} rx={6} />;
  }
}

/**
 * Assignees DOCKED on the task's bottom edge, right-aligned and overlapping,
 * each ringed in the card colour so they read as attached rather than
 * floating. More than three collapse to "+N" — the full list is in the
 * card's label and the inspector.
 */
function Avatars({
  assignees,
  w,
  h,
  onPress,
}: {
  assignees: readonly BlueprintAssignee[];
  w: number;
  h: number;
  onPress?: ((key: string) => void) | undefined;
}) {
  const shown = assignees.slice(0, MAX_AVATARS);
  const extra = assignees.length - shown.length;
  const step = AVATAR_R * 2 - 5;
  const right = w - 14;
  return (
    <g className="crf-avatars" transform={`translate(0 ${h})`}>
      {extra > 0 ? (
        <g className="crf-avatar crf-avatar--more" transform={`translate(${right} 0)`}>
          <circle r={AVATAR_R} />
          <text textAnchor="middle" dominantBaseline="central">{`+${extra}`}</text>
        </g>
      ) : null}
      {shown.map((assignee, index) => {
        const cx = right - (index + (extra > 0 ? 1 : 0)) * step;
        return (
          <g
            key={assignee.key}
            className={['crf-avatar', ...(assignee.isSpec ? ['crf-avatar--spec'] : [])].join(' ')}
            data-testid="crf-avatar"
            transform={`translate(${cx} 0)`}
            onClick={onPress ? (event) => { event.stopPropagation(); onPress(assignee.key); } : undefined}
          >
            <title>{`${assignee.title}${assignee.isSpec ? ' (spec)' : ''}`}</title>
            <circle r={AVATAR_R} />
            <text textAnchor="middle" dominantBaseline="central">{initials(assignee.title)}</text>
          </g>
        );
      })}
    </g>
  );
}
