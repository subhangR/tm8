/**
 * WHICH SEAM A BROWSER GETS — asserted from a process that is not a browser.
 *
 * `realSeamFlag.test.ts` (which stays as it is, and which this file does not
 * duplicate) exercises `isRealSeamEnabled()` in the ambient environment. Under
 * vitest that environment reports `MODE === 'test'` and always will, so those
 * assertions can only ever measure the TEST-Mode rule. The app's real default —
 * what a person loading `:4612` gets — was structurally unassertable there.
 *
 * `resolveSeamSource(env, flag)` takes both inputs as arguments for exactly
 * this reason, and this file is the whole truth table. The flip from
 * fixture-by-default to node-by-default is the user's first-priority change,
 * and a default nobody can assert is a default nobody can defend.
 */
import { describe, expect, it } from 'vitest';
import { resolveSeamSource } from './realSeamFlag';

const dev = { MODE: 'development' };
const test = { MODE: 'test' };
const prod = { MODE: 'production' };
const staging = { MODE: 'staging' };

describe('resolveSeamSource — the truth table', () => {
  it('THE HEADLINE: a dev browser with nobody opting in gets the REAL node', () => {
    // The whole point. Before 2026-07-29 this was 'fixture', which meant a
    // fresh load of the app rendered invented entities in the same chrome real
    // ones use, with nothing on screen saying so.
    expect(resolveSeamSource(dev, null)).toBe('real');
  });

  it('a mode nobody named still defaults real — the rule is not a dev-only carve-out', () => {
    expect(resolveSeamSource(staging, null)).toBe('real');
    expect(resolveSeamSource({}, null)).toBe('real');
  });

  it('an explicit "0" is an OFF SWITCH, and it wins over the default', () => {
    // A default with no way back is a trap: no node running, no app. This is
    // how you get the fixture world back without a rebuild.
    expect(resolveSeamSource(dev, '0')).toBe('fixture');
    expect(resolveSeamSource(staging, '0')).toBe('fixture');
  });

  it('an explicit "1" still turns it on where the default is off', () => {
    expect(resolveSeamSource(test, '1')).toBe('real');
  });

  it('under MODE=test the default is FIXTURE — the runner has no node', () => {
    // Not a convenience. A real default here would make every suite in the
    // package assert against an unreachable host, and 1000 reds would say
    // nothing about whatever change actually broke.
    expect(resolveSeamSource(test, null)).toBe('fixture');
  });

  it('production is FIXTURE, opt-in or not — the guard the brief kept verbatim', () => {
    // STATED BECAUSE IT IS SURPRISING, and flagged in the handover rather than
    // quietly encoded: this makes a production build show fixture data while a
    // dev build shows the node. It is a ruling carried forward from the opt-in
    // era, not a measurement, and it is the one line here that may want
    // reversing.
    expect(resolveSeamSource(prod, null)).toBe('fixture');
    expect(resolveSeamSource(prod, '1')).toBe('fixture');
  });

  it('any value that is neither "1" nor "0" is not an opt-in or an opt-out', () => {
    // It falls through to the default, which is now REAL — so a typo'd flag
    // does not silently demote the app to fixtures.
    for (const value of ['true', 'yes', 'real', '']) {
      expect(resolveSeamSource(dev, value), `value ${JSON.stringify(value)}`).toBe('real');
      expect(resolveSeamSource(test, value), `value ${JSON.stringify(value)}`).toBe('fixture');
    }
  });
});
