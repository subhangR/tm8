import { describe, expect, it } from 'vitest';
import type { CredentialsSpacePolicyView, SpaceCredentialView } from '@tm8/contract';
import {
  githubAuthorshipLine,
  launchSourceOptions,
  parseLaunchSourceChoice,
  sourcePolicyReason,
} from './launch-sources';

const row = (over: Partial<SpaceCredentialView>): SpaceCredentialView => ({
  id: 'x', spaceId: 's', provider: 'github', shape: 'token', label: 'L', isDefault: false, status: 'active',
  createdByAccountId: null, displayLogin: null, keyHint: null, createdAt: '', updatedAt: '',
  lastUsedAt: null, lastProbeAt: null, ...over,
} as SpaceCredentialView);
const policy = (over: Partial<CredentialsSpacePolicyView>): CredentialsSpacePolicyView =>
  ({ spaceId: 's', providers: [], node: [], ...over });

describe('launch source choices', () => {
  it('decodes a choice without ever producing an account', () => {
    expect(parseLaunchSourceChoice('')).toBeNull();
    expect(parseLaunchSourceChoice('member')).toEqual({ source: 'member', spaceCredentialId: null });
    expect(parseLaunchSourceChoice('space')).toEqual({ source: 'space', spaceCredentialId: null });
    expect(parseLaunchSourceChoice('space:abc')).toEqual({ source: 'space', spaceCredentialId: 'abc' });
  });

  it('answers a policy reason only for a source that is off', () => {
    const p = policy({ providers: [{ provider: 'openai', allowedSources: ['member', 'node'] }] });
    expect(sourcePolicyReason('openai', 'space', p)).toBe('off: this space allows only Yours and Node');
    expect(sourcePolicyReason('openai', 'member', p)).toBeNull();
    expect(sourcePolicyReason('openai', 'space', null)).toBeNull();
    // A provider outside v1's space set has no space policy to answer.
    expect(sourcePolicyReason('gemini', 'space', p)).toBeNull();
  });

  it('offers no Space option for a provider the space cannot hold', () => {
    const opts = launchSourceOptions({
      provider: 'gemini', memberText: 'm', nodeText: 'n', autoText: 'a', spaceCredentials: [], policy: null,
    });
    expect(opts.map((o) => o.value)).toEqual(['', 'member', 'node']);
  });

  it('says a stale credential is stale, and a provider with none has none', () => {
    const opts = launchSourceOptions({
      provider: 'github', memberText: 'm', nodeText: 'n', autoText: 'a',
      spaceCredentials: [row({ id: 'g', label: 'Bot', isDefault: true, status: 'stale' })], policy: null,
    });
    expect(opts.find((o) => o.value === 'space:g')?.text).toBe('Space ▸ Bot (stale: the last check failed)');
    const none = launchSourceOptions({
      provider: 'openai', memberText: 'm', nodeText: 'n', autoText: 'a', spaceCredentials: [], policy: null,
    });
    expect(none.find((o) => o.value === 'space')).toMatchObject({
      disabled: true, reason: 'this space holds none for this provider',
    });
  });

  it('refuses in words when Auto has nothing left to author GitHub commits', () => {
    const line = githubAuthorshipLine({
      choice: '',
      memberHandle: null,
      spaceCredentials: [],
      policy: policy({ node: [{ provider: 'github', allowNode: false }] }),
    });
    expect(line).toContain('this launch will be refused');
  });

  it('says so when a space token has no recorded login', () => {
    expect(githubAuthorshipLine({
      choice: 'space', memberHandle: null, spaceCredentials: [row({ isDefault: true, label: 'Bot' })], policy: null,
    })).toBe('Commits and pull requests are authored by the account behind the space token “Bot” (its login was not recorded)');
  });
});
