/**
 * THE MINIMAP (task 01a1090f): the world from above in a HUD corner, turned
 * to match the camera. Revealed land only — the rest stays fog — with the
 * places as shape-coded dots in their tone, the roads, the districts when the
 * world has them, and the player with their facing. A click on clear land
 * sends the player there through the same walk order the scene obeys.
 *
 * Cheap by construction: a 2D canvas, redrawn at most MINIMAP_HZ times a
 * second and only when what it shows has changed. The math is in minimap.ts.
 *
 * Position comes from the save (scene.tsx writes it about once a second), so
 * the marker steps rather than glides; the facing is the direction of the last
 * step unless the host passes `heading`. A live feed needs scene.tsx (follow-up).
 */
import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react';
import { walkTo, type GameControl } from './control';
import type { Palette } from './palette';
import { useStoryGameSave } from './store';
import type { World } from './world';
import {
  MINIMAP_HZ, MINIMAP_SIZE, headingOf, minimapModel, minimapSignature, pickTarget,
  type MinimapDot, type MinimapModel,
} from './minimap';
import './story-game-minimap.css';

export interface MinimapProps {
  world: World;
  storyId: string;
  revealed: ReadonlySet<string>;
  palette: Palette | null;
  control: GameControl;
  open: boolean;
  onToggle: () => void;
  /** After a click on the map has issued a walk order — the host returns focus and leaves the overview. */
  onTravel?: () => void;
  /** Facing in the scene's convention (atan2(dx, dz)); derived from the last step when absent. */
  heading?: number;
  size?: number;
}

const TAU = Math.PI * 2;
export const MINIMAP_ID = 'story-game-minimap';

