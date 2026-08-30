// Where the tracking pollers get their GitHub token — and, more importantly,
// WHOSE token they are allowed to get.
//
// The defect these were written against: `resolveGithubToken()` read
// `process.env` and nothing else, and it was the only token source for the
// observer and the forge watcher. A per-account encrypted credential had been
// shipped (093), stored through the UI, and read by `tracking.pr.merge` — while
// the two pollers went on calling GitHub anonymously beside it for nineteen
// days and burned the host's shared 60-requests-per-hour budget.
//
// So the cases below are weighted toward the two things that make this change
// safe rather than merely working:
//
//   1. IT NEVER THROWS. A poller that dies on an unreadable credential stops
//      refreshing everything, which is strictly worse than refreshing
//      anonymously and saying so.
//   2. IT REPORTS ITS OWN STATE HONESTLY. `source` and `reason` are what land in
//      an operator-visible column; a resolver that guessed would poison the one
//      diagnostic this whole change exists to add.

import { describe, expect, it } from 'vitest';

import type { Db, DbClaims } from '../../src/db/types.js';
import {
  describeTrackingCredential,
  resolveTrackingCredential,
} from '../../src/tracking/credential.js';

const CLAIMS: DbClaims = { identityId: 'node-owner' };

/** Only `rpc` — the resolver reaches nothing else, through the store. */
function fakeDb(onRead: () => unknown): Db {
  return {
    rpc: async (_claims: DbClaims, fn: string) => {
      if (fn === 'read_account_git_credential') return onRead();
      return {};
    },
  } as unknown as Db;
}

describe('the tracking credential resolver', () => {
  it('prefers the environment, and never touches the database when it is set', async () => {
    // The override has to WIN, not merely exist: pointing one subsystem at a
    // narrow token without disturbing the box is a real operational need, and an
    // env var that silently lost to a database row would be a nasty surprise for
    // whoever is relying on it. Proven by a db that fails the test if reached.
    let reached = false;
    const db = fakeDb(() => { reached = true; return null; });

    const resolved = await resolveTrackingCredential({
      db, claims: CLAIMS, dataDir: '/nonexistent',
      env: { TM8_GITHUB_TOKEN: 'ghp_from_env' } as NodeJS.ProcessEnv,
    });

    expect(resolved).toMatchObject({ token: 'ghp_from_env', source: 'env' });
    expect(reached).toBe(false);
    expect(describeTrackingCredential(resolved)).toBe('authenticated from the environment');
  });

  it('accepts each of the three env spellings the old resolver honoured', async () => {
    const db = fakeDb(() => null);
    for (const name of ['TM8_GITHUB_TOKEN', 'GITHUB_TOKEN', 'GH_TOKEN']) {
      const resolved = await resolveTrackingCredential({
        db, claims: CLAIMS, dataDir: '/nonexistent',
        env: { [name]: 'ghp_x' } as NodeJS.ProcessEnv,
      });
      expect(resolved.source, name).toBe('env');
    }
  });

  it('falls back to ANONYMOUS, not to an error, when nothing is stored', async () => {
    // This is the ordinary state of a node whose operator has not connected
    // GitHub. It must keep working — 60/hour is a real budget — and it must say
    // what is wrong in a sentence an operator can act on.
    const resolved = await resolveTrackingCredential({
      db: fakeDb(() => null), claims: CLAIMS, dataDir: '/nonexistent', env: {} as NodeJS.ProcessEnv,
    });

    expect(resolved.token).toBeUndefined();
    expect(resolved.source).toBe('none');
    expect(resolved.reason).toMatch(/no stored GitHub credential/i);
    expect(resolved.reason).toMatch(/TM8_GITHUB_TOKEN/);
    expect(describeTrackingCredential(resolved)).toMatch(/UNAUTHENTICATED/);
    // The number is the whole point of the sentence: "rate limited" alone reads
    // as "GitHub is busy" when the content is "anonymous gets 60 an hour".
    expect(describeTrackingCredential(resolved)).toMatch(/60 requests\/hour/);
  });

  it('NEVER THROWS when the credential cannot be read — it degrades and explains', async () => {
    // Reachable in production by rotating the key file out from under a stored
    // token, and by any transient database error. Either must leave the poller
    // polling.
    const db = fakeDb(() => { throw new Error('stored GitHub credential is unreadable'); });

    const resolved = await resolveTrackingCredential({
      db, claims: CLAIMS, dataDir: '/nonexistent', env: {} as NodeJS.ProcessEnv,
    });

    expect(resolved.token).toBeUndefined();
    expect(resolved.source).toBe('none');
    expect(resolved.reason).toMatch(/could not be read/i);
    expect(resolved.reason).toMatch(/unreadable/);
  });

  it('says so when there is no data directory, rather than guessing at a key path', async () => {
    const resolved = await resolveTrackingCredential({
      db: fakeDb(() => null), claims: CLAIMS, dataDir: undefined, env: {} as NodeJS.ProcessEnv,
    });
    expect(resolved.source).toBe('none');
    expect(resolved.reason).toMatch(/no data directory/i);
  });

  it('resolves under the claims it was HANDED — the identity rule, as executable', async () => {
    // The rule is "the pollers authenticate as the node's own account and as no
    // one else", and it is enforced by `read_account_git_credential` deriving
    // the account from the transaction identity: there is no account parameter
    // to get wrong. This pins that the resolver passes its caller's claims
    // straight through and invents no identity of its own.
    let seen: DbClaims | undefined;
    const db = {
      rpc: async (claims: DbClaims, fn: string) => {
        if (fn === 'read_account_git_credential') { seen = claims; return null; }
        return {};
      },
    } as unknown as Db;

    await resolveTrackingCredential({
      db, claims: { identityId: 'node-owner', requestId: 'tracking-observer' },
      dataDir: '/nonexistent', env: {} as NodeJS.ProcessEnv,
    });

    expect(seen).toEqual({ identityId: 'node-owner', requestId: 'tracking-observer' });
  });

  it('describes an injected client as such, and never as authenticated', async () => {
    // A tick driven with a stub client resolved no credential at all. Reporting
    // that as `env` would put a false sentence into the operator-visible column
    // this whole change exists to make trustworthy.
    expect(describeTrackingCredential({ token: undefined, source: 'injected' }))
      .toMatch(/supplied directly/);
    expect(describeTrackingCredential({ token: undefined, source: 'injected' }))
      .not.toMatch(/authenticated as/);
  });
});
