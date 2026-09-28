/**
 * 256 (W7p, lead ruling A' and deny-by-default): a `link` session does nothing
 * on its own bearer. Two layers are celled here, each on its own:
 *
 * - Layer (ii), the registry: `HandlerRegistry.get` — the handler the frame
 *   dispatches — refuses a link identity on every operation (the allow-list
 *   is empty) before the handler runs. Driven in-process, so it is proven
 *   independently of layer (i)'s transport refusal
 *   (link-session-transport.test.ts).
 * - Layer (iii), defence in depth: `execution.resume` and
 *   `execution.dispatch` refuse a link bearer themselves; `execution.spawn`
 *   admits one only past SQL `admit_space_link_spawn` (W7b, 274: a live
 *   reservation made by `spaceLinks.invoke`), and the spawn-credential read is
 *   gated in SQL alone. These cells call the RAW handler, past the registry,
 *   so each refusal is its own red.
 *
 * SQL's refusals (`read_space_credential_for_spawn`, the spawn-path mint) have
 * their cells in db/space-link-provenance.pg.test.ts. Every cell asserts the
 * downstream call never happened, and its control shows the same call
 * proceeding for a via_link agent (authKind `agent`), which the ruling still
 * admits.
 */
import { CollabError, getOperation, OPERATIONS, RESERVED_OPERATIONS, type OperationName } from '@tm8/contract';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { DbSpaceCredentialStore } from '../src/credentials/space-credential-store.js';
import type { Db, DbClaims, Querier } from '../src/db/types.js';
import { registerExecutionHandlers } from '../src/facade/execution-handlers.js';
import { HandlerRegistry } from '../src/facade/registry.js';
import type { RequestContext, RequestIdentity } from '../src/http/types.js';
import { admitLinkInvoke, LINK_BEARER_OP_REFUSED, LINK_BEARER_SPAWN_REFUSED, LINK_BOUND_LAUNCH_REFUSED } from '../src/identity/link-bearer.js';

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
const plainAgent: RequestIdentity = {
  kind: 'bearer', identityId: 'identity-h', authKind: 'agent', sessionSpaceId: SPACE,
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

function expectLaunchRefusal(error: unknown): void {
  expect(error).toBeInstanceOf(CollabError);
  expect(error).toMatchObject({ code: 'forbidden', message: LINK_BOUND_LAUNCH_REFUSED, details: { sqlstate: '42501' } });
}

const spawnBody = { clientMutationId: 'mutation-w7p-link', spaceId: SPACE, teamMemberId: TEAMMATE };

describe('W7p layer (ii) — the registry refuses an unmarked link identity on every operation, before the handler', () => {

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

  it('execution.terminal.start: 42501 and no shell starts; an unlinked agent starts one (a via_link agent is refused at layer iii, W9 R-2)', async () => {
    const f = fixture();
    const body = { clientMutationId: 'mutation-w7p-framed-terminal', spaceId: SPACE };
    expectOpRefusal(await rejection(() =>
      f.framed('execution.terminal.start')(context('execution.terminal.start', linkBearer, body))));
    expect(f.startShell).not.toHaveBeenCalled();
    expect(f.db.tx).not.toHaveBeenCalled();
    await rejection(() => f.framed('execution.terminal.start')(context('execution.terminal.start', plainAgent, body)));
    expect(f.startShell).toHaveBeenCalledOnce();
    expect(f.startShell.mock.calls[0]?.[0]).toMatchObject({ authKind: 'agent' });
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

  it('every operation in the catalog gets the same 42501 shape, and its handler never runs', async () => {
    const reserved = new Set<string>(RESERVED_OPERATIONS.map((op) => op.name));
    const names = OPERATIONS.map((op) => op.name).filter((name) => !reserved.has(name));
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

/*
 * #884 (lead ruling (a)): the ONE admission of a link identity is the
 * in-process `spaceLinks.invoke` executor's marker — a module-private WeakMap
 * entry on the context object, bound to one op, consumed on first check.
 * Each refusal here has its paired positive; red-checked by making
 * `refuseLinkBearerOp` ignore the marker (every positive goes red) and by
 * dropping its consume/op-binding (the leak cells go red).
 */
describe('#884 layer (ii) — the in-process invoke marker', () => {
  function oneOp(op: OperationName = 'entities.get') {
    const registry = new HandlerRegistry();
    const spy = vi.fn(async (_ctx: RequestContext) => ({ ok: true }));
    registry.register(op, spy);
    return { registry, spy };
  }

  it('an unmarked link identity is refused on entities.get; positive — the same context, marked, runs as the link identity', async () => {
    const { registry, spy } = oneOp();
    expectOpRefusal(await rejection(() => registry.get('entities.get')!(context('entities.get', linkBearer, undefined, { id: LINK }))));
    expect(spy).not.toHaveBeenCalled();
    const ctx = context('entities.get', linkBearer, undefined, { id: LINK });
    admitLinkInvoke(ctx, 'entities.get');
    expect(await registry.get('entities.get')!(ctx)).toEqual({ ok: true });
    expect(spy).toHaveBeenCalledOnce();
    expect(spy.mock.calls[0]?.[0].identity).toMatchObject({ authKind: 'link' });
  });

  it('the marker is bound to its op: marked for entities.get, dispatched as credentials.status, refused; positive — the marked op runs', async () => {
    const registry = new HandlerRegistry();
    const cred = vi.fn(async () => ({ ok: true }));
    const read = vi.fn(async () => ({ ok: true }));
    registry.register('credentials.status', cred);
    registry.register('entities.get', read);
    const ctx = context('credentials.status', linkBearer, undefined);
    admitLinkInvoke(ctx, 'entities.get');
    expectOpRefusal(await rejection(() => registry.get('credentials.status')!(ctx)));
    expect(cred).not.toHaveBeenCalled();
    const ok = context('entities.get', linkBearer, undefined, { id: LINK });
    admitLinkInvoke(ok, 'entities.get');
    await registry.get('entities.get')!(ok);
    expect(read).toHaveBeenCalledOnce();
  });

  it('no leak — a nested registry.get from inside the marked handler, same context or a copy, is refused; positive — the outer dispatch ran', async () => {
    const registry = new HandlerRegistry();
    const inner = vi.fn(async () => ({ ok: true }));
    const nested: unknown[] = [];
    registry.register('entities.patch', inner);
    let depth = 0;
    registry.register('entities.get', async (ctx) => {
      // Bounded, so a leaked marker fails this cell instead of recursing forever.
      if (++depth > 1) return { nested: true };
      nested.push(await rejection(() => registry.get('entities.patch')!(ctx)));
      nested.push(await rejection(() => registry.get('entities.get')!(ctx)));
      nested.push(await rejection(() => registry.get('entities.get')!({ ...ctx })));
      return { outer: true };
    });
    const ctx = context('entities.get', linkBearer, undefined, { id: LINK });
    admitLinkInvoke(ctx, 'entities.get');
    expect(await registry.get('entities.get')!(ctx)).toEqual({ outer: true });
    expect(nested).toHaveLength(3);
    for (const error of nested) expectOpRefusal(error);
    expect(inner).not.toHaveBeenCalled();
  });

  it('one shot — a second dispatch of the same marked context is refused (a ledger replay or retry re-entering it finds nothing)', async () => {
    const { registry, spy } = oneOp();
    const ctx = context('entities.get', linkBearer, undefined, { id: LINK });
    admitLinkInvoke(ctx, 'entities.get');
    await registry.get('entities.get')!(ctx);
    expectOpRefusal(await rejection(() => registry.get('entities.get')!(ctx)));
    expect(spy).toHaveBeenCalledOnce();
  });

  it('a replayed request — a fresh context rebuilt from the same identity, body and headers — carries no marker and is refused', async () => {
    const { registry, spy } = oneOp('entities.create');
    const body = { clientMutationId: 'mutation-884-replay', spaceId: SPACE, kind: 'doc', title: 'replay' };
    const first = context('entities.create', linkBearer, body);
    admitLinkInvoke(first, 'entities.create');
    await registry.get('entities.create')!(first);
    const replay = JSON.parse(JSON.stringify(first)) as RequestContext;
    replay.query = new URLSearchParams();
    expectOpRefusal(await rejection(() => registry.get('entities.create')!(replay)));
    // Nothing on the wire shape can set it either: headers, a claim-shaped field or a body flag.
    const forged = context('entities.create', { ...linkBearer, linkInvoke: true } as RequestIdentity,
      { ...body, linkInvoke: true }, {});
    forged.headers = { 'x-tm8-link-invoke': 'entities.create', 'x-tm8-via': SPACE };
    expectOpRefusal(await rejection(() => registry.get('entities.create')!(forged)));
    expect(spy).toHaveBeenCalledOnce();
  });

  it('a marker on a NON-link identity changes nothing; positive — a via_link agent passes marked or not', async () => {
    const { registry, spy } = oneOp();
    const ctx = context('entities.get', viaLinkAgent, undefined, { id: LINK });
    admitLinkInvoke(ctx, 'entities.get');
    await registry.get('entities.get')!(ctx);
    await registry.get('entities.get')!(context('entities.get', viaLinkAgent, undefined, { id: LINK }));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('admitLinkInvoke is named once as an import and once as a call, in the spaceLinks.invoke executor only (identifiers, alias-proof)', () => {
    const src = fileURLToPath(new URL('../src', import.meta.url));
    // Code only: a comment may name it; an alias or re-export still has to.
    const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const named: Record<string, string[]> = {};
    const namespaceImports: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) { walk(path); continue; }
        if (!/\.ts$/.test(name)) continue;
        const text = code(readFileSync(path, 'utf8'));
        const rel = path.slice(src.length + 1);
        const hits = text.match(/[\w$]*admitLinkInvoke[\w$]*/g) ?? [];
        if (hits.length > 0) named[rel] = hits;
        // `import * as x` / `export *` of link-bearer would reach it without naming it.
        if (/(import\s*\*\s*as\s+[\w$]+|export\s*\*)[^;]*from\s*['"][^'"]*link-bearer(\.js)?['"]/.test(text)) namespaceImports.push(rel);
        if (/import\(\s*['"][^'"]*link-bearer(\.js)?['"]\s*\)/.test(text)) namespaceImports.push(rel);
      }
    };
    walk(src);
    expect(Object.keys(named).sort()).toEqual(['facade/handlers/w2/space-link-invoke.ts', 'identity/link-bearer.ts']);
    expect(named['identity/link-bearer.ts']).toEqual(['admitLinkInvoke']);
    expect(named['facade/handlers/w2/space-link-invoke.ts']).toEqual(['admitLinkInvoke', 'admitLinkInvoke']);
    const invoke = code(readFileSync(join(src, 'facade/handlers/w2/space-link-invoke.ts'), 'utf8'));
    expect(invoke.match(/import\s*\{[^}]*\badmitLinkInvoke\b[^}]*\}\s*from\s*'[^']*identity\/link-bearer\.js'/g)).toHaveLength(1);
    expect(invoke).not.toMatch(/\badmitLinkInvoke\s+as\b/);
    expect(invoke.match(/\badmitLinkInvoke\s*\(/g)).toHaveLength(1);
    expect(code(readFileSync(join(src, 'identity/link-bearer.ts'), 'utf8'))).toMatch(/export function admitLinkInvoke\(/);
    expect(namespaceImports).toEqual([]);
  });
});

describe("W7p layer (iii) ruling A' — a link bearer resumes nowhere and spawns only against a W7b reservation", () => {
  it('execution.spawn: a link bearer launches only past SQL admit_space_link_spawn (W7b); its refusal launches nothing', async () => {
    const f = fixture();
    const sqlRefusal = new CollabError('forbidden', 'no live spawn reservation', {
      details: { sqlstate: '42501', reason: 'spawn_unreserved' },
    });
    vi.mocked(f.db.rpc).mockRejectedValueOnce(sqlRefusal);
    expect(await rejection(() => f.handler('execution.spawn')(context('execution.spawn', linkBearer, spawnBody))))
      .toBe(sqlRefusal);
    expect(vi.mocked(f.db.rpc).mock.calls[0]?.[1]).toBe('admit_space_link_spawn');
    expect(vi.mocked(f.db.rpc).mock.calls[0]?.[2]).toEqual([SPACE, null, null]);
    expect(f.spawn).not.toHaveBeenCalled();
    // Paired positive: the same body, SQL admitting (a live reservation), launches.
    vi.mocked(f.db.rpc).mockResolvedValueOnce(undefined as never);
    await f.handler('execution.spawn')(context('execution.spawn', linkBearer, spawnBody));
    expect(f.spawn).toHaveBeenCalledOnce();
  });

  it('execution.spawn (W9 R-2): a via_link agent launches nothing and never reaches SQL; an unlinked agent launches', async () => {
    const f = fixture();
    expectLaunchRefusal(await rejection(() => f.handler('execution.spawn')(context('execution.spawn', viaLinkAgent, spawnBody))));
    expect(f.db.rpc).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
    await f.handler('execution.spawn')(context('execution.spawn', plainAgent, spawnBody));
    expect(f.db.rpc).not.toHaveBeenCalled();
    expect(f.spawn).toHaveBeenCalledOnce();
  });

  it('execution.terminal.start (W9 R-2): a link bearer and a via_link agent open no shell; an unlinked agent does', async () => {
    const f = fixture();
    const body = { clientMutationId: 'mutation-w7b-terminal', spaceId: SPACE };
    for (const identity of [linkBearer, viaLinkAgent]) {
      expectLaunchRefusal(await rejection(() =>
        f.handler('execution.terminal.start')(context('execution.terminal.start', identity, body))));
    }
    expect(f.startShell).not.toHaveBeenCalled();
    await rejection(() => f.handler('execution.terminal.start')(context('execution.terminal.start', plainAgent, body)));
    expect(f.startShell).toHaveBeenCalledOnce();
    expect(f.startShell.mock.calls[0]?.[0]).toMatchObject({ authKind: 'agent' });
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

  it('readForSpawn: SQL gates a link bearer (W7b reservation); both kinds reach read_space_credential_for_spawn', async () => {
    const rpc = vi.fn(async (..._args: unknown[]) => { throw new Error('reached read_space_credential_for_spawn'); });
    const store = new DbSpaceCredentialStore({ db: { rpc, query: vi.fn(), tx: vi.fn(), end: vi.fn() } as unknown as Db, dataDir: '/nonexistent' });
    const claims = (authKind: DbClaims['authKind']): DbClaims =>
      ({ identityId: 'identity-h', authKind, viaLinkId: LINK, sessionSpaceId: SPACE, requestId: 'request-w7p' }) as DbClaims;
    for (const kind of ['link', 'agent'] as const) {
      expect(await rejection(() => store.readForSpawn(claims(kind), SPACE, 'anthropic')))
        .toMatchObject({ message: 'reached read_space_credential_for_spawn' });
    }
    expect(rpc.mock.calls.map((call) => call[1])).toEqual(['read_space_credential_for_spawn', 'read_space_credential_for_spawn']);
  });
});
