/**
 * 992 (W7p, deny-by-default, layer (i)): a `link` session's token is refused
 * on every wire. Every inbound entry resolves a bearer through ONE closure,
 * `createSessionIdentityResolver` — the HTTP facade, the PUT file upload, the
 * POST clipboard upload, the relay and both WebSocket upgrades
 * (`createSocketIdentityResolver`) — and the refusal sits in that closure,
 * not in the shared `resolveBearerIdentity` that `DbSpaceLinkStore.use` calls
 * in-process (the pg cell in db/space-link-provenance.pg.test.ts shows `use()`
 * still resolving the same token).
 *
 * The database is a stub that answers `resolve_auth_session` with a session
 * row of the kind under test and records every rpc: a refused request reaches
 * no route, no handler and no rpc beyond the resolution itself. Each control
 * is the same request from a via_link agent (authKind `agent`), which passes.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { TM8_CLIENT_HEADER, TM8_CLIENT_HEADER_VALUE } from '@tm8/contract';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db, Querier } from '../src/db/types.js';
import { createWsServer } from '../src/events/ws-server.js';
import { HandlerRegistry } from '../src/facade/registry.js';
import { CLIPBOARD_UPLOAD_PATH } from '../src/http/clipboard-upload.js';
import type { ServerConfig } from '../src/http/config.js';
import { createSessionIdentityResolver, createSocketIdentityResolver } from '../src/http/identity-resolver.js';
import { createFacadeServer, type FacadeServer } from '../src/http/server.js';
import { formatToken, generateSecret } from '../src/identity/crypto.js';
import { LINK_BEARER_TRANSPORT_REFUSED } from '../src/identity/link-bearer.js';

const SPACE = '019f9896-928d-79b6-ba1c-1cdcc1d30a6f';
const LINK = '019f9896-928d-7d11-9a2b-5b1e0c3f4a10';
const ENTITY = '019f9896-928d-7e55-8f3a-6c1d2e3f4a5b';

const CONFIG: ServerConfig = {
  host: '127.0.0.1', port: 0, uiDir: undefined, maxBodyBytes: 1024 * 1024, databaseUrl: undefined,
};

/** A session row of `kind`, carrying the link, and a db stub that records every rpc. */
function stub(kind: 'link' | 'agent') {
  const sessionId = randomUUID();
  const token = formatToken(sessionId, generateSecret());
  const rpcs: string[] = [];
  const row = {
    sessionId, accountId: 'account-h', identityId: 'identity-h', username: 'h', displayName: null,
    isNodeAdmin: false, isOwner: false, kind, actingAsTeamMemberId: null,
    workSessionId: null, runtimeMemberId: null, runtimeThreadRootId: null, runtimeChatId: null,
    spaceId: SPACE, viaLinkId: LINK, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), label: null,
  };
  const q = {
    rpc: vi.fn(async (name: string) => { rpcs.push(name); return name === 'resolve_auth_session' ? row : null; }),
    query: vi.fn(async () => { rpcs.push('query'); return []; }),
  } as unknown as Querier;
  const db = {
    tx: vi.fn(async (_claims: unknown, fn: (querier: Querier) => Promise<unknown>) => fn(q)),
    rpc: vi.fn(async (_claims: unknown, name: string) => { rpcs.push(name); return null; }),
    query: vi.fn(async () => { rpcs.push('query'); return []; }),
    end: vi.fn(),
  } as unknown as Db;
  const resolver = createSessionIdentityResolver({
    db, owner: async () => { throw new Error('the owner arm is not under test'); },
  });
  return { token, rpcs, resolver };
}

/** Only the resolution itself may have touched the database. */
function onlyResolution(rpcs: string[]): void {
  expect(rpcs.filter((name) => name !== 'resolve_auth_session' && name !== 'touch_auth_session')).toEqual([]);
  expect(rpcs).toContain('resolve_auth_session');
}

