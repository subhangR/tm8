/**
 * 01a0fb59-ed94 (G6, #841) — the composed account-disable and member-removal
 * paths run space-credential containment AFTER the SQL that revoked the tokens.
 *
 * The SQL half (which sessions a disable or a membership end lists, space-
 * credential launches included) is pinned by member-tombstone.pg.test.ts and
 * space-credential-member-containment.pg.test.ts. This pins the TS half: each
 * of the three production ops — `accounts.disable`, `spaces.members.remove`,
 * `spaces.leave` — hands every listed session to the PTY port, and every
 * session on a revoked credential to containment, only after its RPC returned.
 * Drop any one of those calls and its cell goes red.
 */
import { describe, expect, it } from 'vitest';

import type { FacadeDeps } from '../../src/facade/deps.js';
import type { HandlerRegistry } from '../../src/facade/registry.js';
import type { RequestContext } from '../../src/http/types.js';
import { registerMembershipHandlers } from '../../src/membership/handlers.js';

const SPACE = '01a0fe00-0000-7000-8000-000000000001';
const MEMBER = '01a0fe00-0000-7000-8000-000000000002';
const ACCOUNT = '01a0fe00-0000-7000-8000-000000000003';

type Handler = (ctx: RequestContext) => Promise<unknown>;

function harness(rpcResult: Record<string, unknown>) {
  const calls: string[] = [];
  const handlers = new Map<string, Handler>();
  const registry = { register: (name: string, fn: Handler) => handlers.set(name, fn) } as unknown as HandlerRegistry;
  const facade = {
    owner: async () => ({ identityId: 'owner-identity', isNodeAdmin: true }),
    db: {
      rpc: async (_claims: unknown, fn: string) => {
        calls.push(`rpc:${fn}`);
        return rpcResult;
      },
    },
  } as unknown as FacadeDeps;
  registerMembershipHandlers(registry, facade, {
    sessions: {
      killRecordedEnding: async (id) => {
        calls.push(`kill:${id}`);
        return 'killed';
      },
      containCredentialSession: async (id, cause) => {
        calls.push(`contain:${id}:${cause}`);
        return { outcome: 'killed' };
      },
    },
    removeCredentialHome: async (home) => {
      calls.push(`home:${home.credentialId}`);
    },
    log: () => undefined,
  });
  const run = (op: string, params: Record<string, string>) =>
    handlers.get(op)!({
      params,
      body: { clientMutationId: 'm-1' },
      requestId: 'req-1',
      identity: { kind: 'bearer', identityId: 'admin-identity', nodeAdmin: true, authKind: 'browser' },
    } as unknown as RequestContext);
  return { calls, run };
}

const listed = {
  stoppedSessionIds: ['own-1', 'own-2'],
  credentialSessionIds: ['other-on-revoked'],
  credentialHomes: [],
};

describe('containment after token revocation, on every composed path', () => {
  it('accounts.disable: the RPC first, then every session the account launched is contained, then sessions on its revoked credentials', async () => {
    const h = harness({ ...listed, accountId: ACCOUNT, status: 'disabled', identityId: 'x', revokedSessionCount: 1 });
    await h.run('accounts.disable', { accountId: ACCOUNT });
    expect(h.calls).toEqual([
      'rpc:disable_account',
      'contain:own-1:member_removed',
      'contain:own-2:member_removed',
      'contain:other-on-revoked:space_credential_deleted',
    ]);
  });

  it('spaces.members.remove: the RPC first, then the removed member\'s sessions are killed, then sessions on its revoked credentials contained', async () => {
    const h = harness({ ...listed, spaceId: SPACE, identityId: 'x' });
    await h.run('spaces.members.remove', { spaceId: SPACE, memberId: MEMBER });
    expect(h.calls).toEqual([
      'rpc:remove_space_member',
      'kill:own-1',
      'kill:own-2',
      'contain:other-on-revoked:space_credential_deleted',
    ]);
  });

  it('spaces.leave: the same order as a removal', async () => {
    const h = harness({ ...listed, spaceId: SPACE, identityId: 'x' });
    await h.run('spaces.leave', { spaceId: SPACE });
    expect(h.calls).toEqual([
      'rpc:leave_space',
      'kill:own-1',
      'kill:own-2',
      'contain:other-on-revoked:space_credential_deleted',
    ]);
  });
});
