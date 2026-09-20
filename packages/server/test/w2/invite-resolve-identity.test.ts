/**
 * `auth.invite.resolve` — CLAIM-FREE IS NOT CLAIM-BLIND (195, task 01a0baf5).
 *
 * The reported bug in one sentence: somebody redeemed a one-use invite, their
 * member row committed, they opened their own link again and were told "This
 * invite is used up". `preview_invite` could not see who was asking;
 * `redeem_invite` could, and answered `{joined:false}` for the same code in the
 * same second. 195 gave the SQL a `member` branch — and the branch is dead
 * unless THIS handler puts the caller's identity on the transaction.
 *
 * So these assert the wiring rather than the SQL, because the wiring is what a
 * later tidy-up would break. Two rules, and they pull in opposite directions:
 *
 *   - a request that HAS a session must bind that identity, or the fix is a
 *     no-op in the browser, which is where it was reported;
 *   - a request that has none must still be served, anonymously. This is not
 *     `claimsFor()` — that helper REFUSES an anonymous caller (`context.ts:72`)
 *     — because a join link is usually opened signed out, and refusing it would
 *     break the very journey being fixed.
 */
import { describe, expect, it } from 'vitest';

import type { InvitePreview, OperationName } from '@tm8/contract';
import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import { registerW2AuthHandlers } from '../../src/facade/handlers/w2/auth.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import type { RequestContext } from '../../src/http/types.js';

const IDENTITY = 'id_fa66226d-f157-4f51-b5ad-77ec0c359879';
const SPACE_ID = '00000000-0000-7000-8000-0000000000a1';
const CODE = 'inv_0000000000000000000000000000a1';

/** What SQL would answer a member; the handler passes it through untouched. */
const MEMBER: InvitePreview = { status: 'member', spaceId: SPACE_ID, spaceName: 'Syed' };

/** Records the claims of every rpc, which is the whole subject here. */
class ClaimRecordingDb implements Db {
  readonly calls: Array<{ claims: DbClaims; fn: string; args: readonly unknown[] }> = [];

  constructor(private readonly answer: unknown = MEMBER) {}

  private querier(claims: DbClaims): Querier {
    return {
      query: async <R>(): Promise<R[]> => [],
      rpc: async <T>(fn: string, args: readonly unknown[] = []): Promise<T> => {
        this.calls.push({ claims, fn, args });
        return this.answer as T;
      },
    };
  }

  async tx<T>(claims: DbClaims, fn: (q: Querier) => Promise<T>): Promise<T> {
    return fn(this.querier(claims));
  }

  async query<R>(_claims: DbClaims, _sql: string, _params: readonly unknown[] = []): Promise<R[]> {
    return [];
  }

  async rpc<T>(claims: DbClaims, fn: string, args: readonly unknown[] = []): Promise<T> {
    return this.querier(claims).rpc<T>(fn, args);
  }

  async end(): Promise<void> {}
}

function deps(db: Db): FacadeDeps {
  return {
    db,
    config: {
      host: '127.0.0.1',
      port: 0,
      uiDir: undefined,
      maxBodyBytes: 1024,
      databaseUrl: undefined,
    } as FacadeDeps['config'],
    owner: async () => {
      throw new Error('auth.invite.resolve must never need the loopback auto-owner');
    },
  };
}

function context(identity: RequestContext['identity']): RequestContext {
  const opName = 'auth.invite.resolve' as OperationName;
  return {
    op: { name: opName, method: 'POST', path: '/v2/auth/invite/resolve', kind: 'read', status: 'v2' },
    opName,
    params: {},
    query: new URLSearchParams(),
    body: { code: CODE },
    requestId: 'req-195',
    identity,
    headers: {},
    method: 'POST',
    path: '/v2/auth/invite/resolve',
  } as RequestContext;
}

async function resolveAs(db: ClaimRecordingDb, identity: RequestContext['identity']) {
  const registry = new HandlerRegistry();
  registerW2AuthHandlers(registry, deps(db));
  const handler = registry.get('auth.invite.resolve' as OperationName);
  expect(handler).toBeDefined();
  return handler!(context(identity));
}

describe('auth.invite.resolve forwards the caller it has (195)', () => {
  it('binds a bearer identity, so the member branch in SQL is reachable at all', async () => {
    const db = new ClaimRecordingDb();
    const result = await resolveAs(db, { kind: 'bearer', identityId: IDENTITY } as RequestContext['identity']);

    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]!.fn).toBe('preview_invite');
    expect(db.calls[0]!.args).toEqual([CODE]);
    // The one assertion the whole fix hangs from: without this claim,
    // `internal.identity_id()` is NULL and 195's branch can never fire.
    expect(db.calls[0]!.claims.identityId).toBe(IDENTITY);
    expect(result).toEqual(MEMBER);
  });

  it('serves an ANONYMOUS caller, and binds no identity for them', async () => {
    const db = new ClaimRecordingDb({ status: 'valid' });
    await resolveAs(db, { kind: 'anonymous' } as RequestContext['identity']);

    expect(db.calls).toHaveLength(1);
    // Not a refusal — `claimsFor()` would have thrown here, which is exactly
    // why this handler does not use it. A join link opened signed out is the
    // COMMON case, not an edge one.
    expect(db.calls[0]!.claims.identityId).toBeUndefined();
    expect(db.calls[0]!.claims.requestId).toBe('req-195');
  });

  it('binds an AUTO-OWNER identity too — the local node is where this bug bites hardest', async () => {
    // The arm the first cut of this handler dropped. `auto-owner` is the human
    // at the node's own UI, resolved with an `identityId` on the request
    // (`identity-resolver.ts:93`) — the same fact a bearer carries, arriving by
    // a different door. On a v1 local node EVERY browser request takes this
    // door, so forwarding only the bearer arm left the reported journey broken
    // on the deployment shape most likely to walk it: the owner redeems their
    // own one-use code and is then told it is used up.
    const db = new ClaimRecordingDb();
    const result = await resolveAs(db, {
      kind: 'auto-owner',
      identityId: IDENTITY,
      authKind: 'browser',
    } as RequestContext['identity']);

    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]!.fn).toBe('preview_invite');
    expect(db.calls[0]!.args).toEqual([CODE]);
    expect(db.calls[0]!.claims.identityId).toBe(IDENTITY);
    expect(result).toEqual(MEMBER);
    // And it got there off the REQUEST, never off a loopback owner lookup:
    // `deps.owner` throws, so reaching for it would have failed this test.
  });

  it('treats an auto-owner with no resolved identity as anonymous rather than refusing', async () => {
    const db = new ClaimRecordingDb({ status: 'valid' });
    await resolveAs(db, { kind: 'auto-owner' } as unknown as RequestContext['identity']);

    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]!.claims.identityId).toBeUndefined();
  });

  it('treats a bearer with no resolved identity as anonymous rather than refusing', async () => {
    // A half-resolved session must not be able to turn a working join link
    // into an error page: this read has no authorization to get wrong.
    const db = new ClaimRecordingDb({ status: 'valid' });
    await resolveAs(db, { kind: 'bearer' } as unknown as RequestContext['identity']);

    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]!.claims.identityId).toBeUndefined();
  });
});
