/**
 * 992 (W7p, lead ruling A' and deny-by-default): a `link` session does nothing
 * on its own bearer. Two layers are celled here, each on its own:
 *
 * - Layer (ii), the registry: `HandlerRegistry.get` — the handler the frame
 *   dispatches — refuses a link identity on every operation (the allow-list
 *   is empty) before the handler runs. Driven in-process, so it is proven
 *   independently of layer (i)'s transport refusal
 *   (link-session-transport.test.ts).
 * - Layer (iii), defence in depth: `execution.spawn`, `execution.resume`,
 *   `execution.dispatch` and the spawn-credential read refuse a link bearer
 *   themselves. These cells call the RAW handler, past the registry, so each
 *   refusal is its own red.
 *
 * SQL's refusals (`read_space_credential_for_spawn`, the spawn-path mint) have
 * their cells in db/space-link-provenance.pg.test.ts. Every cell asserts the
 * downstream call never happened, and its control shows the same call
 * proceeding for a via_link agent (authKind `agent`), which the ruling still
 * admits.
 */
import { CollabError, getOperation, OPERATIONS, RESERVED_OPERATIONS, type OperationName } from '@tm8/contract';
import { describe, expect, it, vi } from 'vitest';
import { DbSpaceCredentialStore } from '../src/credentials/space-credential-store.js';
import type { Db, DbClaims, Querier } from '../src/db/types.js';
import { registerExecutionHandlers } from '../src/facade/execution-handlers.js';
import { HandlerRegistry } from '../src/facade/registry.js';
import type { RequestContext, RequestIdentity } from '../src/http/types.js';
import { LINK_BEARER_ALLOWED_OPS, LINK_BEARER_OP_REFUSED, LINK_BEARER_SPAWN_REFUSED } from '../src/identity/link-bearer.js';

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

/** The frame's registry, plus the raw handler past its default-deny. */
class RawRegistry extends HandlerRegistry {
  raw(name: OperationName) {
    return this.handlers.get(name);
  }
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
  const registry = new RawRegistry();
  const runtime = registerExecutionHandlers(registry, {
    db,
    pty: { liveSessionIds: () => [] } as never,
    config: { host: '127.0.0.1', port: 4610, uiDir: undefined, maxBodyBytes: 1024, databaseUrl: undefined },
    owner,
  });
  const spawn = vi.spyOn(runtime.spawnService, 'spawn').mockResolvedValue({ commandResult: {} } as never);
  const resume = vi.spyOn(runtime.spawnService, 'resume').mockResolvedValue({ commandResult: {} } as never);
  const startShell = vi.spyOn(runtime.spawnService, 'startShell').mockResolvedValue({ commandResult: {} } as never);
  /** Layer (iii): the raw handler, past the registry's default-deny. */
  const handler = (name: OperationName) => {
    const found = registry.raw(name);
    if (!found) throw new Error(`${name} was not registered`);
    return found;
  };
  /** Layer (ii): the handler the frame dispatches. */
  const framed = (name: OperationName) => {
    const found = registry.get(name);
    if (!found) throw new Error(`${name} was not registered`);
    return found;
  };
  return { handler, framed, spawn, resume, startShell, db };
}

async function rejection(run: () => unknown): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return 'resolved';
}

function expectOpRefusal(error: unknown): void {
  expect(error).toBeInstanceOf(CollabError);
  expect(error).toMatchObject({ code: 'forbidden', message: LINK_BEARER_OP_REFUSED, details: { sqlstate: '42501' } });
}

function expectLinkRefusal(error: unknown): void {
  expect(error).toBeInstanceOf(CollabError);
  expect(error).toMatchObject({ code: 'forbidden', message: LINK_BEARER_SPAWN_REFUSED, details: { sqlstate: '42501' } });
}

const spawnBody = { clientMutationId: 'mutation-w7p-link', spaceId: SPACE, teamMemberId: TEAMMATE };