let server: FacadeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function serve(kind: 'link' | 'agent') {
  const s = stub(kind);
  const upload = vi.fn(async (_req: IncomingMessage, res: import('node:http').ServerResponse) => {
    res.writeHead(204).end();
    return true;
  });
  const clipboard = vi.fn(async (_req: IncomingMessage, res: import('node:http').ServerResponse) => {
    res.writeHead(204).end();
    return true;
  });
  const handler = vi.fn(async () => ({ ok: true }));
  const registry = new HandlerRegistry().register('entities.get', handler);
  server = createFacadeServer({
    config: CONFIG, registry, identityResolver: s.resolver,
    fileUploadRoute: upload, clipboardUploadRoute: clipboard, authRateLimiter: null,
  });
  const { url } = await server.listen();
  const headers = { authorization: `Bearer ${s.token}`, [TM8_CLIENT_HEADER]: TM8_CLIENT_HEADER_VALUE };
  return { ...s, url, headers, upload, clipboard, handler };
}

async function refusal(res: Response): Promise<void> {
  expect(res.status).toBe(403);
  const body = await res.json() as { error?: { code?: string; message?: string; details?: { sqlstate?: string } } };
  expect(body.error).toMatchObject({ code: 'forbidden', message: LINK_BEARER_TRANSPORT_REFUSED, details: { sqlstate: '42501' } });
}

const ROUTES = [
  { label: 'a facade op (GET entities.get)', method: 'GET', path: `/v2/entities/${ENTITY}`, reached: 'handler' },
  { label: 'the PUT file upload', method: 'PUT', path: `/v2/files/uploads/${ENTITY}/content`, reached: 'upload' },
  { label: 'the POST clipboard upload', method: 'POST', path: CLIPBOARD_UPLOAD_PATH, reached: 'clipboard' },
] as const;

describe('W7p layer (i) — a link session token is refused on every wire, before any route or write', () => {
  for (const route of ROUTES) {
    it(`${route.label}: 403/42501 before the route runs; a via_link agent reaches it`, async () => {
      const link = await serve('link');
      await refusal(await fetch(`${link.url}${route.path}`, {
        method: route.method, headers: link.headers, ...(route.method === 'GET' ? {} : { body: 'x' }),
      }));
      expect(link.upload).not.toHaveBeenCalled();
      expect(link.clipboard).not.toHaveBeenCalled();
      expect(link.handler).not.toHaveBeenCalled();
      onlyResolution(link.rpcs);
      await server!.close();
      server = undefined;

      const agent = await serve('agent');
      const res = await fetch(`${agent.url}${route.path}`, {
        method: route.method, headers: agent.headers, ...(route.method === 'GET' ? {} : { body: 'x' }),
      });
      expect(res.status).toBeLessThan(300);
      expect(agent[route.reached]).toHaveBeenCalledOnce();
    });
  }

  it('the events WS upgrade: refused 401 before admission; the socket resolver refuses the link and admits the agent', async () => {
    const link = stub('link');
    const authorize = createSocketIdentityResolver(link.resolver, true);
    const upgradeReq = (token: string) => ({
      url: '/v2/ws',
      headers: {
        upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        authorization: `Bearer ${token}`,
      },
      socket: { remoteAddress: '203.0.113.9' },
    }) as unknown as IncomingMessage;

    await expect(authorize(upgradeReq(link.token))).rejects.toMatchObject({
      code: 'forbidden', message: LINK_BEARER_TRANSPORT_REFUSED, details: { sqlstate: '42501' },
    });

    const ws = createWsServer({ authorize });
    const written: string[] = [];
    const socket = {
      end: vi.fn((chunk?: string) => { if (chunk) written.push(chunk); }),
      write: vi.fn((chunk: string) => { written.push(chunk); return true; }),
      destroy: vi.fn(), on: vi.fn(), once: vi.fn(), setNoDelay: vi.fn(), setTimeout: vi.fn(),
    } as unknown as Duplex;
    await ws.handleUpgrade(upgradeReq(link.token), socket, Buffer.alloc(0));
    expect(written.join('')).toMatch(/^HTTP\/1\.1 401 Unauthorized/);
    expect(written.join('')).not.toMatch(/101 Switching Protocols/);
    onlyResolution(link.rpcs);

    const agent = stub('agent');
    expect(await createSocketIdentityResolver(agent.resolver, true)(upgradeReq(agent.token)))
      .toMatchObject({ kind: 'bearer', authKind: 'agent', viaLinkId: LINK });
  });
});
