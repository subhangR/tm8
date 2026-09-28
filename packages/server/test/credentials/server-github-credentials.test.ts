/**
 * S5 (doc 01a0e248 §10.5, §10.6): the server-side GitHub reader.
 *
 *   * a POLLER spends only the space's own credential — the id S7's `canPoll`
 *     names — else reads anonymously with a reason; it never throws;
 *   * a MERGE spends only a credential the caller OWNS in that space, their
 *     my_default first, and refuses with a reason the sentence can name.
 */
import { CollabError } from '@tm8/contract';
import { describe, expect, it } from 'vitest';

import {
  DbServerGithubCredentials,
  memberGithubRefusal,
} from '../../src/credentials/space-credential-port.js';
import type { DbClaims } from '../../src/db/types.js';

const SPACE = '11111111-1111-7111-8111-111111111111';
const CLAIMS: DbClaims = { identityId: 'i' };

interface Calls { readForSpawn: unknown[][]; query: unknown[][] }

function reader(opts: {
  canPoll?: { credentialId: string | null; reason: 'stale' | 'no_space_owned_credential' | null };
  readinessError?: Error;
  owned?: { id: string; status: string; label: string }[];
  myDefault?: string | null;
  spawnError?: Error;
}): { reader: DbServerGithubCredentials; calls: Calls } {
  const calls: Calls = { readForSpawn: [], query: [] };
  const store = {
    readiness: async () => {
      if (opts.readinessError) throw opts.readinessError;
      return { canPoll: { ready: false, missing: [], activeSpaceOwnedCredentials: 0, ...opts.canPoll } } as never;
    },
    readForSpawn: async (...args: unknown[]) => {
      calls.readForSpawn.push(args);
      if (opts.spawnError) throw opts.spawnError;
      const id = args[3] as string;
      return { kind: 'secret', shape: 'token', credentialId: id, spaceId: SPACE, provider: 'github', label: `label-${id}`, displayLogin: null, secret: `tok-${id}` } as never;
    },
    myDefaultId: async () => opts.myDefault ?? null,
  };
  const db = {
    query: async (...args: unknown[]) => {
      calls.query.push(args);
      return (opts.owned ?? []) as never;
    },
  };
  return { reader: new DbServerGithubCredentials({ db: db as never, store }), calls };
}

describe('readPollToken — the space\'s own credential, else anonymous', () => {
  it("spends exactly the credential canPoll names", async () => {
    const { reader: r, calls } = reader({ canPoll: { credentialId: 'space-owned', reason: null } });
    await expect(r.readPollToken(CLAIMS, SPACE)).resolves.toEqual({
      ok: true, token: 'tok-space-owned', credentialId: 'space-owned', label: 'label-space-owned',
    });
    expect(calls.readForSpawn).toEqual([[CLAIMS, SPACE, 'github', 'space-owned']]);
    // No member-credential lookup at all on the poll path.
    expect(calls.query).toEqual([]);
  });

  it('no space-owned credential is anonymous with the fix named, and nothing is opened', async () => {
    const { reader: r, calls } = reader({ canPoll: { credentialId: null, reason: 'no_space_owned_credential' } });
    const read = await r.readPollToken(CLAIMS, SPACE);
    expect(read).toEqual({ ok: false, reason: 'the space has no space-owned GitHub credential — connect one under Space settings → Credentials' });
    expect(calls.readForSpawn).toEqual([]);
  });

  it('a stale space credential says re-key', async () => {
    const { reader: r } = reader({ canPoll: { credentialId: null, reason: 'stale' } });
    expect(await r.readPollToken(CLAIMS, SPACE)).toMatchObject({ ok: false, reason: expect.stringContaining('stale — re-key') });
  });

  it('never throws: a non-member and a failed read are reasons, not errors', async () => {
    const denied = new CollabError('forbidden', 'not a member', { details: { sqlstate: '42501' } });
    expect(await reader({ readinessError: denied }).reader.readPollToken(CLAIMS, SPACE))
      .toMatchObject({ ok: false, reason: expect.stringContaining('not a member of this space') });
    const unreadable = reader({ canPoll: { credentialId: 'x', reason: null }, spawnError: new Error('stored space credential is unreadable') });
    expect(await unreadable.reader.readPollToken(CLAIMS, SPACE))
      .toMatchObject({ ok: false, reason: expect.stringContaining('could not be read') });
  });
});

describe("readMemberToken — the caller's OWN credential in this space", () => {
  it('selects only credentials the caller owns, in this space, for github', async () => {
    const { reader: r, calls } = reader({ owned: [] });
    await r.readMemberToken(CLAIMS, SPACE);
    const [claims, sql, params] = calls.query[0]!;
    expect(claims).toBe(CLAIMS);
    expect(sql).toMatch(/owner_account_id = internal\.current_account_id\(\)/);
    expect(sql).toMatch(/provider = 'github'/);
    expect(params).toEqual([SPACE]);
  });

  it('prefers the my_default among owned active credentials', async () => {
    const { reader: r, calls } = reader({
      owned: [{ id: 'a', status: 'active', label: 'A' }, { id: 'b', status: 'active', label: 'B' }],
      myDefault: 'b',
    });
    expect(await r.readMemberToken(CLAIMS, SPACE)).toMatchObject({ ok: true, token: 'tok-b', credentialId: 'b' });
    expect(calls.readForSpawn).toEqual([[CLAIMS, SPACE, 'github', 'b']]);
  });

  it('a my_default the caller does not own is ignored — the oldest owned one merges', async () => {
    const { reader: r } = reader({ owned: [{ id: 'a', status: 'active', label: 'A' }], myDefault: 'space-owned' });
    expect(await r.readMemberToken(CLAIMS, SPACE)).toMatchObject({ ok: true, credentialId: 'a' });
  });

  it('none owned is `none`; only stale ones is `stale` with the label', async () => {
    expect(await reader({ owned: [] }).reader.readMemberToken(CLAIMS, SPACE)).toEqual({ ok: false, reason: 'none' });
    expect(await reader({ owned: [{ id: 's', status: 'stale', label: 'old' }] }).reader.readMemberToken(CLAIMS, SPACE))
      .toEqual({ ok: false, reason: 'stale', label: 'old' });
  });

  it('a credential revoked between the select and the read refuses as `none`', async () => {
    const revoked = new CollabError('invariant_violation', 'revoked', { details: { reason: 'revoked' } });
    const { reader: r } = reader({ owned: [{ id: 'a', status: 'active', label: 'A' }], spawnError: revoked });
    expect(await r.readMemberToken(CLAIMS, SPACE)).toEqual({ ok: false, reason: 'none' });
  });
});

describe('memberGithubRefusal names the fix', () => {
  it.each([
    [{ reason: 'none' as const }, 'connect a GitHub token under Space settings → Credentials (owned by you)'],
    [{ reason: 'stale' as const, label: 'p' }, '"p" in this space is stale — re-key it under Space settings → Credentials'],
    [{ reason: 'unreadable' as const, label: 'p' }, 'cannot be read on this node — re-key it under Space settings → Credentials'],
  ])('%j', (refusal, sentence) => {
    expect(memberGithubRefusal(refusal)).toContain(sentence);
  });
});