describe('W7p layer (ii) — the registry refuses a link identity on every operation, before the handler', () => {
  it('the allow-list is empty in #898', () => {
    expect([...LINK_BEARER_ALLOWED_OPS]).toEqual([]);
  });

  it('execution.dispatch: 42501 before claimsFor, the anchor rpc or any spawn; a via_link agent proceeds', async () => {
    const f = fixture();
    const body = { clientMutationId: 'mutation-w7p-framed-dispatch', spaceId: SPACE, subjectId: TEAMMATE };
    expectOpRefusal(await rejection(() => f.framed('execution.dispatch')(context('execution.dispatch', linkBearer, body))));
    expect(f.db.rpc).not.toHaveBeenCalled();
    expect(f.db.tx).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
    expect(await rejection(() => f.framed('execution.dispatch')(context('execution.dispatch', viaLinkAgent, body))))
      .toMatchObject({ message: `derive_task_for_entity returned no task id for ${TEAMMATE}` });
    expect(vi.mocked(f.db.rpc).mock.calls[0]?.[1]).toBe('public.derive_task_for_entity');
  });

  it('execution.terminal.start: 42501 and no shell starts; a via_link agent starts one', async () => {
    const f = fixture();
    const body = { clientMutationId: 'mutation-w7p-framed-terminal', spaceId: SPACE };
    expectOpRefusal(await rejection(() =>
      f.framed('execution.terminal.start')(context('execution.terminal.start', linkBearer, body))));
    expect(f.startShell).not.toHaveBeenCalled();
    expect(f.db.tx).not.toHaveBeenCalled();
    await rejection(() => f.framed('execution.terminal.start')(context('execution.terminal.start', viaLinkAgent, body)));
    expect(f.startShell).toHaveBeenCalledOnce();
    expect(f.startShell.mock.calls[0]?.[0]).toMatchObject({ authKind: 'agent', viaLinkId: LINK });
  });

  // create_loop is reached through `entities.create` (kind loop) and a loop's
  // command/schedule through `entities.patch`; `entities.get` is the read.
  // The handler is a spy: the registry must refuse before it runs at all, so
  // nothing it would call (create_loop, the update, the read) can run either.
  const LOOP = '019f9896-928d-7e55-8f3a-6c1d2e3f4a5b';
  const spyCells: Array<{ label: string; op: OperationName; body: unknown; params?: Record<string, string> }> = [
    { label: 'create_loop (entities.create, kind loop)', op: 'entities.create',
      body: { clientMutationId: 'mutation-w7p-loop', spaceId: SPACE, kind: 'loop', title: 'w7p', schedule: '*/5 * * * *', command: 'echo hi' } },
    { label: 'a loop command/schedule update (entities.patch)', op: 'entities.patch',
      body: { clientMutationId: 'mutation-w7p-loop-update', schedule: '0 * * * *', command: 'echo bye' }, params: { id: LOOP } },
    { label: 'a READ (entities.get)', op: 'entities.get', body: undefined, params: { id: LOOP } },
  ];
  for (const cell of spyCells) {
    it(`${cell.label}: 42501 and the handler never runs; a via_link agent reaches it`, async () => {
      const registry = new HandlerRegistry();
      const spy = vi.fn(async () => ({ ok: true }));
      registry.register(cell.op, spy);
      expectOpRefusal(await rejection(() => registry.get(cell.op)!(context(cell.op, linkBearer, cell.body, cell.params))));
      expect(spy).not.toHaveBeenCalled();
      await registry.get(cell.op)!(context(cell.op, viaLinkAgent, cell.body, cell.params));
      expect(spy).toHaveBeenCalledOnce();
    });
  }

  it('every unlisted operation in the catalog gets the same 42501 shape, and its handler never runs', async () => {
    const reserved = new Set<string>(RESERVED_OPERATIONS.map((op) => op.name));
    const names = OPERATIONS.map((op) => op.name).filter((name) => !reserved.has(name) && !LINK_BEARER_ALLOWED_OPS.has(name));
    expect(names.length).toBeGreaterThan(100);
    const registry = new HandlerRegistry();
    const spy = vi.fn(async () => ({ ok: true }));
    for (const name of names) registry.register(name, spy);
    for (const name of names) {
      expectOpRefusal(await rejection(() => registry.get(name)!(context(name, linkBearer, {}))));
    }
    expect(spy).not.toHaveBeenCalled();
    for (const name of names) await registry.get(name)!(context(name, viaLinkAgent, {}));
    expect(spy).toHaveBeenCalledTimes(names.length);
  });
});

describe("W7p layer (iii) ruling A' — a link bearer spawns, resumes and reads a spawn credential nowhere", () => {
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

  it('execution.dispatch: a link bearer gets 42501 before the anchor rpc or any spawn; a via_link agent proceeds', async () => {
    const f = fixture();
    const body = { clientMutationId: 'mutation-w7p-link-dispatch', spaceId: SPACE, subjectId: TEAMMATE };
    expectLinkRefusal(await rejection(() => f.handler('execution.dispatch')(context('execution.dispatch', linkBearer, body))));
    expect(f.db.rpc).not.toHaveBeenCalled();
    expect(f.db.tx).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
    // Control: the same dispatch as a via_link agent reaches the anchor rpc
    // (the mock answers no task id, so it stops there, past the refusal).
    expect(await rejection(() => f.handler('execution.dispatch')(context('execution.dispatch', viaLinkAgent, body))))
      .toMatchObject({ message: `derive_task_for_entity returned no task id for ${TEAMMATE}` });
    expect(vi.mocked(f.db.rpc).mock.calls[0]?.[0]).toMatchObject({ authKind: 'agent', viaLinkId: LINK });
    expect(vi.mocked(f.db.rpc).mock.calls[0]?.[1]).toBe('public.derive_task_for_entity');
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
