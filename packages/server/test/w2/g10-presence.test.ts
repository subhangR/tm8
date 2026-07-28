/**
 * W2.G10 — the ephemeral presence store, and the ORDER `presence.get` does
 * things in.
 *
 * This file exists because I shipped `presence.ts` and the `presence.get`
 * handler with no tests at all, which meant the store's eviction, dedupe and
 * retraction behaviour, and — much more importantly — the authorization
 * ORDERING in `readPresence`, were entirely unverified. Presence is the one
 * read here whose data lives OUTSIDE the database, so no RLS policy can catch
 * a mistake in it: if the store is consulted before the caller's right to see
 * the entity is established, the leak happens in process memory where the
 * database never gets a vote.
 */
import { describe, expect, it } from 'vitest';
import { CollabError, type OperationBinding, type OperationName } from '@tm8/contract';

import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import { registerEventHandlers } from '../../src/events/handlers.js';
import { InMemoryPresenceStore } from '../../src/events/presence.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import type { ServerConfig } from '../../src/http/config.js';
import type { RequestContext } from '../../src/http/types.js';

const CONFIG = { host: '127.0.0.1', port: 0, uiDir: undefined, maxBodyBytes: 1024 } as unknown as ServerConfig;
const ENTITY = '00000000-0000-7000-8000-000000000001';
const SPACE = '00000000-0000-7000-8000-0000000000aa';

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

describe('W2.G10 InMemoryPresenceStore', () => {
  const at = (i: number): number => 1_000_000 + i;

  it('counts one identity with several connections as ONE viewer', () => {
    // Three tabs is one person. Counting connections would inflate every
    // presence display, and the inflation would look like real activity.
    const store = new InMemoryPresenceStore({ now: () => at(0) });
    for (const connId of ['c1', 'c2', 'c3']) {
      store.set({ spaceId: SPACE, entityId: ENTITY, connId, identityId: 'ident_a', viewing: true, typing: false });
    }
    expect(store.at(SPACE, ENTITY).viewerIdentityIds).toEqual(['ident_a']);
  });

  it('treats neither-viewing-nor-typing as a RETRACTION, not as presence', () => {
    const store = new InMemoryPresenceStore({ now: () => at(0) });
    store.set({ spaceId: SPACE, entityId: ENTITY, connId: 'c1', identityId: 'ident_a', viewing: true, typing: false });
    expect(store.at(SPACE, ENTITY).viewerIdentityIds).toEqual(['ident_a']);

    store.set({ spaceId: SPACE, entityId: ENTITY, connId: 'c1', identityId: 'ident_a', viewing: false, typing: false });
    expect(store.at(SPACE, ENTITY).viewerIdentityIds, 'a retraction must remove, not idle').toEqual([]);
  });

  it('forgets everything a connection asserted when it closes', () => {
    const store = new InMemoryPresenceStore({ now: () => at(0) });
    store.set({ spaceId: SPACE, entityId: ENTITY, connId: 'c1', identityId: 'ident_a', viewing: true, typing: true });
    store.set({ spaceId: SPACE, entityId: 'other', connId: 'c1', identityId: 'ident_a', viewing: true, typing: false });
    store.set({ spaceId: SPACE, entityId: ENTITY, connId: 'c2', identityId: 'ident_b', viewing: true, typing: false });

    store.dropConnection('c1');

    // c1 is gone from BOTH entities it asserted at...
    expect(store.at(SPACE, ENTITY).viewerIdentityIds).toEqual(['ident_b']);
    expect(store.at(SPACE, 'other').viewerIdentityIds).toEqual([]);
    // ...and c2, the positive half, is untouched. A drop that cleared
    // everything would pass the first two assertions on its own.
    expect(store.at(SPACE, ENTITY).typingIdentityIds).toEqual([]);
  });

  it('evicts presence that has gone stale, and keeps presence that has not', () => {
    let clock = at(0);
    const store = new InMemoryPresenceStore({ staleAfterMs: 100, now: () => clock });
    store.set({ spaceId: SPACE, entityId: ENTITY, connId: 'old', identityId: 'ident_old', viewing: true, typing: false });

    clock += 500;
    store.set({ spaceId: SPACE, entityId: ENTITY, connId: 'new', identityId: 'ident_new', viewing: true, typing: false });

    // The stale one is gone; the fresh one — the positive half — survives.
    expect(store.at(SPACE, ENTITY).viewerIdentityIds).toEqual(['ident_new']);
  });

  it('never counts a connection with no bound identity as a viewer', () => {
    // An unauthenticated socket must not be able to manufacture a viewer.
    const store = new InMemoryPresenceStore({ now: () => at(0) });
    store.set({ spaceId: SPACE, entityId: ENTITY, connId: 'anon', identityId: undefined, viewing: true, typing: true });
    const snapshot = store.at(SPACE, ENTITY);
    expect(snapshot.viewerIdentityIds).toEqual([]);
    expect(snapshot.typingIdentityIds).toEqual([]);
  });

  it('keys by (spaceId, entityId), so a wrongly-claimed Space lands in a bucket nobody reads', () => {
    // `presence.set` carries a Space that is AUTHORIZED but not trusted as a
    // fact about where the entity lives; `presence.get` resolves the entity's
    // real Space and reads there. This is what makes the lie self-neutralizing.
    const store = new InMemoryPresenceStore({ now: () => at(0) });
    store.set({ spaceId: 'wrong_space', entityId: ENTITY, connId: 'c1', identityId: 'ident_a', viewing: true, typing: false });

    expect(store.at(SPACE, ENTITY).viewerIdentityIds, 'must not surface under the real Space').toEqual([]);
    expect(store.at('wrong_space', ENTITY).viewerIdentityIds).toEqual(['ident_a']);
  });
});

