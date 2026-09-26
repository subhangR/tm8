/**
 * 992 (W7p, lead ruling A'): a `link` session spawns nothing. The facade
 * refuses a link bearer at `execution.spawn`, at `execution.resume` and at the
 * spawn-credential read before anything else runs; SQL's own refusal in
 * `read_space_credential_for_spawn` has its cells in
 * db/space-link-provenance.pg.test.ts. Each refusal is its own red: every cell
 * asserts the downstream call never happened, and its control shows the same
 * call proceeding for a via_link agent (authKind `agent`), which the ruling
 * still admits.
 */
import { CollabError, getOperation, type OperationName } from '@tm8/contract';
import { describe, expect, it, vi } from 'vitest';
import { DbSpaceCredentialStore } from '../src/credentials/space-credential-store.js';
import type { Db, DbClaims, Querier } from '../src/db/types.js';
import { registerExecutionHandlers } from '../src/facade/execution-handlers.js';
import { HandlerRegistry } from '../src/facade/registry.js';
import type { RequestContext, RequestIdentity } from '../src/http/types.js';
import { LINK_BEARER_SPAWN_REFUSED } from '../src/identity/link-bearer.js';

const SPACE = '019f9896-928d-79b6-ba1c-1cdcc1d30a6f';
const TEAMMATE = '019f9896-928d-7c09-aac0-021c7d4652c6';
const SESSION = '019f9896-928d-7a24-848b-4c8fdd82b761';
const LINK = '019f9896-928d-7d11-9a2b-5b1e0c3f4a10';

const linkBearer: RequestIdentity = {
  kind: 'bearer', identityId: 'identity-h', authKind: 'link', sessionSpaceId: SPACE, viaLinkId: LINK,
};
const viaLinkAgent: RequestIdentity = {
  kind: 'bearer', identityId: 'identity-h', authKind: 'agent', sessionSpaceId: SPACE, viaLinkId: LINK,
};

function context(opName: OperationName, identity: RequestIdentity, body: unknown, params: Record<string, string> = {}): RequestContext {
  const op = getOperation(opName);
  return {
    op, opName, params, query: new URLSearchParams(), body,
    requestId: 'request-w7p-link-bearer', identity, headers: {}, method: op.method, path: op.path,
  };
}

function fixture() {
  const owner = vi.fn(async () => ({
    identityId: 'identity-owner', accountId: 'account-owner', username: 'owner', isNodeAdmin: true, isOwner: true,
  }));
  const q = { query: vi.fn(async () => []), rpc: vi.fn() } as unknown as Querier;
  const db = {
    tx: vi.fn(async (_claims, fn: (querier: Querier) => Promise<unknown>) => fn(q)),
    rpc: vi.fn(), query: vi.fn(), end: vi.fn(),
  } as unknown as Db;
  const registry = new HandlerRegistry();
  const runtime = registerExecutionHandlers(registry, {
    db,
    pty: { liveSessionIds: () => [] } as never,
    config: { host: '127.0.0.1', port: 4610, uiDir: undefined, maxBodyBytes: 1024, databaseUrl: undefined },
    owner,
  });
  const spawn = vi.spyOn(runtime.spawnService, 'spawn').mockResolvedValue({ commandResult: {} } as never);
  const resume = vi.spyOn(runtime.spawnService, 'resume').mockResolvedValue({ commandResult: {} } as never);
  const handler = (name: OperationName) => {
    const found = registry.get(name);
    if (!found) throw new Error(`${name} was not registered`);
    return found;
  };
  return { handler, spawn, resume };
}

async function rejection(run: () => unknown): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return 'resolved';
}

function expectLinkRefusal(error: unknown): void {
  expect(error).toBeInstanceOf(CollabError);
  expect(error).toMatchObject({ code: 'forbidden', message: LINK_BEARER_SPAWN_REFUSED, details: { sqlstate: '42501' } });
}

const spawnBody = { clientMutationId: 'mutation-w7p-link', spaceId: SPACE, teamMemberId: TEAMMATE };

describe("W7p ruling A' — a link bearer spawns, resumes and reads a spawn credential nowhere", () => {
  it('execution.spawn: a link bearer gets 42501 and nothing launches; a via_link agent launches', async () => {
    const f = fixture();
    expectLinkRefusal(await rejection(() => f.handler('execution.spawn')(context('execution.spawn', linkBearer, spawnBody))));
    expect(f.spawn).not.toHaveBeenCalled();
    await f.handler('execution.spawn')(context('execution.spawn', viaLinkAgent, spawnBody));
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.spawn.mock.calls[0]?.[0]).toMatchObject({ authKind: 'agent', viaLinkId: LINK });
  });

  it('execution.resume: a link bearer gets 42501 and nothing resumes; a via_link agent resumes', async () => {
    const f = fixture();
    const body = { clientMutationId: 'mutation-w7p-link-resume' };
    expectLinkRefusal(await rejection(() =>
      f.handler('execution.resume')(context('execution.resume', linkBearer, body, { id: SESSION }))));
    expect(f.resume).not.toHaveBeenCalled();
    await f.handler('execution.resume')(context('execution.resume', viaLinkAgent, body, { id: SESSION }));
    expect(f.resume).toHaveBeenCalledOnce();
    expect(f.resume.mock.calls[0]?.[0]).toMatchObject({ authKind: 'agent', viaLinkId: LINK });
  });

  it('readForSpawn: a link bearer gets 42501 before any database call; a via_link agent reaches 206', async () => {
    const rpc = vi.fn(async (..._args: unknown[]) => { throw new Error('reached read_space_credential_for_spawn'); });
    const store = new DbSpaceCredentialStore({ db: { rpc, query: vi.fn(), tx: vi.fn(), end: vi.fn() } as unknown as Db, dataDir: '/nonexistent' });
    const claims = (authKind: DbClaims['authKind']): DbClaims =>
      ({ identityId: 'identity-h', authKind, viaLinkId: LINK, sessionSpaceId: SPACE, requestId: 'request-w7p' }) as DbClaims;
    expectLinkRefusal(await rejection(() => store.readForSpawn(claims('link'), SPACE, 'anthropic')));
    expect(rpc).not.toHaveBeenCalled();
    expect(await rejection(() => store.readForSpawn(claims('agent'), SPACE, 'anthropic')))
      .toMatchObject({ message: 'reached read_space_credential_for_spawn' });
    expect(rpc.mock.calls[0]?.[1]).toBe('read_space_credential_for_spawn');
  });
});
