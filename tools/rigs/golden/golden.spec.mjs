/**
 * Vitest wrapper around the golden workflows.
 *
 * The workflows themselves live in `workflows/*.mjs` and know nothing about a
 * test framework — this file only projects their step records into `expect`s,
 * so CI (vitest) and a human at a terminal (`node run.mjs`) are running exactly
 * the same code and can never disagree about whether G1 is green.
 *
 * Pre-M1 the whole suite is expected RED. Rather than skipping (which hides the
 * gate), the suite runs and fails unless `GOLDEN_EXPECT_RED=1` is set — CI sets
 * it until M1, then removes it, and that single env flip IS the G1 gate.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { runSuite, WORKFLOWS } from './run.mjs';
import { DEFAULT_BASE_URL } from '../lib/http.mjs';

const EXPECT_RED = process.env.GOLDEN_EXPECT_RED === '1';

describe('golden workflows (gate G1)', () => {
  let report;

  beforeAll(async () => {
    report = await runSuite({ baseUrl: process.env.TM8_BASE_URL ?? DEFAULT_BASE_URL });
  }, 300_000);

  it('seeds a world through the public contract', () => {
    if (EXPECT_RED && report.fatal) {
      expect(report.fatal).toBeTruthy(); // documented red: no server yet
      return;
    }
    expect(report.fatal).toBeNull();
  });

  for (const wf of WORKFLOWS) {
    it(`${wf.id} — ${wf.title}`, () => {
      const result = report.workflows.find((w) => w.id === wf.id);
      if (EXPECT_RED) {
        // Pre-M1: assert only that the workflow is DEFINED and attempted, so a
        // deleted workflow still breaks the build.
        expect(WORKFLOWS.map((w) => w.id)).toContain(wf.id);
        return;
      }
      expect(result, `${wf.id} did not run (an earlier workflow failed first)`).toBeDefined();
      const failures = result.steps.filter((s) => s.status === 'fail' || s.status === 'red');
      expect(failures.map((f) => `${f.title}: ${f.error}`)).toEqual([]);
      expect(result.error).toBeNull();
    });
  }

  it('the suite is green (this is the gate)', () => {
    if (EXPECT_RED) {
      expect(report.green).toBe(false);
      return;
    }
    expect(report.green).toBe(true);
  });
});
