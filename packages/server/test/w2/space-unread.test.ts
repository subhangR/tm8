import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SPACE_UNREAD_COUNTS_LIMIT, SpaceUnreadCountsSchema } from '@tm8/contract';
import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import { registerW2IdentitySpacesHandlers } from '../../src/facade/handlers/w2/identity-spaces.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import { createFacadeServer, type FacadeServer } from '../../src/http/server.js';

const SPACE = '00000000-0000-7000-8000-000000000001';
const FOREIGN_SPACE = '00000000-0000-7000-8000-000000000002';
const ROOT = '00000000-0000-7000-8000-000000000003';

class RecordingDb implements Db {
  calls: Array<{ claims: DbClaims; sql: string; params: readonly unknown[] }> = [];
  unreadRows: Array<{ anchor_id: string; unread: number }> = [{ anchor_id: ROOT, unread: 3 }];
  async tx<T>(claims: DbClaims, fn: (q: Querier) => Promise<T>): Promise<T> {
    return fn({
      query: async <R>(sql: string, params: readonly unknown[] = []): Promise<R[]> => {
        this.calls.push({ claims, sql, params });
        if (sql.includes('from public.members')) {
          return (claims.identityId === 'viewer' && params[0] === SPACE ? [{ entity_id: ROOT }] : []) as R[];
        }
        if (sql.includes('public.unread_counts')) return this.unreadRows as R[];
        throw new Error(`Unexpected read: ${sql}`);
      },
      rpc: async () => { throw new Error('This read must issue no write RPC'); },
    });
  }
  async query<R>(): Promise<R[]> { throw new Error('Reads must share the viewer transaction'); }
  async rpc<T>(): Promise<T> { throw new Error('No independent RPC'); }
  async end(): Promise<void> {}
}

describe('spaces.unreadCounts HTTP reader contract', () => {
  const db = new RecordingDb();
  let server: FacadeServer;
  let url: string;
  beforeAll(async () => {
    const config = { host: '127.0.0.1', port: 0, uiDir: undefined, maxBodyBytes: 1024, databaseUrl: undefined };
    const deps: FacadeDeps = { db, config, owner: async () => ({
      identityId: 'owner', accountId: ROOT, username: 'owner', isNodeAdmin: true, isOwner: true,
    }) };
    const registry = new HandlerRegistry();
    registerW2IdentitySpacesHandlers(registry, deps);
    server = createFacadeServer({ config, registry, authRateLimiter: null,
      identityResolver: headers => headers.authorization ? {
        kind: 'bearer', identityId: headers.authorization.slice(7), nodeAdmin: false, authKind: 'cli',
      } : { kind: 'anonymous' },
    });
    url = (await server.listen()).url;
  });
  afterAll(async () => { await server.close(); });

  it('reads once under the authenticated viewer, with a bound result and no read-mark disclosure', async () => {
    db.calls = [];
    const response = await fetch(`${url}/v2/spaces/${SPACE}/unread-counts?memberId=somebody-else&actorId=${ROOT}`, {
      headers: { authorization: 'Bearer viewer' },
    });
    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(SpaceUnreadCountsSchema.parse(data)).toEqual({ spaceId: SPACE, complete: true,
      counts: [{ anchorId: ROOT, unread: 3 }],
    });
    expect(db.calls).toHaveLength(2);
    expect(db.calls.filter(call => call.sql.includes('public.unread_counts'))).toHaveLength(1);
    expect(db.calls[1]?.params).toEqual([SPACE, SPACE_UNREAD_COUNTS_LIMIT + 1]);
    for (const call of db.calls) expect(call.claims).toMatchObject({ identityId: 'viewer', nodeAdmin: false });
    expect(db.calls[0]?.params).toEqual([SPACE, 'viewer']);
    expect(JSON.stringify(data)).not.toMatch(/lastReadAt|memberId|authorId|identityId/);
  });

  it('rejects anonymous and nonmember/foreign-space reads before any unread scan', async () => {
    for (const [space, identity, status] of [[SPACE, null, 401], [SPACE, 'outsider', 403], [FOREIGN_SPACE, 'viewer', 403]] as const) {
      db.calls = [];
      const response = await fetch(`${url}/v2/spaces/${space}/unread-counts`, {
        headers: identity ? { authorization: `Bearer ${identity}` } : {},
      });
      expect(response.status).toBe(status);
      expect(db.calls.some(call => call.sql.includes('public.unread_counts'))).toBe(false);
    }
  });

  it('reports overflow as incomplete, never a complete sparse zero', async () => {
    db.unreadRows = Array.from({ length: SPACE_UNREAD_COUNTS_LIMIT + 1 }, () => ({ anchor_id: ROOT, unread: 1 }));
    const response = await fetch(`${url}/v2/spaces/${SPACE}/unread-counts`, { headers: { authorization: 'Bearer viewer' } });
    const { data } = await response.json();
    expect(response.status).toBe(200);
    expect(data.complete).toBe(false);
    expect(data.counts).toHaveLength(SPACE_UNREAD_COUNTS_LIMIT);
    expect(SpaceUnreadCountsSchema.safeParse(data).success).toBe(true);
  });
});
