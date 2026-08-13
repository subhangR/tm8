import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  errorCode,
  startW3PublicServer,
  successData,
  type W3PublicServer,
} from './public-harness.js';

/**
 * THE FIRST-RUN CLAIM, AGAINST A REAL DATABASE.
 *
 * This is the acceptance proof for the bug the lane exists to close: a node
 * reached from anywhere other than its own machine showed a sign-in card for
 * an account that could not exist and could not be created. Every other test
 * for this feature runs in jsdom or against a fake; this one runs migration
 * `113_node_claim.sql` on real Postgres and drives the ceremony over the
 * production HTTP boundary.
 *
 * The two properties worth the file are the ones no unit test can reach:
 * `identity_id` survives the claim (so pre-claim work stays correctly
 * attributed), and the token is single-use under a real `update … where
 * used_at is null`.
 */
describe('first-run node claim, over the public surface', () => {
  let server: W3PublicServer;

  beforeAll(async () => {
    server = await startW3PublicServer('node_claim');
  }, 120_000);

  afterAll(async () => {
    await server?.close();
  });

  /** The plaintext the boot path printed and wrote at 0600. */
  async function setupToken(): Promise<string> {
    const raw = await readFile(join(server.dataDir, 'setup-token'), 'utf8');
    return raw.trim();
  }

  it('reports itself UNCLAIMED, with no credential of any kind', async () => {
    const status = successData<{ claimed: boolean; mode: string; signupPath: string }>(
      await server.request('GET', '/v2/auth/claim'),
    );
    expect(status).toEqual({ claimed: false, mode: 'single', signupPath: 'claim' });
  });

  it('minted a token, and stored ONLY its hash', async () => {
    const token = await setupToken();
    expect(token.startsWith('tm8c_')).toBe(true);

    const rows = await server.rows<{ token_hash: string; used_at: string | null }>(
      'select token_hash, used_at from public.node_claim_tokens',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.used_at).toBeNull();
    // The plaintext must not be recoverable from the database. A dump of an
    // unclaimed node is not a way to claim it.
    expect(rows[0]?.token_hash).not.toContain(token);
    expect(rows[0]?.token_hash).not.toContain(token.slice('tm8c_'.length));
  });

  it('refuses a wrong token without burning the real one', async () => {
    const response = await server.request('POST', '/v2/auth/claim', {
      token: 'tm8c_not-the-real-one',
      username: 'mallory',
      password: 'a-real-password-8+',
    });
    expect(errorCode(response)).toBe('unauthenticated');

    const rows = await server.rows<{ used_at: string | null }>(
      'select used_at from public.node_claim_tokens',
    );
    expect(rows[0]?.used_at).toBeNull();
  });

  it('claims the EXISTING owner row — identity_id survives, so attribution does', async () => {
    // Force the loopback owner bootstrap, then capture the identity every
    // pre-claim row in the graph is already attributed to.
    successData(await server.request('GET', '/v2/auth/session'));
    const before = await server.rows<{ identity_id: string; username: string; password_hash: string | null }>(
      'select identity_id, username, password_hash from public.accounts where is_owner',
    );
    expect(before).toHaveLength(1);
    expect(before[0]?.password_hash).toBeNull();
    const ownerIdentity = before[0]!.identity_id;

    const claimed = successData<{
      token: string;
      account: { identityId: string; username: string; isOwner: boolean; isNodeAdmin: boolean };
    }>(
      await server.request('POST', '/v2/auth/claim', {
        token: await setupToken(),
        username: 'amber',
        password: 'a-real-password-8+',
        displayName: 'Amber Example',
      }),
    );

    // Claiming signs you in.
    expect(claimed.token.startsWith('tm8s_')).toBe(true);
    // THE LOAD-BEARING ASSERTION. A claim that minted a new account would pass
    // every other check in this file and silently orphan everything the node
    // recorded before it.
    expect(claimed.account.identityId).toBe(ownerIdentity);
    expect(claimed.account.username).toBe('amber');
    expect(claimed.account.isOwner).toBe(true);
    expect(claimed.account.isNodeAdmin).toBe(true);

    const after = await server.rows<{ identity_id: string; password_hash: string | null }>(
      'select identity_id, password_hash from public.accounts where is_owner',
    );
    expect(after).toHaveLength(1);
    expect(after[0]?.identity_id).toBe(ownerIdentity);
    expect(after[0]?.password_hash).toMatch(/^scrypt\$/);
    // Still exactly one account: credentialled, never created.
    expect(await server.rows('select 1 from public.accounts')).toHaveLength(1);
  });

  it('now reports itself CLAIMED', async () => {
    const status = successData<{ claimed: boolean; signupPath: string }>(
      await server.request('GET', '/v2/auth/claim'),
    );
    expect(status.claimed).toBe(true);
    expect(status.signupPath).toBe('admin');
  });

  it('burned the token — the same one cannot claim twice', async () => {
    const response = await server.request('POST', '/v2/auth/claim', {
      token: await setupToken(),
      username: 'mallory',
      password: 'a-real-password-8+',
    });
    // `forbidden`, not `unauthenticated`, because `claim_node` re-asserts the
    // node is unclaimed BEFORE it burns the token — and that guard order is
    // deliberate: it is what makes a leaked token inert on a claimed node.
    //
    // Distinguishing this case leaks nothing. `auth.claim.status` reports
    // `claimed` to anonymous callers by design, so "this node is already
    // claimed" is a fact the caller can read directly, and saying it here is
    // more actionable than a generic credential refusal. The
    // no-enumeration rule that governs `auth.login` is about which ACCOUNTS
    // exist; it does not apply to a fact the node publishes.
    expect(errorCode(response)).toBe('forbidden');
    expect(await server.rows('select 1 from public.accounts')).toHaveLength(1);
  });

  it('the credential set by the claim actually logs in', async () => {
    const login = successData<{ token: string; account: { username: string } }>(
      await server.request('POST', '/v2/auth/login', {
        username: 'amber',
        password: 'a-real-password-8+',
        kind: 'cli',
      }),
    );
    expect(login.account.username).toBe('amber');
    expect(login.token.startsWith('tm8s_')).toBe(true);
  });
});
