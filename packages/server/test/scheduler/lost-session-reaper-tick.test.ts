/**
 * The node-ending jobs' tick log (403): the lost-session reaper and the
 * completed auto-close each log one structured line on EVERY run — candidates,
 * retired, notRecorded, refused — so a pass that saw rows and ended none can
 * never again look like a quiet `skipped`.
 */
import { describe, expect, it } from 'vitest';

import type { NodeEndingSweepReport } from '@tm8/execution';

import {
  runCompletedAutoCloseTick,
  runLostSessionReaperTick,
  tickLogLevel,
  type NodeSweepTickLine,
} from '../../src/scheduler/jobs/lost-session-reaper.js';

function capture(): { lines: NodeSweepTickLine[]; log: (m: string, l: NodeSweepTickLine) => void } {
  const lines: NodeSweepTickLine[] = [];
  return { lines, log: (_m, l) => { lines.push(l); } };
}

const report = (r: Partial<NodeEndingSweepReport>): NodeEndingSweepReport => ({
  candidates: 0, retired: 0, notRecorded: 0, errors: [], ...r,
});

describe('node-ending job ticks (403)', () => {
  it('logs a line even when there is nothing to do', async () => {
    const { lines, log } = capture();
    const outcome = await runLostSessionReaperTick({ reap: async () => report({}) }, log);
    expect(outcome).toMatchObject({ skipped: true });
    expect(lines).toEqual([{ candidates: 0, retired: 0, notRecorded: 0, refused: 0, problems: [] }]);
  });

  it('names ghosts seen but not yet past the window — the state that used to be silent', async () => {
    const { lines, log } = capture();
    await runLostSessionReaperTick({ reap: async () => report({ candidates: 19 }) }, log);
    expect(lines).toEqual([{ candidates: 19, retired: 0, notRecorded: 0, refused: 0, problems: [] }]);
  });

  it('counts retirements, not-recorded writes and refusals apart, with the first five refusals verbatim', async () => {
    const { lines, log } = capture();
    const errors = Array.from({ length: 7 }, (_, i) => ({ message: `session s${String(i)}: refused` }));
    const outcome = await runLostSessionReaperTick(
      { reap: async () => report({ candidates: 12, retired: 2, notRecorded: 3, errors }) },
      log,
    );
    expect(outcome).toEqual({ affected: 2, detail: { retired: 2, notRecorded: 3, failed: 7 } });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ candidates: 12, retired: 2, notRecorded: 3, refused: 7 });
    expect(lines[0]!.problems).toHaveLength(5);
  });

  it('a pass whose every write came back not recorded is not skipped', async () => {
    const outcome = await runLostSessionReaperTick({ reap: async () => report({ candidates: 4, notRecorded: 4 }) });
    expect(outcome).toEqual({ affected: 0, detail: { retired: 0, notRecorded: 4, failed: 0 } });
  });

  it('the completed auto-close logs the same line', async () => {
    const { lines, log } = capture();
    const outcome = await runCompletedAutoCloseTick({ close: async () => report({ candidates: 2, retired: 2 }) }, log);
    expect(outcome).toEqual({ affected: 2, detail: { retired: 2, notRecorded: 0, failed: 0 } });
    expect(lines).toEqual([{ candidates: 2, retired: 2, notRecorded: 0, refused: 0, problems: [] }]);
  });

  it('passes the stale window through', async () => {
    let seen = 0;
    await runLostSessionReaperTick({
      staleAfterMs: 1234,
      reap: async (ms) => { seen = ms; return report({}); },
    });
    expect(seen).toBe(1234);
  });

  it('debug when all zero, info when there is anything to see, warn on a refusal or an all-not-recorded pass', () => {
    const line = (l: Partial<NodeSweepTickLine>): NodeSweepTickLine => ({
      candidates: 0, retired: 0, notRecorded: 0, refused: 0, problems: [], ...l,
    });
    expect(tickLogLevel(line({}))).toBe('debug');
    expect(tickLogLevel(line({ candidates: 3 }))).toBe('info');
    expect(tickLogLevel(line({ candidates: 3, retired: 3 }))).toBe('info');
    expect(tickLogLevel(line({ candidates: 3, retired: 2, notRecorded: 1 }))).toBe('info');
    expect(tickLogLevel(line({ candidates: 3, notRecorded: 3 }))).toBe('warn');
    expect(tickLogLevel(line({ candidates: 3, retired: 1, refused: 2, problems: ['x', 'y'] }))).toBe('warn');
  });
});
