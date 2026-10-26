// The worker routine (task P0g): one source, rendered into the v1 identity,
// the v2 worker layer and `tm8 help routine`. These pin that every rendering
// carries every step, so a step added in one place cannot go missing in another.

import { describe, expect, it } from 'vitest';

import { WORKER_ROUTINE_STEPS, WORKER_ROUTINE_V1, workerRoutineV2Rule } from '../src/index.js';

describe('worker routine', () => {
  it('runs claim → status → tick → place → link → finish → close out → session complete', () => {
    expect(WORKER_ROUTINE_STEPS.map((s) => s.name)).toEqual([
      'Claim',
      'Keep the status true',
      'Tick as you go',
      'Put what you create in its place',
      'Link your work',
      'Finish each task',
      'Close out',
      'Complete the session',
    ]);
  });

  it('renders every step in v1 (full rule) and v2 (short form)', () => {
    const v2 = workerRoutineV2Rule(2);
    for (const [i, s] of WORKER_ROUTINE_STEPS.entries()) {
      expect(WORKER_ROUTINE_V1).toContain(`(${i + 1}) ${s.name}: ${s.rule}`);
      expect(v2).toContain(`(${i + 1}) ${s.name}: ${s.short}.`);
    }
    expect(v2.startsWith('2. ')).toBe(true);
    expect(v2).toContain('`tm8 help routine`');
  });

  it('never ties completion to a PR merge (owner ruling, 6 Oct 2026)', () => {
    for (const s of WORKER_ROUTINE_STEPS) {
      expect(`${s.short} ${s.rule}`).not.toMatch(/pr_merged|merge completes|once the PR has merged/);
    }
  });

  it('keeps P0a\'s close-out order: hand off claims, post the receipt, then session complete', () => {
    const names = WORKER_ROUTINE_STEPS.map((s) => s.name);
    expect(names.indexOf('Finish each task')).toBeLessThan(names.indexOf('Close out'));
    expect(names.indexOf('Close out')).toBeLessThan(names.indexOf('Complete the session'));
    const last = WORKER_ROUTINE_STEPS[WORKER_ROUTINE_STEPS.length - 1]!;
    expect(last.rule).toContain('tm8 session complete');
    expect(last.rule).toContain('claims_open');
    expect(WORKER_ROUTINE_V1).toContain('tm8 task release <task-id> --note');
  });
});
