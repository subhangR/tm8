/**
 * The lost-session reaper's tick log (378): one structured line on EVERY run,
 * with candidates, retired and refused, so a pass that saw ghosts and retired
 * none can never again look like a quiet `skipped`.
 */
import { describe, expect, it } from 'vitest';

import {
  runLostSessionReaperTick,
  tickLogLevel,
  type LostSessionReaperTickLine,
} from '../../src/scheduler/jobs/lost-session-reaper.js';

function capture(): { lines: LostSessionReaperTickLine[]; log: (m: string, l: LostSessionReaperTickLine) => void } {
  const lines: LostSessionReaperTickLine[] = [];
  return { lines, log: (_m, l) => { lines.push(l); } };
}

describe('lost-session reaper tick (378)', () => {
  it('logs a line even when there is nothing to do', async () => {
    const { lines, log } = capture();
    const outcome = await runLostSessionReaperTick(
      { reap: async () => ({ candidates: 0, reaped: 0, errors: [] }) },
      log,
    );
    expect(outcome).toMatchObject({ skipped: true });
    expect(lines).toEqual([{ candidates: 0, retired: 0, refused: 0, problems: [] }]);
  });

  it('names ghosts seen but not yet past the window — the state that used to be silent', async () => {
    const { lines, log } = capture();
    await runLostSessionReaperTick({ reap: async () => ({ candidates: 19, reaped: 0, errors: [] }) }, log);
    expect(lines).toEqual([{ candidates: 19, retired: 0, refused: 0, problems: [] }]);
  });

  it('counts retirements and refusals, and carries the first five refusals verbatim', async () => {
    const { lines, log } = capture();
    const errors = Array.from({ length: 7 }, (_, i) => ({ message: `session s${String(i)}: refused` }));
    const outcome = await runLostSessionReaperTick(
      { reap: async () => ({ candidates: 9, reaped: 2, errors }) },
      log,
    );
    expect(outcome).toEqual({ affected: 2, detail: { reaped: 2, failed: 7 } });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ candidates: 9, retired: 2, refused: 7 });
    expect(lines[0]!.problems).toHaveLength(5);
  });

  it('passes the stale window through', async () => {
    let seen = 0;
    await runLostSessionReaperTick({
      staleAfterMs: 1234,
      reap: async (ms) => { seen = ms; return { candidates: 0, reaped: 0, errors: [] }; },
    });
    expect(seen).toBe(1234);
  });

  it('logs an all-zero tick at debug, anything to see at info, any refusal at warn', () => {
    const line = (candidates: number, retired: number, refused: number): LostSessionReaperTickLine => ({
      candidates, retired, refused, problems: refused > 0 ? ['x'] : [],
    });
    expect(tickLogLevel(line(0, 0, 0))).toBe('debug');
    expect(tickLogLevel(line(3, 0, 0))).toBe('info');
    expect(tickLogLevel(line(3, 3, 0))).toBe('info');
    expect(tickLogLevel(line(3, 1, 2))).toBe('warn');
  });
});
