/**
 * THE GRAPH — one SVG of everything in the story (artifact 01a0fc3e rev 4).
 *
 * Renders ONLY from `view` (geometry in `layout.ts`), acts ONLY through
 * `onPick`. Colour is tokens: node tones are the run / info / block soft
 * pairs, edge strokes are `FAMILY_TOKEN`. Kinds are data — the glyph comes
 * from the registry (`getKind(kind).iconArt`), the view from `VIEW_OF_KIND`.
 *
 * Local UI state only: the view switcher, the hovered root (lights its trail)
 * and the picked node (outlined while its popover is open).
 */
import { useId, useMemo, useState, type KeyboardEvent, type MouseEvent } from 'react';

import { getKind, KindIcon } from '../../domain';
import { FAMILY_TOKEN, GRAPH_VIEWS, STORY_KIND, VIEW_OF_KIND, type StoryEdgeFamily, type StoryGraphView } from '../model';
import { layoutStoryGraph, maskFor, trunc, type GraphEdge, type GraphNode } from './layout';
import type { StoryGraphProps } from './props-graph';
import './story-graph.css';

/** The kind whose glyph stands for a view on the switcher: the first kind the table files under it. */
const VIEW_ICON: Readonly<Record<StoryGraphView, string>> = Object.fromEntries(
  GRAPH_VIEWS.map(({ view }) => [view, Object.keys(VIEW_OF_KIND).find((k) => VIEW_OF_KIND[k] === view) ?? STORY_KIND]),
) as Record<StoryGraphView, string>;

const EDGE_LEGEND: Readonly<Record<StoryEdgeFamily, string>> = {
  parent: 'parent',
  story: 'in the story',
  runs: 'runs · assigned',
  made: 'made: docs, drawings, artifacts, memories',
  code: 'code: PRs, commits',
  blocks: 'blocks',
  team: 'team: coordinates · dispatched',
};

function Glyph({ kind, x, y }: { kind: string; x: number; y: number }) {
  return (
    <g className="sg-g" transform={`translate(${x - 8},${y - 8})`}>
      {getKind(kind).iconArt.map((d) => (
        <path key={d} d={d} />
      ))}
    </g>
  );
}

function NodeText({ node }: { node: GraphNode }) {
  const y0 = node.y + node.r + 12;
  return (
    <text x={node.x} y={y0} textAnchor="middle">
      {node.lines.map((l, i) => (
        <tspan key={i} x={node.x} dy={i === 0 ? 0 : 11}>
          {l}
        </tspan>
      ))}
      {node.caption && (
        <tspan className="sg-ed" x={node.x} dy={node.lines.length ? 11 : 0}>
          {node.caption}
        </tspan>
      )}
    </text>
  );
}

function Capsule({ node }: { node: GraphNode }) {
  const cap = node.capsule!;
  const x0 = node.x - node.w / 2;
  const y0 = node.y - node.h / 2;
  const tone = node.tone ?? 'todo';
  const cx = x0 + node.h / 2;
  const ax = x0 + node.w - node.h / 2 - 4;
  const isRoot = node.role === 'root';
  return (
    <>
      {node.recent && <rect className="sg-halo" x={x0 - 8} y={y0 - 8} width={node.w + 16} height={node.h + 16} rx={node.h / 2 + 8} />}
      <rect className="sg-pulse" x={x0 - 2} y={y0 - 2} width={node.w + 4} height={node.h + 4} rx={node.h / 2 + 2} />
      <rect className={`sg-shell sg-shell--${tone}`} x={x0} y={y0} width={node.w} height={node.h} rx={node.h / 2} />
      {isRoot && <rect className="sg-ring" x={x0 - 4} y={y0 - 4} width={node.w + 8} height={node.h + 8} rx={node.h / 2 + 4} />}
      <circle className="sg-body" cx={cx} cy={node.y} r={node.h / 2 - 5} />
      <Glyph kind={node.kind} x={cx} y={node.y} />
      <rect className="sg-avbox" x={ax - 9} y={node.y - 9} width={18} height={18} rx={4} />
      <text className="sg-avtxt" x={ax} y={node.y + 3.5} textAnchor="middle">
        {cap.initials}
      </text>
      <text className="sg-cap-title" x={x0 + node.h + 2} y={node.y + 4}>
        {trunc(node.title, isRoot ? 20 : 15)}
      </text>
      <text className="sg-cap-live" x={node.x} y={node.y + node.h / 2 + 12} textAnchor="middle">
        <tspan className="sg-cap-dot">●</tspan> {cap.line}
      </text>
    </>
  );
}

