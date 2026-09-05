/**
 * Flight geometry — the arc a message takes ACROSS the session tiles.
 *
 * WHY THIS EXISTS. The tree already brightens its nesting hairlines when
 * traffic passes (`panels.css` "session pulse"), and that treatment is honest
 * but nearly invisible: it is a 1px overlay on a 1px line, in a column of
 * 29px rows, and a viewer watching the list simply does not see it. Reported
 * as "not visible properly", and it is.
 *
 * So a DISCRETE OBJECT now makes the trip. A small glyph leaves the sender's
 * tile, arcs over the tiles between, and lands on the recipient's tile. An
 * object that moves is seen; a line that changes brightness is not.
 *
 * THE ARC IS DRAWN, NOT ROUTED. The hairline sweep deliberately follows the
 * spawn tree (see the header of `message-pulse.ts`) because lighting a wire
 * that does not exist would claim a channel the tree does not have. A flying
 * glyph makes no such claim — it is plainly ABOVE the tree, not in it — so it
 * takes the short way: one quadratic Bézier from tile to tile. The wire sweep
 * underneath is unchanged and still tells the routing story.
 *
 * SAMPLED, NOT `offset-path`. The curve is emitted as seven points that CSS
 * interpolates as a polyline. `offset-path: path()` would be one declaration,
 * but its coordinates resolve against a reference box whose definition has
 * moved between engine versions, and a wrong reference box parks the glyph in
 * the corner rather than degrading. Seven `translate3d` stops are the same
 * curve to the eye, on a property every engine composites.
 *
 * THE EASING IS IN THE SAMPLING. Points are taken at eased `t`, so the CSS
 * animation runs `linear` and the polyline's own corners never fight a timing
 * function. Ease applied on top of a piecewise path is what makes cheap arc
 * animations stutter at their joints.
 *
 * PURE. No DOM, no clock, no React — two points in, a description out, which
 * is what lets the arc be tested where `getBoundingClientRect` returns zeros.
 */

/** A point in the tree container's own coordinate space, in CSS pixels. */
export interface FlightPoint {
  x: number;
  y: number;
}

export interface FlightPath {
  /** Sampled stops, first at the sender and last at the recipient. */
  points: readonly FlightPoint[];
  /** How long the trip takes; scaled by distance so short hops are not slow. */
  durationMs: number;
  /** Straight-line separation of the endpoints, before the bow. */
  distance: number;
}

/**
 * How far the arc bows off the straight line, as a fraction of its length.
 * Enough to read as flight rather than as a slide; little enough that a hop
 * between adjacent rows does not loop out into the next panel.
 */
const BOW_RATIO = 0.24;
const BOW_MIN_PX = 22;
const BOW_MAX_PX = 92;

/** Six segments — seven stops. Past this the eye cannot tell it from a curve. */
export const FLIGHT_SAMPLES = 6;

const DURATION_BASE_MS = 380;
const DURATION_PER_PX = 1.1;
const DURATION_MIN_MS = 560;
/**
 * The ceiling is below `useMessagePulses`' 2200ms TTL on purpose: an arrival
 * that stops existing mid-flight would delete the glyph in open air.
 */
const DURATION_MAX_MS = 1_450;

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** Cubic in-out. The glyph leaves gently, crosses fast, and settles. */
function ease(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2;
}

function quadratic(p0: FlightPoint, c: FlightPoint, p1: FlightPoint, t: number): FlightPoint {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x,
    y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y,
  };
}

/**
 * The control point that makes the curve pass through `mid + bow` at t=0.5.
 *
 * ALWAYS BOWS RIGHT, and that is a containment decision rather than a taste
 * one. Tiles are full-width rows, so a flight between them is close to
 * vertical and its perpendicular is close to horizontal. Bowing by the
 * direction of travel would send every downward flight LEFT — off the leading
 * edge of the tree and under the panel's rail, where it is clipped. Bowing
 * right sends it into the tile's own body, which is always there to fly over.
 */
function controlPoint(from: FlightPoint, to: FlightPoint): FlightPoint {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  // A degenerate flight (both endpoints absorbed onto one row) still needs a
  // direction, or the glyph would sit still and read as a stuck badge.
  const normal = length === 0 ? { x: 1, y: 0 } : { x: -dy / length, y: dx / length };
  const rightward = normal.x < 0 ? { x: -normal.x, y: -normal.y } : normal;
  const bow = clamp(length * BOW_RATIO, BOW_MIN_PX, BOW_MAX_PX);
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  // B(0.5) = 0.25·P0 + 0.5·C + 0.25·P1, so C = mid + 2·bow lands the apex
  // exactly on `mid + bow` rather than somewhere short of it.
  return { x: mid.x + 2 * rightward.x * bow, y: mid.y + 2 * rightward.y * bow };
}

/** The trip from one tile's anchor to another's. */
export function flightPath(from: FlightPoint, to: FlightPoint): FlightPath {
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  const control = controlPoint(from, to);
  const points: FlightPoint[] = [];
  for (let step = 0; step <= FLIGHT_SAMPLES; step += 1) {
    points.push(quadratic(from, control, to, ease(step / FLIGHT_SAMPLES)));
  }
  return {
    points,
    distance,
    durationMs: Math.round(
      clamp(DURATION_BASE_MS + distance * DURATION_PER_PX, DURATION_MIN_MS, DURATION_MAX_MS),
    ),
  };
}

/**
 * The path as the custom properties the stylesheet's keyframes read.
 *
 * One variable per stop rather than one animation per flight: `@keyframes`
 * cannot be parameterised, but the values it substitutes can, so every flight
 * on screen shares one compositor-friendly rule and differs only in its vars.
 */
export function flightVariables(path: FlightPath): Record<string, string> {
  const vars: Record<string, string> = {
    '--lp-flight-duration': `${path.durationMs}ms`,
  };
  path.points.forEach((point, index) => {
    vars[`--lp-flight-${index}x`] = `${Math.round(point.x * 10) / 10}px`;
    vars[`--lp-flight-${index}y`] = `${Math.round(point.y * 10) / 10}px`;
  });
  return vars;
}
