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
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { EntityId } from '@tm8/contract';
import { getKind } from '../domain';
import { CARD_H, CARD_W } from '../chat-home/induced-layout';
import type { BlueprintCard, BlueprintLine, BlueprintView } from './blueprint-model';

/**
 * THE VIEWPORT, over the placement's TRUE box (`view.bounds`).
 *
 * `z` is a zoom factor and `x`/`y` are a pan OFFSET FROM that box's corner —
 * deliberately not absolute canvas coordinates, so `FIT` is the same three
 * numbers for every blueprint and "reset" needs no measurement. The rendered
 * box is `bounds + offset`, sized `bounds / z`.
 */
interface ViewTransform { z: number; x: number; y: number }
const FIT: ViewTransform = { z: 1, x: 0, y: 0 };
const MIN_Z = 0.25;
const MAX_Z = 6;
const ZOOM_STEP = 1.2;

const clampZoom = (z: number) => Math.min(MAX_Z, Math.max(MIN_Z, z));

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
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [transform, setTransform] = useState<ViewTransform>(FIT);
  const drag = useRef<{ pointerId: number; x: number; y: number; from: ViewTransform } | null>(null);
  const [panning, setPanning] = useState(false);
  const bounds = view.bounds;

  /* A DIFFERENT BLUEPRINT GETS A FRESH FIT, the same one does not.
     Keying the reset on the BOX rather than on the view object matters: the
     host re-folds `view` on every live `entity.upsert`, so resetting on
     identity would yank a viewer's pan away mid-edit — which is when they are
     most likely to be looking at one corner on purpose. The box only moves
     when the drawing actually changes shape. */
  const boxKey = `${bounds.minX}:${bounds.minY}:${bounds.width}:${bounds.height}`;
  const lastBoxRef = useRef(boxKey);
  useEffect(() => {
    if (lastBoxRef.current === boxKey) return;
    lastBoxRef.current = boxKey;
    setTransform(FIT);
  }, [boxKey]);

  const box = useMemo(
    () => ({
      x: bounds.minX + transform.x,
      y: bounds.minY + transform.y,
      w: bounds.width / transform.z,
      h: bounds.height / transform.z,
    }),
    [bounds, transform],
  );

  /* Client px → canvas units, folding in what `xMidYMid meet` did: the drawn
     box is centred in whichever axis has slack, so the letterboxing offset is
     part of the conversion. Reading it back off the element is what keeps
     zoom-about-cursor honest at any pane width. */
  const toCanvas = useCallback(
    (clientX: number, clientY: number) => {
      const node = svgRef.current;
      const rect = node?.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) return null;
      const scale = Math.min(rect.width / box.w, rect.height / box.h);
      if (!Number.isFinite(scale) || scale <= 0) return null;
      const offX = (rect.width - box.w * scale) / 2;
      const offY = (rect.height - box.h * scale) / 2;
      return {
        x: box.x + (clientX - rect.left - offX) / scale,
        y: box.y + (clientY - rect.top - offY) / scale,
        scale,
      };
    },
    [box],
  );

  /** Zoom holding one canvas point still — the point under the cursor. */
  const zoomAbout = useCallback(
    (factor: number, at?: { x: number; y: number }) => {
      setTransform((current) => {
        const z = clampZoom(current.z * factor);
        if (z === current.z) return current;
        const wasW = bounds.width / current.z;
        const wasH = bounds.height / current.z;
        const wasX = bounds.minX + current.x;
        const wasY = bounds.minY + current.y;
        /* No anchor (a button press) holds the CENTRE, which is what a
           zoom control is expected to do. */
        const anchor = at ?? { x: wasX + wasW / 2, y: wasY + wasH / 2 };
        const fx = wasW === 0 ? 0.5 : (anchor.x - wasX) / wasW;
        const fy = wasH === 0 ? 0.5 : (anchor.y - wasY) / wasH;
        return {
          z,
          x: anchor.x - fx * (bounds.width / z) - bounds.minX,
          y: anchor.y - fy * (bounds.height / z) - bounds.minY,
        };
      });
    },
    [bounds],
  );

  /* NON-PASSIVE, and it has to be: React's `onWheel` is registered passive, so
     `preventDefault` there is ignored and the wheel scrolls the pane behind
     the canvas instead of zooming it. */
  useEffect(() => {
    const node = svgRef.current;
    if (!node) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const at = toCanvas(event.clientX, event.clientY);
      zoomAbout(event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, at ?? undefined);
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [toCanvas, zoomAbout]);

  const stopPan = (event: PointerEvent<SVGSVGElement>) => {
    if (!drag.current || drag.current.pointerId !== event.pointerId) return;
    drag.current = null;
    setPanning(false);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  if (view.cards.length === 0) {
    return (
      <p className="crf-empty" data-testid="crf-empty">
        An empty blueprint. Ask the craft chat to sketch nodes and edges, and they render here live.
      </p>
    );
  }

  const atFit = transform.z === FIT.z && transform.x === FIT.x && transform.y === FIT.y;

  return (
    <div className="crf-viewport" data-testid="crf-viewport">
      <svg
        ref={svgRef}
        className="sg-svg crf-svg"
        viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={ariaLabel}
        data-testid="crf-canvas"
        data-panning={panning || undefined}
        onPointerDown={(event) => {
          /* Only the empty canvas pans. A press that lands on a card is that
             card's — dragging from one would make every reference impossible
             to open with a slightly unsteady hand. */
          if (event.button !== 0) return;
          if ((event.target as Element).closest?.('.crf-cell')) return;
          drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, from: transform };
          setPanning(true);
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (!start || start.pointerId !== event.pointerId) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const scale = Math.min(rect.width / box.w, rect.height / box.h);
          if (!Number.isFinite(scale) || scale <= 0) return;
          setTransform({
            z: start.from.z,
            x: start.from.x - (event.clientX - start.x) / scale,
            y: start.from.y - (event.clientY - start.y) / scale,
          });
        }}
        onPointerUp={stopPan}
        onPointerCancel={stopPan}
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
      {/* The controls are the KEYBOARD PATH as much as the mouse one: wheel and
          drag reach neither a keyboard nor a trackpad-averse hand, and a
          viewport you can only leave by reloading is a trap. */}
      <div className="crf-zoom" role="group" aria-label="Blueprint zoom">
        <button
          type="button"
          className="crf-zoom__btn"
          data-testid="crf-zoom-in"
          aria-label="Zoom in"
          title="Zoom in"
          disabled={transform.z >= MAX_Z}
          onClick={() => zoomAbout(ZOOM_STEP)}
        >
          <span aria-hidden>＋</span>
        </button>
        <button
          type="button"
          className="crf-zoom__btn"
          data-testid="crf-zoom-out"
          aria-label="Zoom out"
          title="Zoom out"
          disabled={transform.z <= MIN_Z}
          onClick={() => zoomAbout(1 / ZOOM_STEP)}
        >
          <span aria-hidden>−</span>
        </button>
        <button
          type="button"
          className="crf-zoom__btn crf-zoom__fit"
          data-testid="crf-zoom-fit"
          aria-label="Fit the blueprint to the pane"
          title="Fit the blueprint to the pane"
          disabled={atFit}
          onClick={() => setTransform(FIT)}
        >
          Fit
        </button>
      </div>
    </div>
  );
}

/** One edge of intent: the humanised relation riding the bow's apex. */
function IntentLine({ line, fresh }: { line: BlueprintLine; fresh: boolean }) {
  return (
    <g className={['crf-line', ...(fresh ? ['crf-line--fresh'] : [])].join(' ')}>
      <path className="sg-link" d={`M ${line.x1} ${line.y1} Q ${line.cx} ${line.cy} ${line.x2} ${line.y2}`} />
      <text className="sg-meta crf-line__labels" x={line.lx} y={line.ly} textAnchor="middle">
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