function Teammate({ node }: { node: GraphNode }) {
  return (
    <>
      <rect className="sg-hit" x={node.x - 40} y={node.y - 15} width={80} height={56} />
      {node.live && <rect className="sg-pulse" x={node.x - 15} y={node.y - 15} width={30} height={30} rx={8} />}
      <rect className="sg-box" x={node.x - 13} y={node.y - 13} width={26} height={26} rx={6} />
      <text className="sg-ini" x={node.x} y={node.y + 4} textAnchor="middle">
        {node.initials}
      </text>
      <text className="sg-lbl" x={node.x} y={node.y + 26} textAnchor="middle">
        {node.lines[0]}
        {node.caption && (
          <tspan className="sg-ed" x={node.x} dy={11}>
            {node.caption}
          </tspan>
        )}
      </text>
    </>
  );
}

function Disc({ node }: { node: GraphNode }) {
  return (
    <>
      {/* The hit area: the disc and its label, gap included. */}
      <rect className="sg-hit" x={node.x - 40} y={node.y - node.r - 9} width={80} height={2 * node.r + 43} />
      {node.recent && <circle className="sg-halo" cx={node.x} cy={node.y} r={node.r + 9} />}
      <circle className="sg-body" cx={node.x} cy={node.y} r={node.r} />
      {node.role === 'root' && <circle className="sg-ring" cx={node.x} cy={node.y} r={node.r + 4} />}
      <Glyph kind={node.kind} x={node.x} y={node.y} />
      <NodeText node={node} />
    </>
  );
}

function nodeClass(node: GraphNode, extra: string[]): string {
  return [
    'sg-n',
    `sg-n--${node.role}`,
    node.tone ? `sg-n--${node.tone}` : '',
    node.exited ? 'sg-n--exited' : '',
    node.capsule ? 'sg-cap' : '',
    node.live ? 'sg-n--live' : '',
    ...extra,
  ]
    .filter(Boolean)
    .join(' ');
}

function nodeTip(node: GraphNode): string {
  if (!node.capsule) return node.title;
  return `${node.title} — ${node.capsule.line}`;
}

