/**
 * `tracking.pr.merge` — the guard order IS the contract:
 *
 *   observed-facts refusals (not_open / conflicted / ci_red) BEFORE the
 *   credential read, the credential refusal BEFORE any GitHub call, and the
 *   GitHub call pinned to the OBSERVED head sha unless the caller pinned one.
 *
 * Driven through the service with a scripted Db and injected write
 * client/credential store — the wire client's own vocabulary is pinned in
 * test/tracking/github-write.test.ts; this file pins how the handler
 * TRANSLATES it into the contract's error taxonomy.
 */
import { describe, expect, it } from 'vitest';
import { CollabError } from '@tm8/contract';
import { W2TrackingWriteService } from '../../src/facade/services/w2/tracking-write.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import type { RequestContext } from '../../src/http/types.js';

const PR_ID = '019f0000-0000-7000-8000-00000000aaaa';

interface Row {
  entity_id: string; repo: string; number: number; state: string;
  head_sha: string | null; ci_status: string | null; mergeable_state: string | null;
}

function row(over: Partial<Row> = {}): Row {
  return {
    entity_id: PR_ID, repo: 'octo/widgets', number: 7, state: 'open',
    head_sha: 'headsha1', ci_status: 'passing', mergeable_state: 'clean',
    ...over,
  };
}

function depsWith(rows: Row[], rpcs: { name: string; args: unknown }[] = []): FacadeDeps {
  return {
    db: {
      async tx(_claims: unknown, fn: (q: unknown) => Promise<unknown>) {
        return fn({
          rpc: async (name: string, args: unknown) => {
            rpcs.push({ name, args });
            return {};
          },
        });
      },
      async rpc() { return {}; },
      async query() { return rows as never; },
      async close() {},
    } as never,
    config: {} as never,
    owner: async () => ({ identityId: 'id_owner', accountId: 'acc_owner' }) as never,
  };
}

function ctxFor(body: Record<string, unknown> = {}): RequestContext {
  return {
    params: { id: PR_ID },
    body: { clientMutationId: 'mut-1', ...body },
    query: new URLSearchParams(),
    headers: {},
    identity: { kind: 'loopback' },
  } as never;
}

const CRED = { resolve: async () => ({ provider: 'github', login: 'alice', token: 'ghp_t' }) } as never;
const NO_CRED = { resolve: async () => null } as never;

function merging(outcome: unknown, calls: unknown[] = []) {
  return {
    mergePullRequest: async (request: unknown) => {
      calls.push(request);
      return outcome as never;
    },
  } as never;
}

async function failure(p: Promise<unknown>): Promise<CollabError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CollabError) return e;
    throw e;
  }
  throw new Error('expected a CollabError refusal');
}

describe('observed-facts guards, before credential and network', () => {
  it('a missing row is not_found', async () => {
    const service = new W2TrackingWriteService(depsWith([]), { credentials: CRED, writeClient: merging({}) });
    expect((await failure(service.mergePr(ctxFor()))).code).toBe('not_found');
  });

  it.each([['merged'], ['closed'], ['draft']])('state %s refuses as not_open', async (state) => {
    const calls: unknown[] = [];
    const service = new W2TrackingWriteService(depsWith([row({ state })]), { credentials: CRED, writeClient: merging({}, calls) });
    const err = await failure(service.mergePr(ctxFor()));
    expect(err.code).toBe('invariant_violation');
    expect(err.details).toMatchObject({ reason: 'not_open', state });
    expect(calls).toHaveLength(0);
  });

  it('observed conflicts refuse before any network', async () => {
    const calls: unknown[] = [];
    const service = new W2TrackingWriteService(depsWith([row({ mergeable_state: 'dirty' })]), { credentials: CRED, writeClient: merging({}, calls) });
    const err = await failure(service.mergePr(ctxFor()));
    expect(err.details).toMatchObject({ reason: 'conflicted' });
    expect(calls).toHaveLength(0);
  });

  it('observed CI red refuses before any network', async () => {
    const calls: unknown[] = [];
    const service = new W2TrackingWriteService(depsWith([row({ ci_status: 'failing' })]), { credentials: CRED, writeClient: merging({}, calls) });
    const err = await failure(service.mergePr(ctxFor()));
    expect(err.details).toMatchObject({ reason: 'ci_red' });
    expect(calls).toHaveLength(0);
  });

  it('no stored member credential is forbidden with the reason named — never a node-token fallback', async () => {
    const calls: unknown[] = [];
    const service = new W2TrackingWriteService(depsWith([row()]), { credentials: NO_CRED, writeClient: merging({}, calls) });
    const err = await failure(service.mergePr(ctxFor()));
    expect(err.code).toBe('forbidden');
    expect(err.details).toMatchObject({ reason: 'no_github_credential' });
    expect(calls).toHaveLength(0);
  });
});

describe('the merge call and the loop closure', () => {
  it('pins the OBSERVED head when the caller pinned none, and queues the observer refresh', async () => {
    const calls: { expectedHeadSha?: string; token?: string }[] = [];
    const rpcs: { name: string; args: unknown }[] = [];
    const service = new W2TrackingWriteService(depsWith([row()], rpcs), {
      credentials: CRED,
      writeClient: merging({ ok: true, value: { sha: 'mergesha', merged: true, message: 'ok' } }, calls),
    });
    const result = await service.mergePr(ctxFor());
    expect(result).toMatchObject({ entityId: PR_ID, repo: 'octo/widgets', number: 7, merged: true, mergeSha: 'mergesha' });
    expect(calls[0]).toMatchObject({ expectedHeadSha: 'headsha1', token: 'ghp_t' });
    expect(rpcs[0]).toMatchObject({ name: 'queue_tracking_refresh' });
    expect((rpcs[0]!.args as unknown[])[0]).toEqual([PR_ID]);
  });

  it('a caller-pinned sha wins over the observed head', async () => {
    const calls: { expectedHeadSha?: string }[] = [];
    const service = new W2TrackingWriteService(depsWith([row()]), {
      credentials: CRED,
      writeClient: merging({ ok: true, value: { sha: 's', merged: true, message: 'ok' } }, calls),
    });
    await service.mergePr(ctxFor({ headSha: 'reviewed9' }));
    expect(calls[0]).toMatchObject({ expectedHeadSha: 'reviewed9' });
  });

  it.each([
    ['method_blocked', 'invariant_violation', 'forge_blocked'],
    ['head_moved', 'conflict', 'head_moved'],
  ] as const)('forge %s becomes %s', async (reason, code, detailReason) => {
    const service = new W2TrackingWriteService(depsWith([row()]), {
      credentials: CRED,
      writeClient: merging({ ok: false, reason, detail: 'why' }),
    });
    const err = await failure(service.mergePr(ctxFor()));
    expect(err.code).toBe(code);
    expect(err.details ?? { reason: detailReason }).toMatchObject({ reason: detailReason });
  });

  it.each([
    ['unauthorized', 'forbidden'],
    ['rate_limited', 'rate_limited'],
    ['not_found', 'not_found'],
    ['unavailable', 'upstream_unavailable'],
  ] as const)('forge %s becomes %s', async (reason, code) => {
    const service = new W2TrackingWriteService(depsWith([row()]), {
      credentials: CRED,
      writeClient: merging({ ok: false, reason, detail: 'why' }),
    });
    expect((await failure(service.mergePr(ctxFor()))).code).toBe(code);
  });
});
