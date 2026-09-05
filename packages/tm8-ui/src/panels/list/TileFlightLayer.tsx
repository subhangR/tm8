/**
 * The layer a message actually flies on.
 *
 * ONE OVERLAY, NOT A NODE PER TILE. The layer is a single out-of-flow child of
 * the tree, so nothing it draws can change a row's height or position. That is
 * the same constraint the hairline sweep was built under and for the same
 * reason: a background agent sending a message must never make the list the
 * viewer is reading move under the cursor.
 *
 * MEASURED IN THE TREE'S OWN SPACE, WHICH IS WHY SCROLLING IS FREE. Every
 * point is stored relative to the tree container, and the container scrolls
 * WITH its rows — so a flight measured before a scroll is still correct after
 * one, with no listener and no re-measure. Only a re-layout (a subtree opening
 * mid-flight) can stale a path, and a glyph that lands a row off for the
 * remaining half second is a better outcome than a scroll handler that runs on
 * every wheel event of a list nobody is sending messages in.
 *
 * A FLIGHT NEEDS TWO ENDS. When either end is not on screen — another space,
 * another page, a collapsed subtree that absorbed it — this draws nothing at
 * all and the endpoint glow already on the standing-in row is the whole
 * report. Inventing a takeoff point off the edge of the list would animate a
 * sender the viewer cannot see, which says less than the glow does.
 */
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

import { VectorIcon } from '../../kit/VectorIcon';
import { KIND_ART } from '../../domain/kind-art';
import { SESSION_PULSE_KIND, type SessionPulseKind } from '../../session-graph/pulse-vocabulary';
import { flightPath, flightVariables, type FlightPath, type FlightPoint } from './tile-flight';

/** One arrival with both ends standing on a row this tree is drawing. */
export interface ResolvedFlight {
  key: string;
  kind: SessionPulseKind;
  outcome?: 'exited' | 'failed';
  fromRowId: string;
  toRowId: string;
}

/**
 * What flies, per kind — matched to the SVG graph's markers so the two
 * surfaces stay one vocabulary (`session-graph.css`: filled, open, barred).
 *
 * The message glyph is the HOUSE speech bubble, reused verbatim from
 * `KIND_ART.message`. Not an envelope, and the reason is written where the
 * artwork lives: "a tm8 message is a line in a conversation; an envelope
 * promises mail, which is a different product." The object in flight is the
 * same mark the message entity wears when it lands.
 */
const FLIGHT_ART: Record<SessionPulseKind, readonly string[]> = {
  [SESSION_PULSE_KIND.message]: KIND_ART.message,
  /** An open chevron on a shaft — the delegation baton, handed forward. */
  [SESSION_PULSE_KIND.delegation]: ['M2.8 8h7.6', 'M9.2 4.6 12.6 8l-3.4 3.4'],
  /** An arrow returning INTO a bar: a result coming home, and stopping. */
  [SESSION_PULSE_KIND.completion]: ['M13.2 4.4v7.2', 'M11.9 8H3.4', 'M6.8 4.6 3.4 8l3.4 3.4'],
};

const EMPTY_PATHS: ReadonlyMap<string, FlightPath> = new Map();

/**
 * The tile a row flies from or to.
 *
 * `data-session-node` is the session tile's own long-standing identity
 * attribute (`MaestroSessionTile`), and `data-flight-anchor` covers the
 * default anatomy. Reading an attribute the tile already publishes is what
 * keeps this layer from needing a ref registry threaded through every row.
 *
 * `.lp__branch >` IS LOad-BEARING, and a bare attribute match is a bug. An id
 * can appear TWICE in one tree: a row with its Connections relation open
 * renders that relation's rows as REAL tiles (`relatedBlock`), and a session
 * listed there publishes the same `data-session-node` as its own top-level
 * row. `querySelector` takes the first in document order, so an unqualified
 * match can aim a flight at a nested copy inside some unrelated row's panel.
 * Only the tree's own rows are a direct child of a `.lp__branch`; every
 * related copy sits deeper, inside the group wrapper.
 */
export function findAnchor(host: ParentNode, rowId: string): HTMLElement | null {
  const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(rowId)
    : rowId.replace(/["\\]/g, '\\$&');
  const node = host.querySelector(
    `.lp__branch > [data-session-node="${escaped}"], .lp__branch > [data-flight-anchor="${escaped}"]`,
  );
  return node instanceof HTMLElement ? node : null;
}

function anchorRect(host: HTMLElement, rowId: string): DOMRect | null {
  return findAnchor(host, rowId)?.getBoundingClientRect() ?? null;
}

/**
 * Where on a tile the glyph touches down: the row's vertical middle, inset
 * from its leading edge over the disclosure caret and status mark.
 *
 * The inset is capped at half the tile so a very narrow panel cannot push the
 * anchor past the tile's own trailing edge.
 */
const ANCHOR_INSET_PX = 26;

function anchorPoint(host: HTMLElement, hostRect: DOMRect, rowId: string): FlightPoint | null {
  const rect = anchorRect(host, rowId);
  if (rect === null) return null;
  return {
    x: rect.left - hostRect.left + Math.min(ANCHOR_INSET_PX, rect.width / 2),
    y: rect.top - hostRect.top + rect.height / 2,
  };
}

export function TileFlightLayer({ flights }: { flights: readonly ResolvedFlight[] }) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const [paths, setPaths] = useState<ReadonlyMap<string, FlightPath>>(EMPTY_PATHS);

  /**
   * LAYOUT effect, not a plain one: the measurement has to happen in the same
   * frame the rows were painted in, or the first flight of a burst launches
   * from wherever the list was BEFORE the arriving row was inserted.
   */
  useLayoutEffect(() => {
    const layer = layerRef.current;
    const host = layer?.parentElement ?? null;
    if (layer === null || host === null || flights.length === 0) {
      setPaths((held) => (held.size === 0 ? held : EMPTY_PATHS));
      return;
    }
    const hostRect = host.getBoundingClientRect();
    const next = new Map<string, FlightPath>();
    for (const flight of flights) {
      const from = anchorPoint(host, hostRect, flight.fromRowId);
      const to = anchorPoint(host, hostRect, flight.toRowId);
      if (from === null || to === null) continue;
      next.set(flight.key, flightPath(from, to));
    }
    setPaths(next.size === 0 ? EMPTY_PATHS : next);
  }, [flights]);

  return (
    <div
      ref={layerRef}
      className="lp__flights"
      data-testid="tile-flights"
      /* Decoration. The arrival is already announced by the rows it changes;
         narrating the same event from a flying mark would say it twice. */
      aria-hidden
    >
      {flights.map((flight) => {
        const path = paths.get(flight.key);
        if (path === undefined) return null;
        return (
          <span
            key={flight.key}
            className="lp__flight"
            data-flight-kind={flight.kind}
            data-flight-outcome={flight.outcome}
            data-flight-from={flight.fromRowId}
            data-flight-to={flight.toRowId}
            style={flightVariables(path) as CSSProperties}
          >
            <span className="lp__flight__glyph">
              <VectorIcon
                paths={FLIGHT_ART[flight.kind]}
                size={13}
                strokeWidth={1.5}
                filled={flight.kind === SESSION_PULSE_KIND.message}
              />
            </span>
          </span>
        );
      })}
    </div>
  );
}
