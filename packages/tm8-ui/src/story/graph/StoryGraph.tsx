/**
 * THE GRAPH — one SVG of everything in the story (artifact 01a0fc3e rev 4).
 *
 * Renders ONLY from `view` (geometry in `layout.ts`), acts ONLY through
 * `onPick`. Colour is tokens: node tones are the run / info / block soft
 * pairs, edge strokes are `FAMILY_TOKEN`. Kinds are data — the glyph comes
 * from the registry (`getKind(kind).iconArt`), the view from `VIEW_OF_KIND`.
 *
 * Local UI state only: the view switcher and, when no `hover` is passed, the
 * hovered root. The selection (`selectedId`) is the page's.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';

import { getKind, KindIcon } from '../../domain';
import { IconBtn } from '../../kit/IconBtn';
import { VectorIcon } from '../../kit/VectorIcon';
import { FAMILY_TOKEN, GRAPH_VIEWS, STORY_KIND, VIEW_OF_KIND, type StoryEdgeFamily, type StoryGraphView } from '../model';
import { edgeTypeCounts, useEdgeTypes } from './edge-filter';
import { kindCounts, layoutStoryGraph, maskFor, trunc, type GraphEdge, type GraphNode } from './layout';
import type { StoryHops, StoryNodePick } from '../props';
import type { StoryGraphProps } from './props-graph';
import { useGraphZoom } from './useGraphZoom';
import './story-graph.css';

/** The kind whose glyph stands for a view on the switcher: the first kind the table files under it. */
const VIEW_ICON: Readonly<Record<StoryGraphView, string>> = Object.fromEntries(
  GRAPH_VIEWS.map(({ view }) => [view, Object.keys(VIEW_OF_KIND).find((k) => VIEW_OF_KIND[k] === view) ?? STORY_KIND]),
) as Record<StoryGraphView, string>;

const HOP_CHOICES: readonly StoryHops[] = [1, 2, 3];

/** The smallest the canvas is drawn at: below it, labels stop being legible, so it scrolls instead. */
const MIN_SCALE = 0.85;
/** Full screen may draw it larger than natural, up to this. */
const MAX_FILL_SCALE = 1.6;

/* 16×16 view-control glyphs, `kit/ZoomableFigure`'s. */
const ICON_ZOOM_IN = ['M8 3.5 V12.5', 'M3.5 8 H12.5'];
const ICON_ZOOM_OUT = ['M3.5 8 H12.5'];
const ICON_FIT = ['M2.5 2.5 H13.5 V13.5 H2.5 Z', 'M6 6 H10 V10 H6 Z'];
const ICON_EXPAND = ['M9.5 2.5 H13.5 V6.5', 'M13.5 2.5 L9.5 6.5', 'M6.5 13.5 H2.5 V9.5', 'M2.5 13.5 L6.5 9.5'];
const ICON_COLLAPSE = ['M13.5 6.5 H9.5 V2.5', 'M9.5 6.5 L13.5 2.5', 'M2.5 9.5 H6.5 V13.5', 'M6.5 9.5 L2.5 13.5'];

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
    <g className="stg-g" transform={`translate(${x - 8},${y - 8})`}>
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
        <tspan className="stg-ed" x={node.x} dy={node.lines.length ? 11 : 0}>
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
      {node.recent && <rect className="stg-halo" x={x0 - 8} y={y0 - 8} width={node.w + 16} height={node.h + 16} rx={node.h / 2 + 8} />}
      <rect className="stg-pulse" x={x0 - 2} y={y0 - 2} width={node.w + 4} height={node.h + 4} rx={node.h / 2 + 2} />
      <rect className={`stg-shell stg-shell--${tone}`} x={x0} y={y0} width={node.w} height={node.h} rx={node.h / 2} />
      {isRoot && <rect className="stg-ring" x={x0 - 4} y={y0 - 4} width={node.w + 8} height={node.h + 8} rx={node.h / 2 + 4} />}
      <circle className="stg-body" cx={cx} cy={node.y} r={node.h / 2 - 5} />
      <Glyph kind={node.kind} x={cx} y={node.y} />
      <rect className="stg-avbox" x={ax - 9} y={node.y - 9} width={18} height={18} rx={4} />
      <text className="stg-avtxt" x={ax} y={node.y + 3.5} textAnchor="middle">
        {cap.initials}
      </text>
      <text className="stg-cap-title" x={x0 + node.h + 2} y={node.y + 4}>
        {trunc(node.title, isRoot ? 20 : 15)}
      </text>
      <text className="stg-cap-live" x={node.x} y={node.y + node.h / 2 + 12} textAnchor="middle">
        <tspan className="stg-cap-dot">●</tspan> {cap.line}
      </text>
    </>
  );
}

