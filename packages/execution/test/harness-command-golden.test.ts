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
 * where the correct fix is to regenerate the fixture. That rule is why the two
 * things below are a NORMALISATION and a DECLARED DELTA rather than a rewrite:
 * the recording stays the recording, and everything since is stated in code a
 * reviewer can read in one screen instead of in a 2627-line diff.
 *
 * NORMALISATION — `<ECHO_AGENT_MJS>`. The fixture as first committed had the
 * generating machine's ABSOLUTE path in it
 * (`/home/tm8/prod-workspace/wt-harness-registry/…/echo-agent.mjs`), in 600 of
 * its 2625 keys, because `echoAgentPath()` resolves against `import.meta.url`.
 * That made the gate unrunnable anywhere but the one worktree that produced it:
 * it failed in GitHub CI (`/home/runner/work/tm8/tm8/…`) and in every fresh
 * clone, and it failed for a reason that has nothing to do with the refactor it
 * was guarding. Both sides are tokenised, so the assertion is now about the
 * command shape — which is what it was always trying to be about.
 *
 * DECLARED DELTA — the Codex start-up self-update kill switch. See
 * `CODEX_DELTAS`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildAgentCommand, withAgentResume } from '../src/spawn/manifest.js';
import { withAgentPrompt } from '../src/spawn/manifest.js';
import { echoAgentPath } from '../src/harness/echo-agent.js';
import { CODEX_DISABLE_STARTUP_UPDATE_CHECK } from '../src/harness/codex.js';
import {
  commandMatrix,
  PROMPT_CASES,
  RESUME_NATIVE_ID,
  RESUME_SYSTEM,
} from './harness-command-matrix.js';

const goldenPath = join(fileURLToPath(new URL('.', import.meta.url)), 'harness-command-golden.json');
const recorded = JSON.parse(readFileSync(goldenPath, 'utf8')) as Record<string, string>;

/** Replace this checkout's absolute echo-agent path with the fixture's token. */
function normalise(command: string): string {
  return command.split(echoAgentPath()).join('<ECHO_AGENT_MJS>');
}

/**
 * Every INTENTIONAL change to a codex command line since the 3edf470f
 * recording, applied to the recording so the comparison stays exact.
 *
 * Adding an entry here is a deliberate, reviewable act. Regenerating the
 * fixture would hide the same change in 2627 lines of noise and — worse —
 * would turn the file from a recording of the OLD behaviour into a restatement
 * of the NEW one, which is the only property that makes it evidence at all.
 *
 * `check_for_update_on_startup=false` — carried from the codex-autoupdate fix.
 * Codex forks `npm install @openai/codex` on TUI start and tears its own TUI
 * down; the session dies `failed` in ~1.7s having never read its brief. The
 * flag is emitted FIRST and in every posture, so on the recorded line it lands
 * immediately before whichever posture flag that case chose — the bypass branch
 * emits no `--ask-for-approval` at all, which is exactly why the fix cannot
 * live inside that branch.
 */
const CODEX_DELTAS: ReadonlyArray<(command: string) => string> = [
  (command) =>
    command.replace(
      /(--ask-for-approval |--dangerously-bypass-approvals-and-sandbox)/,
      `-c '${CODEX_DISABLE_STARTUP_UPDATE_CHECK}' $1`,
    ),
];

/** The recording, plus the declared deltas. What current code must equal. */
const golden: Record<string, string> = Object.fromEntries(
  Object.entries(recorded).map(([key, command]) => [
    key,
    key.includes('codex |') ? CODEX_DELTAS.reduce((acc, delta) => delta(acc), command) : command,
  ]),
);

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
    out[`command :: ${testCase.key}`] = normalise(base);

    for (const prompt of PROMPT_CASES) {
      out[`prompt(${prompt.key}) :: ${testCase.key}`] = normalise(withAgentPrompt(
        base,
        { system: prompt.system, task: prompt.task },
        testCase.launch,
        testCase.env,
      ));
    }

    for (const system of RESUME_SYSTEM) {
      const key = `resume(system=${system === '' ? 'empty' : 'set'}) :: ${testCase.key}`;
      try {
        out[key] = normalise(withAgentResume(
          base,
          system,
          testCase.launch,
          RESUME_NATIVE_ID,
          testCase.env,
        ));
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
