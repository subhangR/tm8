/**
 * THE GATE — one agent tool AND GitHub (Subhang, 2026-09-05).
 *
 * These tests are about the two ways this derivation can be wrong, and both
 * are asymmetric: counting an unmeasured provider as CONNECTED tells a member
 * they are finished on the strength of an answer nobody obtained, and counting
 * it as a MISSING STEP marches them back through a login they may already
 * hold. Neither is "not connected", so neither shares its test.
 */
import { describe, expect, it } from 'vitest';
import type {
  CredentialProviderName,
  CredentialsStatusView,
} from '@tm8/contract';
import {
  credentialSetupState,
  setupNudgeOf,
  shouldOfferSetup,
} from './setup-gate';

function connection(
  provider: CredentialProviderName,
  over: Partial<CredentialsStatusView['providers'][number]> = {},
) {
  return {
    provider,
    connected: false,
    login: null,
    authMethod: null,
    status: null,
    connectedAt: null,
    lastVerifiedAt: null,
    ...over,
  };
}

function status(
  providers: CredentialsStatusView['providers'],
  gitCredentialStore: 'present' | 'absent' = 'present',
): CredentialsStatusView {
  return { providers, gitCredentialStore } as CredentialsStatusView;
}

const connected = (p: CredentialProviderName, login: string | null = 'someone') =>
  connection(p, { connected: true, login });

describe('what counts as set up', () => {
  it('needs BOTH halves — an agent tool alone is not finished', () => {
    const state = credentialSetupState(
      status([connected('anthropic'), connection('github')]),
    );
    expect(state.hasAgent).toBe(true);
    expect(state.hasGit).toBe(false);
    expect(state.complete).toBe(false);
  });

  it('needs BOTH halves — GitHub alone is not finished either', () => {
    const state = credentialSetupState(
      status([connection('anthropic'), connected('github', 'octocat')]),
    );
    expect(state.hasAgent).toBe(false);
    expect(state.complete).toBe(false);
  });

  it('one agent tool is enough — it does not matter which', () => {
    for (const provider of ['anthropic', 'openai', 'gemini', 'cursor'] as const) {
      const state = credentialSetupState(
        status([connection('anthropic'), connected(provider), connected('github', 'octocat')]),
      );
      expect(state.complete, `${provider} did not satisfy the agent half`).toBe(true);
    }
  });

  /* A login of NULL is a complete positive answer — legacy Anthropic rows have
     it forever and Cursor's probe proves authentication without naming an
     account. Requiring a name here would tell those members to reconnect a
     credential that already works. */
  it('counts a connected provider that supplied no account name', () => {
    const state = credentialSetupState(
      status([connected('cursor', null), connected('github', 'octocat')]),
    );
    expect(state.complete).toBe(true);
  });
});

describe('an unmeasured provider is neither connected nor a missing step', () => {
  it('does NOT count a stale probe as connected', () => {
    const state = credentialSetupState(
      status([connection('anthropic', { status: 'stale' }), connected('github', 'octocat')]),
    );
    expect(state.agents[0]!.unmeasured).toBe(true);
    expect(state.agents[0]!.connected).toBe(false);
    expect(state.complete).toBe(false);
  });

  it('does NOT count an absent binary as connected', () => {
    const state = credentialSetupState(
      status([connection('hermes', { status: 'unavailable' }), connected('github', 'octocat')]),
    );
    expect(state.agents[0]!.unavailable).toBe(true);
    expect(state.complete).toBe(false);
  });

  /* GitHub's legacy store completeness is the one provider-specific exception
     the port already owns; the gate must inherit it rather than re-deciding.
     An absent store makes GitHub UNKNOWN, not disconnected. */
  it('inherits the absent-git-store reading from the port', () => {
    const state = credentialSetupState(
      status([connected('anthropic'), connection('github')], 'absent'),
    );
    expect(state.git?.unmeasured).toBe(true);
    expect(state.git?.connected).toBe(false);
    expect(state.complete).toBe(false);
  });
});

describe('when the flow may interrupt someone', () => {
  const unfinished = status([connection('anthropic'), connection('github')]);

  it('offers itself to an unfinished, undismissed member', () => {
    expect(shouldOfferSetup(unfinished, false)).toBe(true);
  });

  it('never interrupts a member who is finished', () => {
    const done = status([connected('anthropic'), connected('github', 'octocat')]);
    expect(shouldOfferSetup(done, false)).toBe(false);
  });

  it('believes a member who said Later', () => {
    expect(shouldOfferSetup(unfinished, true)).toBe(false);
  });

  /* A node that listed nothing, or measured nothing, is our instrumentation
     failing. Opening a setup flow on it asks a member to fix our problem. */
  it('refuses to interrupt when the node listed no providers at all', () => {
    expect(shouldOfferSetup(status([]), false)).toBe(false);
    expect(credentialSetupState(status([])).unreadable).toBe(true);
  });

  it('refuses to interrupt when every provider is unmeasured', () => {
    const blind = status([
      connection('anthropic', { status: 'stale' }),
      connection('github', { status: 'stale' }),
    ]);
    expect(credentialSetupState(blind).unreadable).toBe(true);
    expect(shouldOfferSetup(blind, false)).toBe(false);
  });

  /* The reverse of the rule above: ONE readable provider is enough to make the
     answer actionable, so a partly-unmeasured node still offers the flow. */
  it('still offers when at least one provider was measured', () => {
    const partly = status([
      connection('anthropic', { status: 'stale' }),
      connection('github'),
    ]);
    expect(credentialSetupState(partly).unreadable).toBe(false);
    expect(shouldOfferSetup(partly, false)).toBe(true);
  });
});

describe('the account-menu nudge names what is actually missing', () => {
  it('says nothing at all when finished', () => {
    const done = credentialSetupState(
      status([connected('anthropic'), connected('github', 'octocat')]),
    );
    expect(setupNudgeOf(done)).toBeNull();
  });

  it('says nothing when the node measured nothing — no invented urgency', () => {
    expect(setupNudgeOf(credentialSetupState(status([])))).toBeNull();
  });

  it('names GitHub specifically when only that half is missing', () => {
    const state = credentialSetupState(
      status([connected('anthropic'), connection('github')]),
    );
    expect(setupNudgeOf(state)).toContain('GitHub');
  });

  it('names the agent half when only that is missing', () => {
    const state = credentialSetupState(
      status([connection('anthropic'), connected('github', 'octocat')]),
    );
    expect(setupNudgeOf(state)).toBe('no agent tool connected yet');
  });
});
