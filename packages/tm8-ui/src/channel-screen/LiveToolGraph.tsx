/**
 * LIVE GRAPH SURFACES — the entity star a chat's activity implies.
 *
 * Two mounts share one canvas:
 *
 *   · `LiveGraphStrip` — the collapsible whole-conversation strip (Chat Home).
 *   · `TurnGraph` — the compact in-feed row Session Chat draws IN PLACE OF a
 *     turn's raw activity items: one graph per message-bounded activity run,
 *     visible by default, neutral count language, no tool names.
 *
 * PURE UI — both fold the SAME loaded `FeedItem` array the feed renders from
 * and issue no read of their own, so they are live exactly as the chat is.
 *
 * Visual language is the session-graph surface's (`sg-*` classes, registry
 * icon art), so the fourth chip's full graph and these read as one family.
 */
import { useState, type KeyboardEvent } from 'react';
import type { EntityId } from '@tm8/contract';
import { getKind } from '../domain';
import { NODE_H, NODE_W } from '../session-graph/layout';
import '../session-graph/session-graph.css';
// The strip's own chrome (`.chs-livegraph*`) lives in the channel stylesheet;
// importing it here means any host (session Chat, Chat Home) gets the styles
// with the component instead of relying on ChannelScreen having loaded first.
import './channel-screen.css';
import {
  edgeLabel,
  neutralEdgeLabel,
  type LiveGraphModel,
  type LiveGraphTouch,
} from './live-graph-model';

export interface LiveGraphStripProps {
  /** A prebuilt fold — any client-side source of touches (feed activity,
   *  chat-home tool calls, …). The strip stays presentational. */
  model: LiveGraphModel;
  /** The caller's word for the centre ("this session", "this conversation"). */
  anchorNoun: string;
  /** Registry kind whose icon draws the centre node. */
  focusKind?: string;
  onOpenEntity?: (id: EntityId) => void;
}

const PAD = 24;
const MIN_R = 132;

export interface TurnGraphProps {
  /** The fold of ONE message-bounded activity run — see `segmentTurnGraphs`. */
  model: LiveGraphModel;
  /** The caller's word for the centre ("this session"). */
  anchorNoun: string;
  /** Registry kind whose icon draws the centre node. */
  focusKind?: string;
  onOpenEntity?: (id: EntityId) => void;
}

/**
 * THE IN-FEED TURN GRAPH — a `<li>` row that stands where a turn's raw
 * activity items would otherwise render. Visible by default (no toggle: the
 * graph IS the row), captioned with honest counts, and labelled in NEUTRAL
 * relationship language — entity title/kind and touch counts, never a verb
 * string that could carry a tool name.
 *
 * An empty fold renders NOTHING: an anchorless run has no far ends, and an
 * empty graph would be a drawing of a claim that cannot exist yet.
 */
export function TurnGraph({
  model,
  anchorNoun,
  focusKind = 'work_session',
  onOpenEntity,
}: TurnGraphProps) {
  const { touches } = model;
  if (touches.length === 0) return null;
  const n = touches.length;
  return (
    <li className="chs-turn-graph" data-testid="chs-turn-graph">
      <p className="chs-turn-graph__caption">
        {`turn graph · ${n} ${n === 1 ? 'entity' : 'entities'} · ${model.activityCount} ${
          model.activityCount === 1 ? 'touch' : 'touches'
        }`}
      </p>
      <LiveGraphCanvas
        touches={touches}
        anchorNoun={anchorNoun}
        focusKind={focusKind}
        onOpenEntity={onOpenEntity}
        graphNoun="Turn graph"
        labelFor={neutralEdgeLabel}
      />
    </li>
  );
}

export function LiveGraphStrip({
  model,
  anchorNoun,
  focusKind = 'work_session',
  onOpenEntity,
}: LiveGraphStripProps) {
  // OPEN BY DEFAULT. Collapsed, this strip is a one-line text toggle, which is
  // indistinguishable from "the feature is not here" to anyone who did not
  // build it — and it was read that way twice. The graph is the point; the
  // toggle is how you put it away, not how you find it.
  const [open, setOpen] = useState(true);
  const { touches } = model;

  // Nothing touched yet ⇒ no strip at all. An empty graph header would be a
  // control promising a drawing that cannot exist yet.
  if (touches.length === 0) return null;

  const n = touches.length;
  return (
    <div className="chs-livegraph" data-testid="chs-livegraph">
      <button
        type="button"
        className="chs-livegraph__toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title="Built client-side from this feed's activity items — no extra reads"
      >
        {`${open ? '▾' : '▸'} Live graph`}
        <span className="chs-livegraph__count">
          {`${n} ${n === 1 ? 'entity' : 'entities'} · ${model.activityCount} ${
            model.activityCount === 1 ? 'touch' : 'touches'
          }`}
        </span>
      </button>
      {open ? (
        <LiveGraphCanvas
          touches={touches}
          anchorNoun={anchorNoun}
          focusKind={focusKind}
          onOpenEntity={onOpenEntity}
        />
      ) : null}
    </div>
  );
}

