/**
 * W10a T41b — the TS half of a membership end or an account disable: every
 * other launcher's session on a revoked member credential is contained, each
 * revoked login home is removed, and a failure is logged, never thrown. The
 * SQL half (which rows, which lists) is credential-entities.pg.test.ts T41b.
 */
import { describe, expect, it } from 'vitest';

import { afterCredentialsRevoked, type MembershipHandlerDeps } from '../../src/membership/handlers.js';

const home = (credentialId: string) => ({ spaceId: 'space-1', credentialId, provider: 'anthropic' as const });

function harness(fail: { session?: string; home?: string } = {}) {
  const calls: string[] = [];
  const logged: string[] = [];
  const deps: MembershipHandlerDeps = {
    sessions: {
      killRecordedEnding: async (id) => { calls.push(`kill:${id}`); return 'ok'; },
      containCredentialSession: async (id, cause) => {
        calls.push(`contain:${id}:${cause}`);
        if (id === fail.session) throw new Error('pty host gone');
      },
    },
    removeCredentialHome: async (h) => {
      calls.push(`home:${h.credentialId}`);
      if (h.credentialId === fail.home) throw new Error('eacces');
    },
  };
  const log = (message: string) => { logged.push(message); };
  return { calls, logged, deps, log };
}

describe('afterCredentialsRevoked', () => {
  it('contains each listed session as a credential delete, then removes each home', async () => {
    const h = harness();
    await afterCredentialsRevoked({ credentialSessionIds: ['s1', 's2'], credentialHomes: [home('c1')] }, h.deps, h.log);
    expect(h.calls).toEqual([
      'contain:s1:space_credential_deleted',
      'contain:s2:space_credential_deleted',
      'home:c1',
    ]);
    expect(h.logged).toEqual([]);
  });

  it('empty or absent lists touch nothing', async () => {
    const h = harness();
    await afterCredentialsRevoked({}, h.deps, h.log);
    await afterCredentialsRevoked({ credentialSessionIds: [], credentialHomes: [] }, h.deps, h.log);
    expect(h.calls).toEqual([]);
  });

  it('one failure is logged and the rest still run', async () => {
    const h = harness({ session: 's1', home: 'c1' });
    await afterCredentialsRevoked({ credentialSessionIds: ['s1', 's2'], credentialHomes: [home('c1'), home('c2')] }, h.deps, h.log);
    expect(h.calls).toEqual([
      'contain:s1:space_credential_deleted',
      'contain:s2:space_credential_deleted',
      'home:c1',
      'home:c2',
    ]);
    expect(h.logged).toHaveLength(2);
  });

  it('a node with no runtime and no homes is a no-op, not a throw', async () => {
    await expect(afterCredentialsRevoked({ credentialSessionIds: ['s1'], credentialHomes: [home('c1')] }, {}, () => undefined))
      .resolves.toBeUndefined();
  });
});