export function StoryGraph({ view, live, onPick, initialView }: StoryGraphProps) {
  const [graphView, setGraphView] = useState<StoryGraphView>(initialView ?? 'all');
  const [hoverRoot, setHoverRoot] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const markerId = `sg-arrow-${useId().replace(/:/g, '')}`;

  const layout = useMemo(() => layoutStoryGraph(view), [view]);
  const mask = useMemo(() => maskFor(layout, graphView), [layout, graphView]);
  const all = graphView === 'all';
  const landed = live?.landed;

  const shown = (id: string) => mask.inView.has(id) || mask.context.has(id);
  const lit = (rootIds: readonly string[]) => (hoverRoot ? (rootIds.includes(hoverRoot) ? ' sg-on' : ' sg-off-hl') : '');

  const edgeState = (e: GraphEdge): string | null => {
    const vis = shown(e.from) && shown(e.to);
    const touches = mask.inView.has(e.from) || mask.inView.has(e.to);
    if (!vis || (!all && !touches && e.from !== view.id)) return null;
    return !all && !(mask.inView.has(e.from) && mask.inView.has(e.to)) ? ' sg-dim' : '';
  };

  const pick = (node: GraphNode, el: Element) => {
    if (!onPick) return;
    setPicked(node.id);
    const r = el.getBoundingClientRect();
    onPick({ entityId: node.id, anchor: { x: r.x, y: r.y, width: r.width, height: r.height } });
  };

  const rule = all
    ? `${layout.nodes.length} nodes · ${layout.edges.length} edges · depth ${view.page.follow.depth}`
    : `${mask.inView.size} in view · the rest stays as context`;
  const truncated = view.state.truncated || view.page.follow.truncated;
  const empty = layout.allRootIds.length === 0;

  return (
    <section className="sg-card" aria-label="The graph">
      <div className="sg-head">
        <span className="kit-eyebrow">The graph</span>
        <span className="sg-seg" role="tablist" aria-label="Graph view">
          {GRAPH_VIEWS.map(({ view: v, label }) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={graphView === v}
              className={graphView === v ? 'sg-seg__b sg-seg__b--on' : 'sg-seg__b'}
              onClick={() => setGraphView(v)}
            >
              <KindIcon kind={VIEW_ICON[v]} size={12} />
              {label}
            </button>
          ))}
        </span>
        <span className="sg-grow" />
        <span className="sg-count">{rule}</span>
        {truncated && <span className="sg-count sg-count--warn">· trail cut at {view.page.follow.limit} rows</span>}
        {!empty && <span className="sg-count">· hover a root</span>}
      </div>

      <div className="sg-scroll">
        <svg
          className={`sg-svg${hoverRoot ? ' sg-svg--hl' : ''}${graphView === 'team' ? ' sg-svg--team' : ''}`}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          style={{ minWidth: layout.width > 1216 ? layout.width * 0.75 : undefined }}
          role="img"
          aria-label={`Story graph: ${rule}`}
        >
          <defs>
            <marker id={markerId} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0.8 7 4 0 7.2z" style={{ fill: FAMILY_TOKEN.blocks }} />
            </marker>
          </defs>

          {layout.edges.map((e) => {
            const st = edgeState(e);
            if (st === null) return null;
            const cls = `sg-e sg-e--${e.family}${e.cross ? ' sg-e--cross' : ''}${e.exited ? ' sg-e--exited' : ''}${st}${lit(e.rootIds)}`;
            return (
              <g key={e.key}>
                <path
                  className={cls}
                  d={e.d}
                  style={{ stroke: e.exited ? undefined : FAMILY_TOKEN[e.family] }}
                  markerEnd={e.family === 'blocks' ? `url(#${markerId})` : undefined}
                >
                  <title>{e.type}</title>
                </path>
                {e.label && (
                  <text
                    className={`sg-el sg-el--${e.family}${st}${lit(e.rootIds)}`}
                    x={e.label.x}
                    y={e.label.y}
                    textAnchor={e.label.anchor}
                    style={{ fill: FAMILY_TOKEN[e.family] }}
                  >
                    {e.label.text}
                  </text>
                )}
              </g>
            );
          })}

          {layout.nodes.map((node) => {
            if (!shown(node.id)) return null;
            const dim = !all && !mask.inView.has(node.id) ? 'sg-dim' : '';
            const hl = hoverRoot ? (node.rootIds.includes(hoverRoot) ? 'sg-on' : 'sg-off-hl') : '';
            const cls = nodeClass(node, [
              dim,
              hl,
              picked === node.id ? 'sg-picked' : '',
              landed?.has(node.id) ? 'sg-flash' : '',
              onPick ? 'sg-n--pickable' : '',
            ]);
            const isRoot = node.role === 'root';
            return (
              <g
                key={node.id}
                className={cls}
                data-id={node.id}
                {...(onPick
                  ? {
                      role: 'button',
                      tabIndex: 0,
                      'aria-label': nodeTip(node),
                      onClick: (ev: MouseEvent<SVGGElement>) => {
                        ev.stopPropagation();
                        pick(node, ev.currentTarget);
                      },
                      onKeyDown: (ev: KeyboardEvent<SVGGElement>) => {
                        if (ev.key === 'Enter' || ev.key === ' ') {
                          ev.preventDefault();
                          pick(node, ev.currentTarget);
                        }
                      },
                    }
                  : {})}
                onMouseEnter={isRoot ? () => setHoverRoot(node.id) : undefined}
                onMouseLeave={isRoot ? () => setHoverRoot(null) : undefined}
              >
                <title>{nodeTip(node)}</title>
                {node.capsule ? <Capsule node={node} /> : node.initials !== null ? <Teammate node={node} /> : <Disc node={node} />}
              </g>
            );
          })}

          {all &&
            layout.notes.map((n) => (
              <text key={`${n.x}-${n.y}`} className="sg-note" x={n.x} y={n.y} textAnchor="middle">
                {n.text}
              </text>
            ))}
          {empty && (
            <text className="sg-note" x={layout.width / 2} y={124} textAnchor="middle">
              Nothing is in this story yet. Put a task in and everything connected to it follows.
            </text>
          )}
        </svg>
      </div>

      <div className="sg-legend">
        <span className="sg-legend__grp">nodes</span>
        <span><i className="sg-sw sg-sw--root" />root</span>
        <span><i className="sg-sw sg-sw--done" />done</span>
        <span><i className="sg-sw sg-sw--working" />working</span>
        <span><i className="sg-sw sg-sw--blocked" />blocked</span>
        <span><i className="sg-sw" />to do · other kinds</span>
        <span><i className="sg-sw sg-sw--cap" />live capsule: task + session + teammate</span>
        <span><i className="sg-sw sg-sw--halo" />active in the last hour</span>
        <span><i className="sg-sw sg-sw--tm" />teammate</span>
        <span><i className="sg-sw sg-sw--child" />child story</span>
        <span className="sg-legend__sep" />
        <span className="sg-legend__grp">edges</span>
        {(Object.entries(EDGE_LEGEND) as Array<[StoryEdgeFamily, string]>).map(([fam, label]) => (
          <span key={fam}>
            <i className="sg-ln" style={{ borderTopColor: FAMILY_TOKEN[fam] }} />
            {label}
          </span>
        ))}
        <span><i className="sg-ln sg-ln--cross" />across roots</span>
      </div>
    </section>
  );
}
