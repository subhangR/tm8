/**
 * THE PHASE 0 GATE: the rendered command line is byte-identical to what the
 * pre-registry code produced, for every real harness, across every posture.
 *
 * The fixture in `harness-command-golden.json` was generated from the code as
 * it stood at `3edf470f` — BEFORE `packages/execution/src/harness/` existed —
 * by running the same matrix against the then-current `buildAgentCommand`,
 * `withAgentPrompt` and `withAgentResume`. It is therefore a recording of the
 * old behaviour, not a restatement of the new one, which is the only thing that
 * makes it evidence.
 *
 * If this file fails, the refactor changed a command line. There is no case
 * where the correct fix is to regenerate the fixture.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildAgentCommand, withAgentResume } from '../src/spawn/manifest.js';
import { withAgentPrompt } from '../src/spawn/manifest.js';
import {
  commandMatrix,
  PROMPT_CASES,
  RESUME_NATIVE_ID,
  RESUME_SYSTEM,
} from './harness-command-matrix.js';

const goldenPath = join(fileURLToPath(new URL('.', import.meta.url)), 'harness-command-golden.json');
const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as Record<string, string>;

/** Recompute the matrix against the CURRENT code, in the fixture's key shape. */
export function renderAll(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const testCase of commandMatrix()) {
    let base: string;
    try {
      base = buildAgentCommand(testCase.launch, testCase.env, testCase.opts);
    } catch (error) {
      out[`command :: ${testCase.key}`] = `THROWS ${(error as Error).message}`;
      continue;
    }
    out[`command :: ${testCase.key}`] = base;

    for (const prompt of PROMPT_CASES) {
      out[`prompt(${prompt.key}) :: ${testCase.key}`] = withAgentPrompt(
        base,
        { system: prompt.system, task: prompt.task },
        testCase.launch,
        testCase.env,
      );
    }

    for (const system of RESUME_SYSTEM) {
      const key = `resume(system=${system === '' ? 'empty' : 'set'}) :: ${testCase.key}`;
      try {
        out[key] = withAgentResume(
          base,
          system,
          testCase.launch,
          RESUME_NATIVE_ID,
          testCase.env,
        );
      } catch (error) {
        out[key] = `THROWS ${(error as Error).message}`;
      }
    }
  }
  return out;
}

describe('rendered command golden — the registry changes no command line', () => {
  const current = renderAll();

  it('covers the whole matrix, so a silently-empty run cannot pass', () => {
    // 3 harnesses x 5 modes x 3 models x 2 efforts x 2 session ids x 2 sandbox
    // = 360 command cases, plus 15 operator-override cases.
    expect(Object.keys(golden).length).toBeGreaterThan(2000);
    expect(Object.keys(current)).toHaveLength(Object.keys(golden).length);
  });

  it('renders every case exactly as the pre-registry code did', () => {
    // Compared as whole objects so a diff names every drifted key at once
    // rather than failing on the first.
    expect(current).toEqual(golden);
  });

  for (const tool of ['claude-code', 'codex'] as const) {
    it(`is byte-identical for ${tool} across every permissionMode`, () => {
      const keys = Object.keys(golden).filter((key) => key.includes(`${tool} |`));
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) expect(current[key]).toBe(golden[key]);
    });
  }
});
