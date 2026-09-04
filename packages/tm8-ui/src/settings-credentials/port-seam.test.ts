/**
 * THE TEST THAT LIVES IN THE GAP — driven against a REAL seam, asserting on
 * what comes BACK rather than on what was called.
 *
 * This file exists because the gap it guards was real in this very lane. The
 * `credentials` block was added to the `Seam` interface, to `ops.ts`, to the
 * fixture and to the screen — four green links — while the edit wiring it into
 * `seam-real.ts` silently never landed. Every component test still passed,
 * because they all run against the fixture. The screen would have worked
 * perfectly in development and been dead against a real node.
 *
 * `tsc` caught that one, because `RealSeam` structurally requires the block.
 * This file is the second line: it drives the PORT against an actual
 * `createFixtureSeam()` so that a port method which forgets to forward its
 * argument, or drops the answer, fails here rather than on a user's screen.
 */
import { describe, expect, it } from 'vitest';
import { createFixtureSeam } from '../data/fixtures/seam-fixture';
import { FIXTURE_SPACE_ID } from '../fixtures';
import { credentialsPortFromSeam } from './port';

function port() {
  return credentialsPortFromSeam(createFixtureSeam(), FIXTURE_SPACE_ID);
}

describe('the credentials port against a real seam', () => {
  it('returns the merged view AND its completeness report', async () => {
    const status = await port().load();
    // All five providers, always — the contract says the array is never
    // partial, so a screen may index it without guarding.
    expect(status.providers.map((p) => p.provider)).toEqual([
      'anthropic',
      'openai',
      'github',
      'gemini',
      'hermes',
    ]);
    expect(status.gitCredentialStore).toBe('absent');
  });

  it('carries the node measurement that makes Hermes unavailable, not disconnected', async () => {
    const status = await port().load();
    const hermes = status.providers.find((provider) => provider.provider === 'hermes');
    expect(hermes?.connected).toBe(false);
    expect(hermes?.status).toBe('unavailable');
  });

  it('carries anthropic’s permanently-null login through unchanged', async () => {
    const status = await port().load();
    const anthropic = status.providers.find((p) => p.provider === 'anthropic');
    // Nullable-never-absent: the KEY is present and the VALUE is null. A seam
    // that dropped the key would make a UI branch on `undefined` and draw a
    // second card for one permanent fact.
    expect(anthropic).toHaveProperty('login');
    expect(anthropic?.login).toBeNull();
    expect(anthropic?.connected).toBe(true);
  });

  it('forwards the provider to disconnect and returns the partial result', async () => {
    // The argument is the whole point: a port that ignored `provider` would
    // return a plausible answer about the WRONG credential.
    const result = await port().disconnect('anthropic');
    expect(result.provider).toBe('anthropic');
    // revoked AND failures — the normal partial outcome (R3), preserved by the
    // port rather than flattened into a boolean.
    expect(result.revoked).toBe(true);
    expect(result.failures.length).toBeGreaterThan(0);
    expect(result.failures[0]).toHaveProperty('reason');
    expect(result.failures[0]).toHaveProperty('step');
  });

  it('binds the spaceId itself and names a work_session to host', async () => {
    const started = await port().startLogin('github');
    // The screen never supplies a spaceId; the port holds it. If that binding
    // were dropped the login terminal would be born in the wrong space.
    expect(started.spaceId).toBe(FIXTURE_SPACE_ID);
    expect(started.provider).toBe('github');
    expect(started.workSessionId).toBeTruthy();
    expect(started.command).toBeTruthy();
    expect(started.expiresAt).toBeTruthy();
  });

  it('keeps `connected` and `stored` as two separate answers', async () => {
    const finished = await port().finishLogin('ws-login-1');
    expect(finished.workSessionId).toBe('ws-login-1');
    // The pair a careless seam would collapse into one boolean. `connected:
    // true, stored: false` is a CORRECT outcome and both halves must survive.
    expect(finished.connected).toBe(true);
    expect(finished.stored).toBe(false);
  });
});
