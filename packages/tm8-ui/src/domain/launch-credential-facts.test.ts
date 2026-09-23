/**
 * SC-5 session detail (D8/D9): the resolved credential source per provider,
 * and — for a space source — the credential's LABEL, never a bare id posing as
 * a name, and never a request posing as an outcome.
 */
import { describe, expect, it } from 'vitest';
import { describeLaunchManifest, launchCredentialFacts, launchSpaceCredentialIds } from './index';

const CRED_A = '01a0d000-0000-7000-8000-00000000000a';
const CRED_GH = '01a0d000-0000-7000-8000-0000000000ab';
const labels = new Map([[CRED_A, 'Team Claude'], [CRED_GH, 'Release bot']]);

describe('launchCredentialFacts', () => {
  it('reads the RESOLVED source first and names a space credential by label', () => {
    const facts = launchCredentialFacts({
      credentialSources: { anthropic: 'member', github: 'node' },
      effectiveCredentialSources: { anthropic: 'space', openai: 'node', github: 'space' },
      spaceCredentialIds: { anthropic: CRED_A, github: CRED_GH },
    }, labels);
    expect(facts).toEqual([
      { label: 'Claude credential', value: 'space ▸ Team Claude', mono: false },
      { label: 'Codex credential', value: 'node', mono: false },
      { label: 'GitHub credential', value: 'space ▸ Release bot', mono: false },
    ]);
  });

  it('says a credential that is no longer listed is gone, instead of passing its id off as a name', () => {
    const [fact] = launchCredentialFacts({
      effectiveCredentialSources: { anthropic: 'space' },
      spaceCredentialIds: { anthropic: 'gone-id' },
    }, labels);
    expect(fact.value).toBe('space ▸ gone-id (no longer listed: deleted, or not visible to you)');
  });

  it('shows the id plainly while labels are unknown (list not read / unreadable)', () => {
    const [fact] = launchCredentialFacts({
      effectiveCredentialSources: { anthropic: 'space' },
      spaceCredentialIds: { anthropic: CRED_A },
    }, null);
    expect(fact.value).toBe(`space ▸ ${CRED_A}`);
  });

  it('marks a request-only manifest as REQUESTED, not as what ran', () => {
    const [fact] = launchCredentialFacts({ credentialSources: { openai: 'member' } });
    expect(fact).toEqual({
      label: 'Codex credential',
      value: 'yours (requested; the resolved source was not recorded)',
      mono: false,
    });
  });

  it('draws nothing for a manifest from before credential sources existed, or an unknown source word', () => {
    expect(launchCredentialFacts({ model: 'opus' })).toEqual([]);
    expect(launchCredentialFacts(null)).toEqual([]);
    expect(launchCredentialFacts({ effectiveCredentialSources: { anthropic: 'account-123' } })).toEqual([]);
  });

  it('never sees an account id: a source is one of three words (I1)', () => {
    const facts = launchCredentialFacts({ effectiveCredentialSources: { anthropic: 'member' } });
    expect(facts[0].value).toBe('yours');
  });
});

describe('launchSpaceCredentialIds / describeLaunchManifest', () => {
  it('lists the space credential ids a manifest names, ignoring junk', () => {
    expect(launchSpaceCredentialIds({ launch: { spaceCredentialIds: { anthropic: CRED_A, openai: '', github: 7 } } }))
      .toEqual([CRED_A]);
    expect(launchSpaceCredentialIds({ launch: {} })).toEqual([]);
    expect(launchSpaceCredentialIds(null)).toEqual([]);
  });

  it('places the credential facts in the manifest description', () => {
    const { facts } = describeLaunchManifest({
      launch: { model: 'opus', effectiveCredentialSources: { anthropic: 'space' }, spaceCredentialIds: { anthropic: CRED_A } },
    }, labels);
    expect(facts.find((f) => f.label === 'Claude credential')?.value).toBe('space ▸ Team Claude');
  });
});
