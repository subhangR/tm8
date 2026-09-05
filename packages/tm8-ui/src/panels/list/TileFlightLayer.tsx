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
 * A FLIGHT NEEDS TWO ENDS ON TWO DIFFERENT ROWS. A collapsed subtree does not
 * by itself suppress anything: the route absorbs that endpoint onto its
 * nearest visible ancestor and the glyph flies to the STAND-IN, which is the
 * honest reading of "it went in there". Only two cases draw nothing — an end
 * with no stand-in at all (another space, another list page), and both ends
 * absorbing onto the SAME row, where a glyph orbiting one tile would say less
 * than that row's own endpoint glow already does. Inventing a takeoff point
 * off the edge of the list would animate a sender the viewer cannot see.
 *
 * AND IT NEVER STARTS A FLIGHT THAT CANNOT FINISH. A pulse is evicted on a
 * fixed timer from its arrival (`PULSE_TTL_MS`), so a glyph launched late is
 * deleted in open air between two tiles. `tile-flight.ts`'s duration clamp
 * only prevents that for a flight that starts AT arrival, and several things
 * start one later: the viewer opens a subtree the pulse was sitting in, rows
 * arrive after the pulse did, or this list is navigated away from and back
 * while the pulse is still retained. So the decision is made on the pulse's
 * OWN AGE — `at`, stamped by the deriving hook on the same clock as the
 * eviction timer — and not on anything this component can observe.
 *
 * THAT DISTINCTION IS THE WHOLE FIX, and the first attempt got it wrong. It
 * inferred age from this layer's own render history, which is correct within
 * one mount and worthless across an unmount: `useMessagePulses` lives above
 * the route surfaces and keeps retaining, so a remounted layer saw a
 * two-second-old pulse with empty refs and read it as brand new. Component
 * -local history cannot prove event age. (Both the defect and its remedy found
 * in review by GPT 5.6 Sol on PR #591.)
 *
 * ALREADY AIRBORNE IS EXEMPT. Once a glyph is in the air its remaining budget
 * shrinks every frame, and re-checking would abort a perfectly good flight the
 * instant the tree re-aimed it. A flight is judged once, at launch.
 *
 * AIRBORNE MEANS STILL FLYING, NOT MERELY LAUNCHED — a distinction that cost a
 * bug (PR #591 review). "Was in the air last render" holds until the pulse is
 * EVICTED, but the animation ends after its own duration, so a key that had
 * already landed still counted as exempt. Re-aiming such a key writes a longer
 * `--lp-flight-duration` onto the same element, and Chromium RESURRECTS the
 * finished animation: the glyph pops back into view near the destination and
 * flies again. So each launch records when it happened and how long it runs,
 * and a key past that point is never re-measured or relaunched in this mount.
 * A re-aim of a live flight updates the duration it will actually end on,
 * because changing `animation-duration` mid-run re-times the whole animation
 * rather than extending it from now.
 */
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';

import { VectorIcon } from '../../kit/VectorIcon';
import { KIND_ART } from '../../domain/kind-art';
import { SESSION_PULSE_KIND, type SessionPulseKind } from '../../session-graph/pulse-vocabulary';
import { flightPath, flightVariables, type FlightPath, type FlightPoint } from './tile-flight';
import { PULSE_TTL_MS } from './useMessagePulses';

/** One arrival with both ends standing on a row this tree is drawing. */
export interface ResolvedFlight {
  key: string;
  kind: SessionPulseKind;
  outcome?: 'exited' | 'failed';
  fromRowId: string;
  toRowId: string;
  /** When the arrival was derived. Absent means "assume fresh" — see `at`. */
  at?: number;
}

/**
 * What flies, per kind — matched to the SVG graph's markers so the two
 * surfaces stay one vocabulary (`session-graph.css`: filled, open, barred).
 *
 * The message glyph is the HOUSE speech bubble — the same PATH DATA as
 * `KIND_ART.message`, reused verbatim. Not an envelope, and the reason is
 * written where that artwork lives: "a tm8 message is a line in a
 * conversation; an envelope promises mail, which is a different product."
 *
 * SAME GEOMETRY, DIFFERENT INK, and the difference is deliberate rather than
 * an oversight (raised in review of PR #591). Kind art is authored stroked and
 * `kind-art.ts` says it must stay that way, because a filled mark reads as
 * "selected" beside stroked ones in a badge row. This is not a badge row: a
 * 13px outline crossing tiles of every state — selected, live, hovered — turns
 * to mud, and the SVG graph's own message marker is filled for the same reason
 * (`session-graph.css`, `.sg-pulse-arrow--message`). So the flight fills, and
 * the claim it makes is that this is the same SHAPE, not the same rendering.
 */
const FLIGHT_ART: Record<SessionPulseKind, readonly string[]> = {
  [SESSION_PULSE_KIND.message]: KIND_ART.message,
  /** An open chevron on a shaft — the delegation baton, handed forward. */
  [SESSION_PULSE_KIND.delegation]: ['M2.8 8h7.6', 'M9.2 4.6 12.6 8l-3.4 3.4'],
  /** An arrow returning INTO a bar: a result coming home, and stopping. */
  [SESSION_PULSE_KIND.completion]: ['M13.2 4.4v7.2', 'M11.9 8H3.4', 'M6.8 4.6 3.4 8l3.4 3.4'],
};

/** One launched glyph: when it started, and the duration it will finish on. */
interface Launched {
  at: number;
  durationMs: number;
}

const EMPTY_PATHS: ReadonlyMap<string, FlightPath> = new Map();
const EMPTY_LAUNCHED: ReadonlyMap<string, Launched> = new Map();

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

export function TileFlightLayer({
  flights,
}: {
  flights: readonly ResolvedFlight[];
}) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const [paths, setPaths] = useState<ReadonlyMap<string, FlightPath>>(EMPTY_PATHS);
  /**
   * What each launched key is doing: when it started, and the duration it will
   * finish on. Survives nothing but this mount, which is all it has to — it
   * exists only to keep a live flight from being re-judged mid-air, and a
   * remount ends that flight anyway.
   */
  const airborne = useRef<ReadonlyMap<string, Launched>>(EMPTY_LAUNCHED);

  /**
   * LAYOUT effect, not a plain one: the measurement has to happen in the same
   * frame the rows were painted in, or the first flight of a burst launches
   * from wherever the list was BEFORE the arriving row was inserted.
   */
  useLayoutEffect(() => {
    const layer = layerRef.current;
    const host = layer?.parentElement ?? null;
    const now = Date.now();
    /**
     * Launch records carried forward, minus any older than the retention
     * window — past that the pulse itself is gone and the key can never come
     * back, so the map stays bounded without needing the current key set.
     *
     * CARRIED, NOT CLEARED, and the difference is a defect: dropping a landed
     * flight from `paths` also dropped its record, so the very next render saw
     * an unknown key with pulse budget left and launched it all over again.
     * Landed has to STAY landed for as long as the pulse exists.
     */
    const remembered = new Map<string, Launched>();
    for (const [key, entry] of airborne.current) {
      if (now - entry.at < PULSE_TTL_MS) remembered.set(key, entry);
    }

    if (layer === null || host === null || flights.length === 0) {
      airborne.current = remembered.size === 0 ? EMPTY_LAUNCHED : remembered;
      setPaths((held) => (held.size === 0 ? held : EMPTY_PATHS));
      return;
    }
    const hostRect = host.getBoundingClientRect();
    const next = new Map<string, FlightPath>();
    const nowFlying = new Map<string, Launched>(remembered);
    for (const flight of flights) {
      const from = anchorPoint(host, hostRect, flight.fromRowId);
      const to = anchorPoint(host, hostRect, flight.toRowId);
      if (from === null || to === null) continue;
      const path = flightPath(from, to);
      const launched = remembered.get(flight.key);
      if (launched === undefined) {
        // A LAUNCH THAT CANNOT LAND, REFUSED — see `at` on the pulse.
        const spent = flight.at === undefined ? 0 : Math.max(0, now - flight.at);
        if (spent + path.durationMs > PULSE_TTL_MS) continue;
        next.set(flight.key, path);
        nowFlying.set(flight.key, { at: now, durationMs: path.durationMs });
        continue;
      }
      // ALREADY LANDED: dropped, never re-aimed, and its record KEPT so it
      // cannot be relaunched later. Writing a longer duration onto its element
      // would restart the finished animation and fly the glyph a second time.
      // Unmounting it is invisible — it faded to nothing at the end of its
      // own animation.
      if (now - launched.at >= launched.durationMs) continue;
      // STILL FLYING: re-aimed and re-measured, keeping its original start.
      // The duration is the NEW one because changing `animation-duration`
      // mid-run re-times the animation rather than extending it from now.
      next.set(flight.key, path);
      nowFlying.set(flight.key, { at: launched.at, durationMs: path.durationMs });
    }
    airborne.current = nowFlying.size === 0 ? EMPTY_LAUNCHED : nowFlying;
    setPaths(next.size === 0 ? EMPTY_PATHS : next);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `flights` alone;
    // the launch bookkeeping is a ref precisely so it cannot retrigger this.
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