// ---------------------------------------------------------------------------
// presence.get — the ordering is the security property
// ---------------------------------------------------------------------------

/** Records the order of reads so the test can assert what happened FIRST. */
function fakeDb(rows: Record<string, unknown>[]): Db & { sql: string[] } {
  const sql: string[] = [];
  const querier: Querier = {
    query: <R>(text: string): Promise<R[]> => {
      sql.push(text.trim().split('\n')[0]!.trim());
      return Promise.resolve((text.includes('from public.entities') ? rows : []) as R[]);
    },
    rpc: <T>(): Promise<T> => Promise.resolve({} as T),
  };
  return {
    sql,
    tx: <T>(_c: DbClaims, fn: (q: Querier) => Promise<T>): Promise<T> => fn(querier),
    query: <R>(): Promise<R[]> => Promise.resolve([] as R[]),
    rpc: <T>(): Promise<T> => Promise.resolve({} as T),
    end: (): Promise<void> => Promise.resolve(),
  };
}

function ctxFor(id: string): RequestContext {
  return {
    op: { name: 'presence.get' } as unknown as OperationBinding,
    opName: 'presence.get' as OperationName,
    params: { id },
    query: new URLSearchParams(),
    body: undefined,
    requestId: 'req_test',
    identity: { kind: 'auto-owner', identityId: 'ident_caller' },
    headers: {},
    method: 'GET',
    path: `/v2/entities/${id}/presence`,
  } as unknown as RequestContext;
}

const owner = () => Promise.resolve({
  identityId: 'ident_caller', accountId: 'acct', username: 'owner', isNodeAdmin: false, isOwner: true,
});

function mount(db: Db & { sql: string[] }, presence: InMemoryPresenceStore) {
  const registry = new HandlerRegistry();
  registerEventHandlers(registry, { db, config: CONFIG, owner, presence });
  return registry.get('presence.get' as OperationName)!;
}

describe('W2.G10 presence.get authorization ordering', () => {
  it('does NOT consult the presence store for an entity the caller cannot see', async () => {
    // The store is populated. RLS returns no entity row. The snapshot must not
    // leak, and — the sharper claim — the store must not even be READ, because
    // presence lives outside the database and no policy can catch a late read.
    const presence = new InMemoryPresenceStore();
    presence.set({ spaceId: SPACE, entityId: ENTITY, connId: 'c1', identityId: 'ident_watcher', viewing: true, typing: false });

    let consulted = false;
    const spy = new Proxy(presence, {
      get(target, prop, receiver) {
        if (prop === 'at') consulted = true;
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });

    const handler = mount(fakeDb([]), spy as InMemoryPresenceStore);
    await expect(handler(ctxFor(ENTITY))).rejects.toBeInstanceOf(CollabError);
    expect(consulted, 'the store must not be read before authorization decides').toBe(false);
  });

  it('reports an invisible entity as not_found, never as an empty snapshot', async () => {
    // An empty snapshot would confirm the entity exists and is simply unwatched.
    const handler = mount(fakeDb([]), new InMemoryPresenceStore());
    await expect(handler(ctxFor(ENTITY))).rejects.toMatchObject({ code: 'not_found' });
  });

  it('rejects a non-uuid id as not_found rather than letting Postgres raise 22P02', async () => {
    const db = fakeDb([{ space_id: SPACE }]);
    const handler = mount(db, new InMemoryPresenceStore());
    await expect(handler(ctxFor('not-a-uuid'))).rejects.toMatchObject({ code: 'not_found' });
    expect(db.sql, 'a malformed id must not reach the database at all').toEqual([]);
  });

  it('serves the snapshot when the entity IS visible — the positive half', async () => {
    // Without this, every assertion above would pass against a handler that
    // refused everyone.
    const db = fakeDb([{ space_id: SPACE }]);
    const handler = mount(db, new InMemoryPresenceStore());
    const result = await handler(ctxFor(ENTITY)) as { kind: string; data: unknown };

    expect(result.data).toMatchObject({ viewers: [], typingActorIds: [] });
    // It got there by READING THE ENTITY FIRST — the entity read is the
    // authorization, and it is the first thing that touched the database.
    expect(db.sql[0]).toContain('from public.entities');
  });
});