function Teammate({ node }: { node: GraphNode }) {
  return (
    <>
      <rect className="stg-hit" x={node.x - 40} y={node.y - 15} width={80} height={56} />
      {node.live && <rect className="stg-pulse" x={node.x - 15} y={node.y - 15} width={30} height={30} rx={8} />}
      <rect className="stg-box" x={node.x - 13} y={node.y - 13} width={26} height={26} rx={6} />
      <text className="stg-ini" x={node.x} y={node.y + 4} textAnchor="middle">
        {node.initials}
      </text>
      <text className="stg-lbl" x={node.x} y={node.y + 26} textAnchor="middle">
        {node.lines[0]}
        {node.caption && (
          <tspan className="stg-ed" x={node.x} dy={11}>
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
      <rect className="stg-hit" x={node.x - 40} y={node.y - node.r - 9} width={80} height={2 * node.r + 43} />
      {node.recent && <circle className="stg-halo" cx={node.x} cy={node.y} r={node.r + 9} />}
      <circle className="stg-body" cx={node.x} cy={node.y} r={node.r} />
      {node.role === 'root' && <circle className="stg-ring" cx={node.x} cy={node.y} r={node.r + 4} />}
      <Glyph kind={node.kind} x={node.x} y={node.y} />
      <NodeText node={node} />
    </>
  );
}

/** Selected = its details are open beside the story: an ink ring outside everything else (root ring, halo, flash). */
function SelectionRing({ node }: { node: GraphNode }) {
  if (node.capsule || node.initials !== null) {
    const pad = 7;
    return (
      <rect
        className="stg-sel"
        x={node.x - node.w / 2 - pad}
        y={node.y - node.h / 2 - pad}
        width={node.w + 2 * pad}
        height={node.h + 2 * pad}
        rx={node.capsule ? node.h / 2 + pad : 9}
      />
    );
  }
  return <circle className="stg-sel" cx={node.x} cy={node.y} r={node.r + 7} />;
}

/** The secondary affordance: a small "…" at the node's top-right, shown on hover and focus, reachable by Tab. */
function MoreButton({ node, onPress }: { node: GraphNode; onPress: (el: Element) => void }) {
  const boxy = !!node.capsule || node.initials !== null;
  const cx = boxy ? node.x + node.w / 2 - 2 : node.x + node.r * 0.8 + 5;
  const cy = boxy ? node.y - node.h / 2 - 2 : node.y - node.r * 0.8 - 5;
  return (
    <g
      className="stg-more"
      role="button"
      tabIndex={0}
      aria-label={`Actions for ${node.title}`}
      onClick={(ev) => {
        ev.stopPropagation();
        onPress(ev.currentTarget);
      }}
      onKeyDown={(ev) => {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        ev.preventDefault();
        ev.stopPropagation();
        onPress(ev.currentTarget);
      }}
    >
      <circle className="stg-more__bg" cx={cx} cy={cy} r={8} />
      {[-3.2, 0, 3.2].map((d) => (
        <circle key={d} className="stg-more__dot" cx={cx + d} cy={cy} r={1.1} />
      ))}
    </g>
  );
}

function nodeClass(node: GraphNode, extra: string[]): string {
  return [
    'stg-n',
    `stg-n--${node.role}`,
    node.tone ? `stg-n--${node.tone}` : '',
    node.exited ? 'stg-n--exited' : '',
    node.capsule ? 'stg-cap' : '',
    node.live ? 'stg-n--live' : '',
    ...extra,
  ]
    .filter(Boolean)
    .join(' ');
}

function nodeTip(node: GraphNode): string {
  if (!node.capsule) return node.title;
  return `${node.title} — ${node.capsule.line}`;
}

export function StoryGraph({ view, live, hover, filter, selectedId, onPick, onMenu, initialView, fill }: StoryGraphProps) {
  const [graphView, setGraphView] = useState<StoryGraphView>(initialView ?? 'all');
  /* Root hover is shared with the Roots card through `hover` when the page holds it; local otherwise. */
  const [ownHoverRoot, setOwnHoverRoot] = useState<string | null>(null);
  const setHoverRoot = hover ? hover.setRootId : setOwnHoverRoot;
  const wantedRoot = hover ? hover.rootId : ownHoverRoot;
  const markerId = `stg-arrow-${useId().replace(/:/g, '')}`;

  /* View-only filter held by the page (absent = full depth, every kind, no controls). */
  const hops = filter?.hops ?? 3;
  const layout = useMemo(() => layoutStoryGraph(view, Date.now(), hops), [view, hops]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const zoom = useGraphZoom(scrollRef, layout.width, layout.height, !!fill);
  /* Full screen draws like the full view: a definite box the canvas fills. */
  const tall = fill || zoom.maximised;
  /* When the canvas overflows, open it centred on the story rather than on the left flank. */
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const self = layout.nodes[0];
    if (!el || !self || el.scrollWidth <= el.clientWidth) return;
    const scale = el.scrollWidth / layout.width;
    el.scrollLeft = Math.max(0, self.x * scale - el.clientWidth / 2);
  }, [layout]);
  /* A selection made outside (a card) whose node lies outside the scroller: bring it into view, centred. */
  useEffect(() => {
    const fromHere = pickedHere.current === selectedId;
    pickedHere.current = null;
    const el = scrollRef.current;
    if (!selectedId || fromHere || !el) return;
    const node = Array.from(el.querySelectorAll<SVGGElement>('.stg-n')).find((g) => g.dataset.id === selectedId);
    if (!node) return;
    const box = el.getBoundingClientRect();
    const r = node.getBoundingClientRect();
    const inside = r.left >= box.left && r.right <= box.right && r.top >= box.top && r.bottom <= box.bottom;
    if (inside) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    el.scrollTo?.({
      left: el.scrollLeft + (r.left + r.width / 2) - (box.left + el.clientWidth / 2),
      top: el.scrollTop + (r.top + r.height / 2) - (box.top + el.clientHeight / 2),
      behavior: reduce ? 'auto' : 'smooth',
    });
  }, [selectedId]);
  /* A root id from outside that this graph does not draw lights nothing rather than dimming everything. */
  const hoverRoot = wantedRoot && layout.allRootIds.includes(wantedRoot) ? wantedRoot : null;
  const kinds = filter?.kinds ?? null;
  const mask = useMemo(() => maskFor(layout, graphView, kinds), [layout, graphView, kinds]);
  const present = useMemo(() => kindCounts(layout), [layout]);
  /* `all` = nothing filtered: Everything with every kind on. */
  const everything = graphView === 'all';
  const all = everything && !kinds;
  const toggleKind = (kind: string) => {
    if (!filter) return;
    const next = new Set(kinds ?? present.map((k) => k.kind));
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    filter.setKinds(present.every((k) => next.has(k.kind)) ? null : next);
  };
  /* Edge types drawn: none until the user turns one on (issue #35); shared across stories. */
  const edgeTypes = useEdgeTypes();
  const presentTypes = useMemo(() => edgeTypeCounts(layout.edges), [layout]);
  const landed = live?.landed;

  const shown = (id: string) => mask.inView.has(id) || mask.context.has(id);
  const lit = (rootIds: readonly string[]) => (hoverRoot ? (rootIds.includes(hoverRoot) ? ' stg-on' : ' stg-off-hl') : '');

  const edgeState = (e: GraphEdge): string | null => {
    if (!edgeTypes.types.has(e.type)) return null;
    const vis = shown(e.from) && shown(e.to);
    const touches = mask.inView.has(e.from) || mask.inView.has(e.to);
    if (!vis || (!all && !touches && e.from !== view.id)) return null;
    return !all && !(mask.inView.has(e.from) && mask.inView.has(e.to)) ? ' stg-dim' : '';
  };

  const pickOf = (node: GraphNode, el: Element): StoryNodePick => {
    const r = (el.closest('.stg-n') ?? el).getBoundingClientRect();
    return { entityId: node.id, anchor: { x: r.x, y: r.y, width: r.width, height: r.height } };
  };
  /* The id this graph itself just picked: that node is in view already, so its selection never scrolls. */
  const pickedHere = useRef<string | null>(null);
  const pick = (node: GraphNode, el: Element) => {
    pickedHere.current = node.id;
    onPick?.(pickOf(node, el));
  };
  const menu = (node: GraphNode, el: Element) => onMenu?.(pickOf(node, el));

  const rule = all
    ? `${layout.nodes.length} nodes · ${layout.edges.filter((e) => edgeTypes.types.has(e.type)).length} of ${layout.edges.length} edges · depth ${view.page.follow.depth}`
    : `${mask.inView.size} in view · the rest stays as context`;
  /* The trail spends its row budget level by level, so a cut lands on the
     deepest level it reached (or the one after it): every level above that is
     whole. Warn only when the hops on show reach that level, and say so. */
  const cutDepth = useMemo(() => {
    if (!view.state.truncated && !view.page.follow.truncated) return null;
    return view.page.nodes.reduce((d, n) => Math.max(d, n.depth), 0);
  }, [view]);
  const cutNote =
    cutDepth !== null && hops >= Math.max(cutDepth, 1)
      ? `trail cut at ${view.page.follow.limit} rows: some things ${cutDepth === 0 ? 'in the story' : `${cutDepth}${cutDepth < view.page.follow.depth ? '+' : ''} ${cutDepth === 1 ? 'hop' : 'hops'} from a root`} are not drawn`
      : null;
  const empty = layout.allRootIds.length === 0;

  return (
    <section
      className={`stg-card${tall ? ' stg-card--fill' : ''}${zoom.maximised ? ' stg-card--max' : ''}`}
      aria-label="The graph"
    >
      <div className="stg-head">
        <span className="kit-eyebrow">The graph</span>
        <span className="stg-seg" role="tablist" aria-label="Graph view">
          {GRAPH_VIEWS.map(({ view: v, label }) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={graphView === v}
              className={graphView === v ? 'stg-seg__b stg-seg__b--on' : 'stg-seg__b'}
              onClick={() => setGraphView(v)}
            >
              <KindIcon kind={VIEW_ICON[v]} size={12} />
              {label}
            </button>
          ))}
        </span>
        {filter && (
          <span className="stg-hops" role="radiogroup" aria-label="Hops from a root">
            <span className="stg-hops__lbl">hops</span>
            {HOP_CHOICES.map((h) => (
              <button
                key={h}
                type="button"
                role="radio"
                aria-checked={hops === h}
                className={hops === h ? 'stg-seg__b stg-seg__b--on' : 'stg-seg__b'}
                onClick={() => filter.setHops(h)}
              >
                {h}
              </button>
            ))}
          </span>
        )}
        <span className="stg-meta">
          <span className="stg-count">{rule}</span>
          {cutNote && (
            <span className="stg-count stg-count--warn" title="The story's trail is bounded; the rows past the bound are not read.">
              · {cutNote}
            </span>
          )}
          {hops < 3 && <span className="stg-count stg-count--note">· showing {hops} {hops === 1 ? 'hop' : 'hops'}</span>}
          {!empty && <span className="stg-count">· hover a root</span>}
        </span>
        {filter && everything && present.length > 0 && (
          <span className="stg-kinds" role="group" aria-label="Kinds shown">
            <button type="button" className={`stg-chip${kinds === null ? ' stg-chip--on' : ''}`} aria-pressed={kinds === null} onClick={() => filter.setKinds(null)}>
              all
            </button>
            <button type="button" className={`stg-chip${kinds?.size === 0 ? ' stg-chip--on' : ''}`} aria-pressed={kinds?.size === 0} onClick={() => filter.setKinds(new Set())}>
              none
            </button>
            <span className="stg-kinds__sep" />
            {present.map(({ kind, count }) => {
              const on = !kinds || kinds.has(kind);
              return (
                <button key={kind} type="button" className={`stg-chip${on ? ' stg-chip--on' : ''}`} aria-pressed={on} onClick={() => toggleKind(kind)}>
                  <KindIcon kind={kind} size={11} />
                  {getKind(kind).label}
                  <span className="stg-chip__n">{count}</span>
                </button>
              );
            })}
          </span>
        )}
        {presentTypes.length > 0 && (
          <span className="stg-kinds stg-edges" role="group" aria-label="Edge types shown">
            <span className="stg-hops__lbl">edges</span>
            <button
              type="button"
              className={`stg-chip${presentTypes.every((t) => edgeTypes.types.has(t.type)) ? ' stg-chip--on' : ''}`}
              onClick={() => edgeTypes.set(new Set([...edgeTypes.types, ...presentTypes.map((t) => t.type)]))}
            >
              all
            </button>
            <button
              type="button"
              className={`stg-chip${presentTypes.every((t) => !edgeTypes.types.has(t.type)) ? ' stg-chip--on' : ''}`}
              onClick={() => edgeTypes.set(new Set([...edgeTypes.types].filter((t) => !presentTypes.some((p) => p.type === t))))}
            >
              none
            </button>
            <span className="stg-kinds__sep" />
            {presentTypes.map(({ type, count }) => {
              const on = edgeTypes.types.has(type);
              return (
                <button key={type} type="button" className={`stg-chip${on ? ' stg-chip--on' : ''}`} aria-pressed={on} onClick={() => edgeTypes.toggle(type)}>
                  {type.replace(/_/g, ' ')}
                  <span className="stg-chip__n">{count}</span>
                </button>
              );
            })}
          </span>
        )}
      </div>

      <div className="stg-stage">
      <div
        className={zoom.zoom === null ? 'stg-scroll' : 'stg-scroll stg-scroll--zoomed'}
        ref={scrollRef}
        tabIndex={0}
        role="group"
        aria-label={`Graph canvas. Plus and minus zoom, zero resets${zoom.maximised ? ', Escape exits full screen' : ''}.`}
        {...zoom.scrollerProps}
      >
        <svg
          className={`stg-svg${hoverRoot ? ' stg-svg--hl' : ''}${graphView === 'team' ? ' stg-svg--team' : ''}`}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          /* Natural size at most, never below the readable floor; past that the card scrolls sideways. */
          style={
            zoom.zoom === null
              ? { maxWidth: Math.round(layout.width * (tall ? MAX_FILL_SCALE : 1)), minWidth: Math.round(layout.width * MIN_SCALE) }
              : /* Zoomed: exactly this size, scrolling both ways past the box. */
                { width: Math.round(layout.width * zoom.zoom), maxWidth: 'none', minWidth: 0 }
          }
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
            const cls = `stg-e stg-e--${e.family}${e.cross ? ' stg-e--cross' : ''}${e.exited ? ' stg-e--exited' : ''}${st}${lit(e.rootIds)}`;
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
                    className={`stg-el stg-el--${e.family}${st}${lit(e.rootIds)}`}
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
            const dim = !all && !mask.inView.has(node.id) ? 'stg-dim' : '';
            const hl = hoverRoot ? (node.rootIds.includes(hoverRoot) ? 'stg-on' : 'stg-off-hl') : '';
            const cls = nodeClass(node, [
              dim,
              hl,
              selectedId === node.id ? 'stg-selected' : '',
              landed?.has(node.id) ? 'stg-flash' : '',
              onPick ? 'stg-n--pickable' : '',
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
                {...(onMenu
                  ? {
                      onContextMenu: (ev: MouseEvent<SVGGElement>) => {
                        ev.preventDefault();
                        ev.stopPropagation();
                        menu(node, ev.currentTarget);
                      },
                    }
                  : {})}
                aria-current={selectedId === node.id ? true : undefined}
                onMouseEnter={isRoot ? () => setHoverRoot(node.id) : undefined}
                onMouseLeave={isRoot ? () => setHoverRoot(null) : undefined}
              >
                <title>{nodeTip(node)}</title>
                {selectedId === node.id && <SelectionRing node={node} />}
                {node.capsule ? <Capsule node={node} /> : node.initials !== null ? <Teammate node={node} /> : <Disc node={node} />}
                {onMenu && <MoreButton node={node} onPress={(el) => menu(node, el)} />}
              </g>
            );
          })}

          {all &&
            layout.notes.map((n) => (
              <text key={`${n.x}-${n.y}`} className="stg-note" x={n.x} y={n.y} textAnchor="middle">
                {n.text}
              </text>
            ))}
          {empty && (
            <text className="stg-note" x={layout.width / 2} y={layout.height - 24} textAnchor="middle">
              Nothing is in this story yet. Put a task in and everything connected to it follows.
            </text>
          )}
        </svg>
      </div>
      <div className="stg-view" role="group" aria-label="Graph view controls">
        <IconBtn label="Zoom out" onClick={() => zoom.zoomBy(0.8)}>
          <VectorIcon paths={ICON_ZOOM_OUT} size={13} />
        </IconBtn>
        <button
          type="button"
          className="stg-view__pct"
          title="Reset zoom"
          aria-label={`Zoom ${Math.round(zoom.shown * 100)}%, reset`}
          disabled={zoom.zoom === null}
          onClick={zoom.reset}
        >
          {Math.round(zoom.shown * 100)}%
        </button>
        <IconBtn label="Zoom in" onClick={() => zoom.zoomBy(1.25)}>
          <VectorIcon paths={ICON_ZOOM_IN} size={13} />
        </IconBtn>
        <IconBtn label="Fit to view" onClick={zoom.fit}>
          <VectorIcon paths={ICON_FIT} size={13} />
        </IconBtn>
        <IconBtn label={zoom.maximised ? 'Exit full screen' : 'Full screen'} pressed={zoom.maximised} onClick={zoom.toggleMax}>
          <VectorIcon paths={zoom.maximised ? ICON_COLLAPSE : ICON_EXPAND} size={13} />
        </IconBtn>
      </div>
      </div>

      <div className="stg-legend">
        <span className="stg-legend__grp">nodes</span>
        <span><i className="stg-sw stg-sw--root" />root</span>
        <span><i className="stg-sw stg-sw--done" />done</span>
        <span><i className="stg-sw stg-sw--working" />working</span>
        <span><i className="stg-sw stg-sw--blocked" />blocked</span>
        <span><i className="stg-sw" />to do · other kinds</span>
        <span><i className="stg-sw stg-sw--cap" />live capsule: task + session + teammate</span>
        <span><i className="stg-sw stg-sw--halo" />active in the last hour</span>
        <span><i className="stg-sw stg-sw--tm" />teammate</span>
        <span><i className="stg-sw stg-sw--child" />child story</span>
        <span className="stg-legend__sep" />
        <span className="stg-legend__grp">edges</span>
        {(Object.entries(EDGE_LEGEND) as Array<[StoryEdgeFamily, string]>).map(([fam, label]) => (
          <span key={fam}>
            <i className="stg-ln" style={{ borderTopColor: FAMILY_TOKEN[fam] }} />
            {label}
          </span>
        ))}
        <span><i className="stg-ln stg-ln--cross" />across roots</span>
      </div>
    </section>
  );
}
