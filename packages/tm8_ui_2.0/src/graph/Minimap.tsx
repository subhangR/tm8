/**
 * Minimap — the corner overview for the ◉ Graph canvas (ATELIER paper-and-ink;
 * tokens only, hex banned outside tokens.css). A scaled SVG of the whole
 * layout: nodes as small rects, the visible viewport as a brass hairline
 * frame on a border-only surface. Clicking anywhere jumps the canvas there; the whole map is one
 * focusable control (Enter/Space centers).
 *
 * Tone is color + WORD-in-title: each node rect carries a `title` naming its
 * tone, so blocked/live is never carried by color alone (the status law
 * applied to a 4px rect).
 *
 * Scale is per-axis so the overview fills the box exactly; the same scaleX/
 * scaleY invert a click back into CANVAS-space coordinates for onJump — no
 * distortion in the round trip.
 */
import { useRef } from 'react';
import './minimap.css';

export interface MinimapNode {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  tone?: 'default' | 'blocked' | 'live';
}

export interface MinimapProps {
  /** Canvas-space dimensions the overview represents. */
  width: number;
  height: number;
  nodes: readonly MinimapNode[];
  /** The visible window in canvas space, or null when unknown. */
  viewport: { x: number; y: number; w: number; h: number } | null;
  /** Called with the CANVAS-space coordinates of the jump target. */
  onJump(cx: number, cy: number): void;
}

const MAP_W = 180;
const MAP_H_MIN = 60;
const MAP_H_MAX = 160;

const TONE_TITLE: Record<NonNullable<MinimapNode['tone']>, string> = {
  default: 'node',
  blocked: 'blocked',
  live: 'live',
};

export function Minimap(props: MinimapProps) {
  const { width, height, nodes, viewport, onJump } = props;
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Guard the degenerate canvas — a zero dimension would divide to Infinity.
  const safeW = width > 0 ? width : 1;
  const safeH = height > 0 ? height : 1;

  const mapH = Math.min(MAP_H_MAX, Math.max(MAP_H_MIN, (MAP_W * safeH) / safeW));
  const scaleX = MAP_W / safeW;
  const scaleY = mapH / safeH;

  const jumpToCenter = () => onJump(safeW / 2, safeH / 2);

  return (
    <svg
      ref={svgRef}
      className="gv-minimap"
      width={MAP_W}
      height={mapH}
      viewBox={`0 0 ${MAP_W} ${mapH}`}
      role="button"
      tabIndex={0}
      aria-label="Graph overview — click to jump"
      onClick={(event) => {
        const rect = svgRef.current?.getBoundingClientRect();
        if (!rect) return;
        const cx = (event.clientX - rect.left) / scaleX;
        const cy = (event.clientY - rect.top) / scaleY;
        onJump(cx, cy);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          jumpToCenter();
        }
      }}
    >
      {nodes.map((node) => {
        const tone = node.tone ?? 'default';
        return (
          <rect
            key={node.id}
            className={`gv-minimap__node gv-minimap__node--${tone}`}
            x={node.x * scaleX}
            y={node.y * scaleY}
            width={Math.max(1, node.w * scaleX)}
            height={Math.max(1, node.h * scaleY)}
            rx={1}
          >
            <title>{TONE_TITLE[tone]}</title>
          </rect>
        );
      })}
      {viewport && (
        <rect
          className="gv-minimap__viewport"
          x={viewport.x * scaleX}
          y={viewport.y * scaleY}
          width={viewport.w * scaleX}
          height={viewport.h * scaleY}
        />
      )}
    </svg>
  );
}
