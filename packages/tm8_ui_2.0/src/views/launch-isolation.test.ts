/**
 * The overlay must touch NO geometry — the point of the D52-as-amended ruling.
 *
 * A stack-order column would consume width `cMin(V)` never reserved
 * (`selectVisibleCount` knows pinned+stack and nothing else), squeezing panels
 * under their 320 floor. The sheet avoids that by not participating in the
 * track at all, and this test is what keeps it that way: if `LaunchSheet` ever
 * imports the geometry module, it has started reasoning about a track it does
 * not occupy.
 *
 * NODE ENVIRONMENT, deliberately. A source scan belongs beside the other one
 * (`shell/no-motion-status.test.ts`) rather than inside a jsdom render file —
 * and `node:` builtins do not resolve under this project's jsdom environment,
 * which is how the first version of this test came to fail COLLECTION: zero
 * tests ran, and the suite's "tests passed" count stayed green because a suite
 * that never runs cannot fail one. Caught by the exit code and the
 * "Test Files 1 failed" line, which are the only two signals that can see it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fixtureSummaries } from '../fixtures';
import { LAUNCH_TEAMMATES } from './launch-fixtures';

const raw = readFileSync(fileURLToPath(new URL('./LaunchSheet.tsx', import.meta.url)), 'utf8');

/**
 * Comments stripped FIRST. The rule is about what the module USES, not what it
 * mentions — and this file's own docblock explains at length why it avoids the
 * geometry module, naming every symbol. The first version of this scan flagged
 * that prose as a violation, which is the same defect as a lint rule tripping
 * over the comment that documents it: a check answering a narrower question
 * (does the string appear) than the one asked (is the module used).
 */
const source = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('LaunchSheet geometry isolation (D52-as-amended)', () => {
  it.each(['cMin', 'panelSlots', 'solveWorkspace', 'selectVisibleCount', 'shell-stack__col'])(
    'does not reference %s',
    (symbol) => {
      expect(source).not.toContain(symbol);
    },
  );

  it('POSITIVE CONTROL: the scan can find a symbol that IS present', () => {
    // Without this, every assertion above is equally satisfied by an empty
    // read — the file-not-found case would look like a perfect pass.
    expect(source).toContain('export function LaunchSheet');
    expect(source.length).toBeGreaterThan(500);
  });
});


describe('launch ids are REAL entity ids (the two id spaces must meet)', () => {
  /**
   * The defect this pins: `LaunchTeammate.id` is carried by `buildSpawnInput`
   * into `ExecutionSpawnInput.teamMemberId` and resolved by the seam's
   * `requireSummary`. It held a view-model id (`tm-forge`) while the fixture
   * entity is `ent-tm-forge`, so the launch dispatched correctly and the node
   * refused it — "entity tm-forge not found". Nothing in the launch path was
   * broken; the two id spaces had never met.
   *
   * No unit test of the sheet could see it, because the sheet never resolves
   * the id — only the seam does, at dispatch. A real click found it. This test
   * is that click's standing replacement: it checks the id against the DATASET
   * rather than against my own copy of what the id should be.
   */
  const known = new Set(fixtureSummaries.map((s) => s.id));

  it.each(LAUNCH_TEAMMATES.map((t) => [t.name, t.id] as const))(
    '%s resolves to a real fixture entity (%s)',
    (_name, id) => {
      expect(known.has(id), `${id} is not an entity the seam can resolve`).toBe(true);
    },
  );

  it('POSITIVE CONTROL: the dataset is loaded and a bogus id would fail', () => {
    // Without this, an empty `known` set would make every assertion above fail
    // loudly — but a mis-built set that happened to contain everything would
    // make them all pass silently.
    expect(known.size).toBeGreaterThan(5);
    expect(known.has('tm-forge')).toBe(false); // the OLD view-model id
  });
});
