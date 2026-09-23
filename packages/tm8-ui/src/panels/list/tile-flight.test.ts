import { describe, expect, it } from 'vitest';

import { FLIGHT_SAMPLES, flightPath, flightVariables } from './tile-flight';
import { LAUNCH_WINDOW_MS } from './TileFlightLayer';
import { PULSE_TTL_MS } from './useMessagePulses';

/** Tiles are full-width rows, so a real flight is close to vertical. */
const DOWNWARD = { from: { x: 0, y: 0 }, to: { x: 0, y: 100 } };

describe('tile flight geometry', () => {
  it('starts on the sender and ends on the recipient, exactly', () => {
    const path = flightPath({ x: 12, y: 40 }, { x: 30, y: 260 });
    expect(path.points[0]).toEqual({ x: 12, y: 40 });
    expect(path.points[path.points.length - 1]).toEqual({ x: 30, y: 260 });
  });

  it('emits one stop per sample, plus the start', () => {
    expect(flightPath(DOWNWARD.from, DOWNWARD.to).points).toHaveLength(FLIGHT_SAMPLES + 1);
  });

  /**
   * The apex is the whole point: a straight line between two rows in the same
   * column is a slide, and a slide is what the invisible hairline sweep already
   * was. A curve is what reads as flight.
   */
  it('bows off the straight line, apex exactly at mid + bow', () => {
    const path = flightPath(DOWNWARD.from, DOWNWARD.to);
    const apex = path.points[FLIGHT_SAMPLES / 2];
    // 100px apart × 0.24 = 24px of bow, clear of both the 22 floor and 92 cap.
    expect(apex).toEqual({ x: 24, y: 50 });
  });

  /**
   * Containment, not taste. Bowing by direction of travel sends every DOWNWARD
   * flight left — off the tree's leading edge and under the panel rail, where
   * `overflow: hidden` eats it. Both directions bow right, into the tile body.
   */
  it('bows right in both directions of travel', () => {
    const down = flightPath({ x: 0, y: 0 }, { x: 0, y: 100 });
    const up = flightPath({ x: 0, y: 100 }, { x: 0, y: 0 });
    expect(down.points[3].x).toBeGreaterThan(0);
    expect(up.points[3].x).toBeGreaterThan(0);
  });

  it('clamps the bow so neighbouring rows do not loop and distant ones do not swing off', () => {
    // 4px apart: the ratio would give 1px of bow, which is a straight line.
    expect(flightPath({ x: 0, y: 0 }, { x: 0, y: 4 }).points[3].x).toBeCloseTo(22, 5);
    // 2000px apart: the ratio would give 480px, wider than any panel.
    expect(flightPath({ x: 0, y: 0 }, { x: 0, y: 2000 }).points[3].x).toBeCloseTo(92, 5);
  });

  /**
   * Both ends absorbed onto one row is a real arrangement (see the panel's
   * same-row guard); the geometry must still produce a direction rather than
   * dividing by a zero length.
   */
  it('survives a zero-length flight without producing NaN', () => {
    const path = flightPath({ x: 8, y: 8 }, { x: 8, y: 8 });
    for (const point of path.points) {
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
    }
    expect(path.distance).toBe(0);
  });

  it('scales duration with distance, and clamps under the pulse TTL', () => {
    const near = flightPath({ x: 0, y: 0 }, { x: 0, y: 30 });
    const mid = flightPath({ x: 0, y: 0 }, { x: 0, y: 600 });
    const far = flightPath({ x: 0, y: 0 }, { x: 0, y: 4000 });
    expect(near.durationMs).toBe(560);
    expect(mid.durationMs).toBeGreaterThan(near.durationMs);
    expect(far.durationMs).toBe(1_450);
    // `useMessagePulses` deletes the arrival at 2200ms; a longer flight would
    // have its glyph removed in open air, halfway between two tiles.
    expect(far.durationMs).toBeLessThan(2_200);
  });

  it('publishes every stop as a custom property the keyframes can read', () => {
    const vars = flightVariables(flightPath({ x: 0, y: 0 }, { x: 0, y: 100 }));
    for (let index = 0; index <= FLIGHT_SAMPLES; index += 1) {
      expect(vars[`--lp-flight-${index}x`]).toMatch(/px$/);
      expect(vars[`--lp-flight-${index}y`]).toMatch(/px$/);
    }
    expect(vars['--lp-flight-duration']).toBe('560ms');
  });

  /**
   * THE NO-TRUNCATION GUARANTEE, AS ARITHMETIC.
   *
   * A glyph deleted in open air between two tiles was the defect that drove
   * three rounds of this design. It is now impossible by construction rather
   * than by a runtime check: a flight may only launch inside
   * `LAUNCH_WINDOW_MS` of its arrival, so the latest it can still be flying is
   * that window plus the longest trip — and that has to fit inside the pulse's
   * retention.
   *
   * The runtime check was REMOVED because this made it unreachable, and an
   * unreachable branch is a liability: no mutation can red it, so nothing
   * proves it still works. This assertion is what replaced it. Widen the
   * window, or raise the duration ceiling, and this fails — which is the
   * warning that the runtime check has to come back.
   */
  it('cannot produce a flight that outlives its pulse', () => {
    const longest = flightPath({ x: 0, y: 0 }, { x: 0, y: 100_000 }).durationMs;
    expect(longest).toBe(1_450);
    expect(LAUNCH_WINDOW_MS + longest).toBeLessThanOrEqual(PULSE_TTL_MS);
  });
});
