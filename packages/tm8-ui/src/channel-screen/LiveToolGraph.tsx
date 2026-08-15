/**
 * LIVE TOOL GRAPH — the collapsible strip at the top of a session's Chat feed.
 *
 * Draws the star the feed already implies: the session at the centre, one node
 * per entity its tool calls touched, edges labelled with the accumulated verbs.
 * PURE UI — it reads the SAME `page.items` array the chip rows render from and
 * issues no read of its own, so it is live exactly as the chat is live.
 *
 * Visual language is the session-graph surface's (`sg-*` classes, registry
 * icon art), so the fourth chip's full graph and this strip read as one family.
 */
import { useMemo, useState } from 'react';
import type { EntityId, FeedItem } from '@tm8/contract';
import { getKind } from '../domain';
import { NODE_H, NODE_W } from '../session-graph/layout';
import '../session-graph/session-graph.css';
// The strip's own chrome (`.chs-livegraph*`) lives in the channel stylesheet;
// importing it here means any host (session Chat, Chat Home) gets the styles
// with the component instead of relying on ChannelScreen having loaded first.
import './channel-screen.css';
import {
  edgeLabel,
  foldLiveGraph,
  type LiveGraphModel,
  type LiveGraphTouch,
} from './live-graph-model';

export interface LiveToolGraphProps {
  items: readonly FeedItem[];
  anchorId: EntityId;
  /** The caller's word for the centre ("this session"). */
  anchorNoun: string;
  onOpenEntity?: (id: EntityId) => void;
}

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

export function LiveToolGraph({ items, anchorId, anchorNoun, onOpenEntity }: LiveToolGraphProps) {
  const model = useMemo(() => foldLiveGraph(items, anchorId), [items, anchorId]);
  return <LiveGraphStrip model={model} anchorNoun={anchorNoun} onOpenEntity={onOpenEntity} />;
}

export function LiveGraphStrip({
  model,
  anchorNoun,
  focusKind = 'work_session',
  onOpenEntity,
}: LiveGraphStripProps) {
  const [open, setOpen] = useState(false);
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
}: {
  touches: readonly LiveGraphTouch[];
  anchorNoun: string;
  focusKind: string;
  onOpenEntity?: (id: EntityId) => void;
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
        aria-label={`Live graph: ${anchorNoun} touched ${n} ${n === 1 ? 'entity' : 'entities'}`}
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
                {edgeLabel(touch)}
              </text>
              <TouchNode
                touch={touch}
                x={x}
                y={y}
                fresh={touch === latest}
                onOpen={onOpenEntity}
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
}: {
  touch: LiveGraphTouch;
  x: number;
  y: number;
  fresh: boolean;
  onOpen?: (id: EntityId) => void;
}) {
  const config = getKind(touch.kind);
  const open = () => onOpen?.(touch.id);
  return (
    <g
      className={`sg-cell${fresh ? ' chs-livegraph__cell--fresh' : ''}`}
      transform={`translate(${x - NODE_W / 2} ${y - NODE_H / 2})`}
      role="button"
      tabIndex={0}
      aria-label={`${config.label}: ${touch.title} — ${edgeLabel(touch)}`}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          open();
        }
      }}
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