export function Minimap({ world, storyId, revealed, palette, control, open, onToggle, onTravel, heading, size = MINIMAP_SIZE }: MinimapProps) {
  const save = useStoryGameSave(storyId);
  const [stepHeading, setStepHeading] = useState(0);
  const lastStep = useRef({ x: save.x, z: save.z });
  useEffect(() => {
    const h = headingOf(lastStep.current.x, lastStep.current.z, save.x, save.z);
    lastStep.current = { x: save.x, z: save.z };
    if (h !== null) setStepHeading(h);
  }, [save.x, save.z]);

  const player = { x: save.x, z: save.z, heading: heading ?? stepHeading };
  const dpr = typeof window === 'undefined' ? 1 : Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const canvas = useRef<HTMLCanvasElement>(null);
  const inputs = useRef({ world, revealed, palette, player, dpr, open, size });
  const shown = useRef<{ world: World; revealed: ReadonlySet<string>; palette: Palette; signature: string } | null>(null);
  const lastPaint = useRef(Number.NEGATIVE_INFINITY);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draws = useRef(0);

  /* Paint the latest inputs, unless they are what the canvas already shows. */
  const paint = useCallback(() => {
    timer.current = null;
    const { world, revealed, palette, player, dpr, open, size } = inputs.current;
    const node = canvas.current;
    if (!open || !palette || !node) return;
    const signature = minimapSignature(player, size, dpr);
    const was = shown.current;
    if (was && was.world === world && was.revealed === revealed && was.palette === palette && was.signature === signature) return;
    const ctx = node.getContext('2d');
    if (!ctx) return;
    if (node.width !== size * dpr) { node.width = size * dpr; node.height = size * dpr; }
    drawMinimap(ctx, minimapModel(world, revealed, player, size), palette, dpr);
    shown.current = { world, revealed, palette, signature };
    lastPaint.current = performance.now();
    node.dataset.draws = String(++draws.current);
  }, []);

  /* At most MINIMAP_HZ paints a second: a change inside the window waits for its end, and many changes share one paint. */
  useEffect(() => {
    inputs.current = { world, revealed, palette, player, dpr, open, size };
    if (timer.current !== null) return;
    const wait = lastPaint.current + 1000 / MINIMAP_HZ - performance.now();
    if (wait > 0) timer.current = setTimeout(paint, wait);
    else paint();
    // The player is compared by its fields; the object is new every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world, revealed, palette, player.x, player.z, player.heading, dpr, open, size, paint]);
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);

  const onClick = (e: MouseEvent<HTMLCanvasElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect();
    const scale = rect.width > 0 ? size / rect.width : 1;
    const px = (e.clientX - rect.left) * scale, py = (e.clientY - rect.top) * scale;
    const { world, revealed, player } = inputs.current;
    const target = pickTarget(world, minimapModel(world, revealed, player, size), px, py);
    if (!target) return;
    walkTo(control, target.x, target.z, target.placeId, false);
    onTravel?.();
  };

  return (
    <div className="sgm-minimap" data-open={open ? 'true' : 'false'} data-testid="story-game-minimap">
      <button type="button" className="sgm-btn sgm-minimap__toggle" aria-pressed={open} aria-controls={MINIMAP_ID} onClick={onToggle}>
        {open ? 'Hide minimap' : 'Minimap'} <kbd>N</kbd>
      </button>
      <canvas
        ref={canvas}
        id={MINIMAP_ID}
        className="sgm-minimap__canvas"
        hidden={!open}
        aria-hidden
        title="Click revealed land to walk there"
        style={{ width: size, height: size }}
        onClick={onClick}
      />
    </div>
  );
}

/** Draw a model onto a 2D context. Colours come only from the palette (read from the design tokens). */
export function drawMinimap(ctx: CanvasRenderingContext2D, model: MinimapModel, palette: Palette, dpr: number): void {
  const { size } = model;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);
  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = palette.line2;
  ctx.fillRect(0, 0, size, size);
  /* The island under the fog: where the world ends is known, what is on it is not. */
  ctx.fillStyle = palette.line;
  ctx.beginPath();
  ctx.arc(model.island.px, model.island.py, model.island.r, 0, TAU);
  ctx.fill();

  /* Everything on the land is clipped to the clearings; the fog stays fog. */
  ctx.save();
  ctx.beginPath();
  for (const f of model.fog) { ctx.moveTo(f.px + f.r, f.py); ctx.arc(f.px, f.py, f.r, 0, TAU); }
  ctx.clip();
  ctx.fillStyle = palette.surface;
  ctx.fillRect(0, 0, size, size);
  ctx.globalAlpha = .18;
  for (const d of model.districts) {
    ctx.fillStyle = palette[d.color];
    ctx.beginPath();
    ctx.arc(d.cx, d.cy, d.outer, d.start, d.end);
    ctx.arc(d.cx, d.cy, d.inner, d.end, d.start, true);
    ctx.closePath();
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = palette.ink3;
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const r of model.roads) {
    const [first, ...rest] = r.points;
    if (!first) continue;
    ctx.setLineDash(r.cross ? [3, 3] : []);
    ctx.beginPath();
    ctx.moveTo(first[0], first[1]);
    for (const q of rest) ctx.lineTo(q[0], q[1]);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.restore();

  for (const d of model.dots) if (d.revealed) drawDot(ctx, d, palette);

  const p = model.player;
  ctx.save();
  ctx.translate(p.px, p.py);
  ctx.rotate(p.angle);
  ctx.beginPath();
  ctx.moveTo(7, 0);
  ctx.lineTo(-5, 4.5);
  ctx.lineTo(-2.5, 0);
  ctx.lineTo(-5, -4.5);
  ctx.closePath();
  ctx.fillStyle = palette.brand;
  ctx.strokeStyle = palette.card;
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fill();
  ctx.restore();
}

function drawDot(ctx: CanvasRenderingContext2D, d: MinimapDot, palette: Palette): void {
  const r = d.hub ? 5 : d.root ? 4 : 3;
  ctx.fillStyle = palette[d.color];
  ctx.strokeStyle = palette.card;
  ctx.lineWidth = 1;
  ctx.beginPath();
  switch (d.glyph) {
    case 'hub':
      ctx.arc(d.px, d.py, r, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = palette.ink;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      return;
    case 'ring':
      ctx.arc(d.px, d.py, r + .5, 0, TAU);
      ctx.fillStyle = palette.card;
      ctx.fill();
      ctx.strokeStyle = palette[d.color];
      ctx.lineWidth = 2;
      ctx.stroke();
      return;
    case 'square':
      ctx.rect(d.px - r, d.py - r, r * 2, r * 2);
      break;
    case 'triangle':
      ctx.moveTo(d.px, d.py - r * 1.15);
      ctx.lineTo(d.px + r, d.py + r * .85);
      ctx.lineTo(d.px - r, d.py + r * .85);
      ctx.closePath();
      break;
    case 'diamond':
      ctx.moveTo(d.px, d.py - r * 1.25);
      ctx.lineTo(d.px + r, d.py);
      ctx.lineTo(d.px, d.py + r * 1.25);
      ctx.lineTo(d.px - r, d.py);
      ctx.closePath();
      break;
    case 'circle':
      ctx.arc(d.px, d.py, r, 0, TAU);
      break;
  }
  ctx.fill();
  ctx.stroke();
}
