/**
 * `DbServerStore.probe` runs ON THE NODE under the node's link-client policy
 * (`remoteLinkClientOptionsOf(config)`), so `tm8 server add` / `server probe`
 * answer "can this node reach it", and record it as `reachStatus`.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Db, DbClaims } from '../../src/db/types.js';
import { remoteLinkClientOptionsOf } from '../../src/remote/link-client.js';
import { DbServerStore } from '../../src/remote/server-store.js';

let server: Server;
let baseUrl: string;
let answer: unknown = { ok: true, server: 'tm8-server' };

beforeAll(async () => {
  server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/health' ? answer : { nope: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const claims: DbClaims = { identityId: 'h', authKind: 'browser' };

function fakeDb(marked: string[]): Db {
  return {
    rpc: async (_claims: DbClaims, fn: string, args: unknown[]) => {
      if (fn === 'get_server') return { id: args[0], name: 'peer', baseUrl, reachStatus: 'unknown' };
      if (fn === 'mark_server_reach') {
        marked.push(String(args[1]));
        return { id: args[0], name: 'peer', baseUrl, reachStatus: args[1] };
      }
      throw new Error(`unexpected rpc ${fn}`);
    },
  } as unknown as Db;
}

describe('servers.probe from the node', () => {
  it('under the default policy a loopback (or LAN) peer is unreachable, and that is recorded', async () => {
    const marked: string[] = [];
    const store = new DbServerStore({ db: fakeDb(marked), dataDir: '/nonexistent', client: remoteLinkClientOptionsOf({}) });
    const probe = await store.probe(claims, 'srv-1');
    expect(probe.outcome).toBe('unreachable');
    expect(probe.server.reachStatus).toBe('unreachable');
    expect(marked).toEqual(['unreachable']);
  });

  it('with the node\'s opt-in it reaches the peer; a tm8 /health is reachable with no reason', async () => {
    answer = { ok: true, server: 'tm8-server' };
    const marked: string[] = [];
    const store = new DbServerStore({
      db: fakeDb(marked), dataDir: '/nonexistent',
      client: remoteLinkClientOptionsOf({ remoteSpaceLinksAllowLoopback: true }),
    });
    const probe = await store.probe(claims, 'srv-1');
    expect(probe).toMatchObject({ outcome: 'response', server: { reachStatus: 'reachable' } });
    expect(probe.reason).toBeUndefined();
    expect(marked).toEqual(['reachable']);
  });

  it('something that answers but is not tm8 is reachable, with reason not_tm8', async () => {
    answer = { hello: 'world' };
    const store = new DbServerStore({
      db: fakeDb([]), dataDir: '/nonexistent',
      client: remoteLinkClientOptionsOf({ remoteSpaceLinksAllowLoopback: true }),
    });
    expect(await store.probe(claims, 'srv-1')).toMatchObject({ outcome: 'response', reason: 'not_tm8' });
  });
});
