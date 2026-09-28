/**
 * THE CONSTELLATION — a kind and its neighbours, drawn as stars on wires.
 *
 * TWO LAYERS, ONE PICTURE. The wires are an SVG (`aria-hidden`): a path per
 * neighbour from the centre, drawn in with a dash-offset animation. The
 * stars are HTML buttons positioned over the same square, so every neighbour
 * is a real control with a real accessible name ("Open help for Docs") and
 * the keyboard reaches all of them in order. A pure-SVG graph would have
 * needed `<foreignObject>` or a `role="button"` on a `<g>`, and both are
 * worse at the one thing that matters here, which is that pressing a star
 * opens that kind's page.
 *
 * LAYOUT is a ring. Spotlit neighbours (an author's `spotlight`, else the
 * ones named by the most edges) sit on an inner ring; the rest on the outer.
 * Angles start at the top and go clockwise, so the first neighbour is at
 * twelve o'clock — the reading order matches the DOM order.
 *
 * MOTION: wires draw in, stars arrive staggered, the centre breathes. Under
 * reduced motion the `--still` class pins all three; the picture is the same.
 */
import { useState, type CSSProperties } from 'react';
import { KindIcon } from '../../domain';
import { useMotion } from './MotionContext';

export interface ConstellationNode {
  /** A kind, or `*` for "any entity". */
  readonly kind: string;
  readonly label: string;
  /** The verbs on the wire, read from the centre's side: "Assigned to". */
  readonly verbs: readonly string[];
  /** True when this neighbour is reached only through a wildcard endpoint. */
  readonly faint: boolean;
}

export interface ConstellationGraphProps {
  centre: { kind: string; label: string };
  nodes: readonly ConstellationNode[];
  /** Kinds seated on the inner ring, in order. */
  spotlight?: readonly string[] | undefined;
  onPick: (kind: string) => void;
}

const ANY = '*';

interface Placed extends ConstellationNode {
  x: number;
  y: number;
  ring: 'inner' | 'outer';
}

function place(nodes: readonly ConstellationNode[], spotlight: readonly string[]): Placed[] {
  const spot = new Set(spotlight);
  const inner = nodes.filter((node) => spot.has(node.kind));
  const outer = nodes.filter((node) => !spot.has(node.kind));
  const ringOf = (
    ring: readonly ConstellationNode[],
    radius: (index: number) => number,
    tag: 'inner' | 'outer',
    offset: number,
  ) =>
    ring.map((node, index) => {
      const angle = -Math.PI / 2 + offset + (index / Math.max(ring.length, 1)) * Math.PI * 2;
      const r = radius(index);
      return { ...node, x: 50 + Math.cos(angle) * r, y: 50 + Math.sin(angle) * r, ring: tag };
    });
  /* The outer ring is rotated half a step so its stars fall between the inner
     ones, and once it is crowded its stars ALTERNATE between two radii so
     neighbouring labels stop landing on each other. */
  const outerOffset = inner.length > 0 && outer.length > 0 ? Math.PI / Math.max(outer.length, 1) : 0;
  const crowded = outer.length > 8;
  return [
    ...ringOf(inner, () => (outer.length === 0 ? 36 : 27), 'inner', 0),
    ...ringOf(outer, (index) => (crowded ? (index % 2 === 0 ? 41 : 47) : 41), 'outer', outerOffset),
  ];
}

export function ConstellationGraph({ centre, nodes, spotlight = [], onPick }: ConstellationGraphProps) {
  const { reduced } = useMotion();
  const [hot, setHot] = useState<string | null>(null);
  const placed = place(nodes, spotlight);
  const cls = ['eh-constellation', reduced ? 'eh-constellation--still' : ''].filter(Boolean).join(' ');

  return (
    <div className={cls} data-testid="constellation-graph">
      <svg className="eh-constellation__wires" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" aria-hidden>
        {placed.map((node, index) => (
          <path
            key={node.kind}
            className={[
              'eh-wire',
              node.faint ? 'eh-wire--faint' : '',
              hot === node.kind ? 'eh-wire--hot' : '',
              hot !== null && hot !== node.kind ? 'eh-wire--dim' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            d={`M50 50 L${node.x.toFixed(2)} ${node.y.toFixed(2)}`}
            style={{ '--eh-delay': `${120 + index * 70}ms` } as CSSProperties}
          />
        ))}
        <circle className="eh-constellation__halo" cx="50" cy="50" r="9" />
      </svg>

      {placed.map((node, index) => {
        /* The verb rides the wire near its STAR, not the centre — the centre
           is where every wire meets and where no label can be read. Faint
           (wildcard-only) wires are labelled only while hot. */
        const t = node.ring === 'inner' ? 0.62 : 0.72;
        const midX = 50 + (node.x - 50) * t;
        const midY = 50 + (node.y - 50) * t;
        const verbs = (node.verbs[0] ?? '') + (node.verbs.length > 1 ? ` +${node.verbs.length - 1}` : '');
        if (node.faint && hot !== node.kind) return null;
        return (
          <span
            key={`${node.kind}-label`}
            className={[
              'eh-wire__label',
              hot === node.kind ? 'eh-wire__label--hot' : '',
              hot !== null && hot !== node.kind ? 'eh-wire__label--dim' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            style={{ left: `${midX}%`, top: `${midY}%`, '--eh-delay': `${260 + index * 70}ms` } as CSSProperties}
            aria-hidden
          >
            {verbs}
          </span>
        );
      })}

      <div className="eh-node eh-node--centre" style={{ left: '50%', top: '50%' }} aria-hidden>
        <span className="eh-node__mark">
          <KindIcon kind={centre.kind} size={18} />
        </span>
        <span className="eh-node__label">{centre.label}</span>
      </div>

      {placed.map((node, index) => {
        const any = node.kind === ANY;
        return (
          <button
            key={node.kind}
            type="button"
            className={[
              'eh-node',
              `eh-node--${node.ring}`,
              node.faint ? 'eh-node--faint' : '',
              any ? 'eh-node--any' : '',
              hot !== null && hot !== node.kind ? 'eh-node--dim' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            style={{ left: `${node.x}%`, top: `${node.y}%`, '--eh-delay': `${200 + index * 70}ms` } as CSSProperties}
            aria-label={any ? 'Any entity kind — no page to open' : `Open help for ${node.label}`}
            aria-disabled={any ? 'true' : undefined}
            title={`${centre.label} — ${node.verbs.join(', ')} — ${node.label}`}
            onClick={any ? (event) => event.preventDefault() : () => onPick(node.kind)}
            onMouseEnter={() => setHot(node.kind)}
            onMouseLeave={() => setHot(null)}
            onFocus={() => setHot(node.kind)}
            onBlur={() => setHot(null)}
            data-kind={node.kind}
          >
            <span className="eh-node__mark">{any ? <span aria-hidden>✱</span> : <KindIcon kind={node.kind} size={15} />}</span>
            <span className="eh-node__label">{node.label}</span>
          </button>
        );
      })}
    </div>
  );
}
