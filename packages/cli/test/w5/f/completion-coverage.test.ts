/**
 * W5 · DUO F · TESTER — the gap I filed against myself, closed.
 *
 * `completion` was item 5.8 of MY OWN "what I did not establish": group 10 is my
 * mandate and nobody had asked the agentic question of it. My developer named
 * the same gap in its closing and DECLINED to probe it — correctly, because a
 * developer's ungated finding about its own module, produced at close with
 * nobody to argue with it, is the shape this program distrusts most. It said:
 * give me a tester and I will do it. I am the tester, so I am closing it from
 * this side instead.
 *
 * THE AGENTIC QUESTION, which is the one nobody had asked: DOES THE COMPLETION
 * AN AGENT INSTALLS MISLEAD THE AGENT THAT INSTALLS IT?
 *
 * `src/discovery/completion.ts:1-13` states the design intent in its own voice,
 * and it is the standard this file measures against:
 *   "Completion offers the whole documented grammar, not merely the subset this
 *    build has wired. That is deliberate: completion teaches the LANGUAGE ...
 *    which is a strictly better outcome than an agent never learning the
 *    command exists."
 * So the file's OWN stated failure mode is "an agent never learning the command
 * exists". That is not my framing imported from outside; it is the module's.
 *
 * WHAT THIS CAN BE SATISFIED BY, before what it asserts:
 *  - It compares the REGISTERED command set (what the binary actually
 *    dispatches) against the COMPLETION script's text. It is NOT evidence about
 *    whether any shell parses the script correctly, and NOT evidence that a
 *    completable command works.
 *  - A command absent from completion is not thereby broken — it is
 *    UNDISCOVERABLE BY TAB. That is the whole claim and it is narrower than
 *    "the command is missing".
 *  - The positive control is SHAPE-MATCHED (§7e): the same extraction over the
 *    same script for a command that IS present. A control that merely proved
 *    the script is non-empty would share no shape with the absence claimed.
 */
import { describe, expect, it } from 'vitest';

import { SHELLS, completionScript } from '../../../src/discovery/completion.js';
import { COMMANDS } from '../../../src/commands/registry.js';

/** Every command path the binary actually dispatches, space-joined. */
const REGISTERED: readonly string[] = COMMANDS.map((c) => c.path.join(' ')).sort();

describe('W5.F — completion covers every command the binary implements', () => {
  it('CONTROL — the registry is non-trivial and the script is real text', () => {
    // If either of these is degenerate, every absence below is meaningless.
    expect(REGISTERED.length).toBeGreaterThan(50);
    for (const shell of SHELLS) {
      expect(completionScript(shell).length, `${shell} script must be real`).toBeGreaterThan(200);
    }
  }, 15_000);

  it('CONTROL, SHAPE-MATCHED — the same extraction FINDS a command that is present', () => {
    // Proves the instrument can see a command in the script at all, using the
    // identical substring test the absence claim below relies on.
    for (const shell of SHELLS) {
      const script = completionScript(shell);
      expect(script, `${shell}: 'entity get' must be completable`).toContain('entity get');
      expect(script, `${shell}: the 'help' root command must be completable`).toContain('help');
    }
  }, 15_000);

  it('CLASS GUARD — no registered command is absent from the completion grammar', () => {
    const script = completionScript('bash');
    const missing = REGISTERED.filter((path) => !script.includes(path));
    // Reported, not asserted to a literal: this is the measurement, and its
    // value is the NAMES, not a count. A count could not survive a substitution.
    console.info(
      `[W5.F completion] registered=${REGISTERED.length} `
        + `absent_from_completion=${missing.length} :: ${missing.join(' | ')}`,
    );

    // ═══ CONVERTED, NOT RE-PINNED (§3d) ═══
    // This asserted the gap until the fix landed, then fired on cue. Its
    // disposition said CONVERT, so it now asserts the CLASS PROPERTY rather
    // than the one instance: EVERY registered command is completable.
    //
    // Deliberately the general form. Pinning `worker init` alone would guard
    // the command that was fixed and miss the NEXT command registered without
    // a discovery row — which is the actual mechanism (Amendment E's
    // unprojected class). An exact empty set catches the class.
    expect(
      missing,
      'a registered command is absent from the completion grammar. That is the '
        + 'unprojected class returning: a command registered with no discovery '
        + 'row reaches neither COMMAND_PATHS nor the ROOT_COMMANDS hand-list. '
        + 'Add it to ROOT_COMMANDS (completion.ts:36-42).',
    ).toEqual([]);
    // Every shell is generated from the same ALL_PATHS list, so the absence is
    // not shell-specific. Asserting that keeps a single-shell finding honest.
    for (const shell of SHELLS) {
      const s = completionScript(shell);
      expect(
        REGISTERED.filter((p) => !s.includes(p)),
        `${shell} must have the same coverage as bash`,
      ).toEqual(missing);
    }
    expect(Array.isArray(missing)).toBe(true);
  }, 15_000);

  it('FIXED, GUARDED — `worker init`, the harness first act, is TAB-reachable', () => {
    // worker-init.ts:2-3 claims first-act status in the tree's own voice:
    // "the harness bootstrap, and the first thing a spawned agent runs".
    expect(
      REGISTERED,
      'worker init must be a registered, dispatchable command',
    ).toContain('worker init');

    for (const shell of SHELLS) {
      const script = completionScript(shell);
      // The narrow, decisive observable: the NOUN must appear, because if it
      // did not, no amount of tabbing would reach the verb either.
      // CONVERTED: was `.toBe(false)` while the gap existed. Now the named
      // regression guard for the instance, sitting beneath the class assertion
      // above — the harness's first act must stay TAB-reachable.
      expect(
        script.includes('worker'),
        `${shell}: the noun the harness makes every spawned agent's first act `
          + 'is no longer completable. completion.ts:1-13 says this module '
          + 'exists so an agent never fails to learn a command exists.',
      ).toBe(true);
      expect(script, `${shell}: the full path must be completable`).toContain('worker init');
    }
  }, 15_000);
});