function LiveGraphCanvas({
  touches,
  anchorNoun,
  focusKind,
  onOpenEntity,
  graphNoun = 'Live graph',
  labelFor = edgeLabel,
}: {
  touches: readonly LiveGraphTouch[];
  anchorNoun: string;
  focusKind: string;
  onOpenEntity?: (id: EntityId) => void;
  /** The accessible name's own word for itself ("Live graph", "Turn graph"). */
  graphNoun?: string;
  /** The edge's wording — verbs for the strip, neutral counts for a turn. */
  labelFor?: (touch: LiveGraphTouch) => string;
}) {
  const n = touches.length;
  // One ring; grow it until the nodes fit side by side around it.
  const r = Math.max(MIN_R, (n * NODE_W * 0.8) / (2 * Math.PI));
  const half = r + NODE_W / 2 + PAD;
  const width = half * 2;
  const height = half * 2;
  const cx = half;
  const cy = half;
  const latest = touches.reduce((a, b) => (b.lastAt > a.lastAt ? b : a));

  return (
    <div className="chs-livegraph__canvas">
      <svg
        className="sg-svg"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`${graphNoun}: ${anchorNoun} touched ${n} ${n === 1 ? 'entity' : 'entities'}`}
      >
        <circle className="sg-ring" cx={cx} cy={cy} r={r} />
        {touches.map((touch, index) => {
          const angle = -Math.PI / 2 + (index * 2 * Math.PI) / n;
          const x = cx + Math.cos(angle) * r;
          const y = cy + Math.sin(angle) * r;
          // Label sits just past the midpoint, on the node's side of the line.
          const lx = cx + Math.cos(angle) * r * 0.55;
          const ly = cy + Math.sin(angle) * r * 0.55;
          return (
            <g key={touch.id}>
              <path className="sg-link" d={`M ${cx} ${cy} L ${x} ${y}`} />
              <text className="sg-meta" x={lx} y={ly - 4} textAnchor="middle">
                {labelFor(touch)}
              </text>
              <TouchNode
                touch={touch}
                x={x}
                y={y}
                fresh={touch === latest}
                onOpen={onOpenEntity}
                labelFor={labelFor}
              />
            </g>
          );
        })}
        <FocusNode cx={cx} cy={cy} label={anchorNoun} kind={focusKind} />
      </svg>
    </div>
  );
}

function FocusNode({ cx, cy, label, kind }: { cx: number; cy: number; label: string; kind: string }) {
  const config = getKind(kind);
  return (
    <g className="sg-cell sg-cell--focus" transform={`translate(${cx - NODE_W / 2} ${cy - NODE_H / 2})`}>
      <rect className="sg-box" width={NODE_W} height={NODE_H} rx={8} />
      <g className="sg-icon" transform={`translate(11 ${NODE_H / 2 - 8})`}>
        {config.iconArt.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
      <text className="sg-title" x={33} y={17}>
        {truncate(label, 17)}
      </text>
      <text className="sg-meta" x={33} y={30}>
        {config.label}
      </text>
    </g>
  );
}

function TouchNode({
  touch,
  x,
  y,
  fresh,
  onOpen,
  labelFor,
}: {
  touch: LiveGraphTouch;
  x: number;
  y: number;
  fresh: boolean;
  onOpen?: (id: EntityId) => void;
  labelFor: (touch: LiveGraphTouch) => string;
}) {
  const config = getKind(touch.kind);
  /* A node is a BUTTON only where the host can actually open the entity. With
     no handler it keeps its label and drops the role, the tab stop and the
     handlers — the same rule the entity chips follow, and for the same reason:
     `role="button"` over a no-op is a control that swallows the press. */
  const label = `${config.label}: ${touch.title} — ${labelFor(touch)}`;
  const pressable = onOpen
    ? {
        role: 'button',
        tabIndex: 0,
        onClick: () => onOpen(touch.id),
        onKeyDown: (event: KeyboardEvent<SVGGElement>) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onOpen(touch.id);
          }
        },
      }
    : {};
  return (
    <g
      className={`sg-cell${fresh ? ' chs-livegraph__cell--fresh' : ''}`}
      transform={`translate(${x - NODE_W / 2} ${y - NODE_H / 2})`}
      aria-label={label}
      {...pressable}
    >
      <rect className="sg-box" width={NODE_W} height={NODE_H} rx={8} data-hop={1} />
      <g className="sg-icon" transform={`translate(11 ${NODE_H / 2 - 8})`}>
        {config.iconArt.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
      <text className="sg-title" x={33} y={17}>
        {truncate(touch.title, 17)}
      </text>
      <text className="sg-meta" x={33} y={30}>
        {config.label}
      </text>
      {touch.count > 1 ? (
        <text className="sg-count" x={NODE_W - 10} y={15} textAnchor="end">
          ×{touch.count}
        </text>
      ) : null}
    </g>
  );
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
