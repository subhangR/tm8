/**
 * §5.5 / B63.2, layer (i): AN MCP TOKEN IS REFUSED ON EVERY TRANSPORT BUT /mcp.
 *
 * This is the proving cell for the one finding that made the explicit arm in
 * `createSessionIdentityResolver` load-bearing rather than tidy. An MCP token
 * carries its OWN prefix (`tm8m_`), so it does not match the bearer arm at all —
 * and the arm after that is `autoOwnerResolver`, which on a loopback peer with
 * no recognised credential resolves THE NODE OWNER. So without the refusal,
 * presenting an MCP token to any route on a loopback-bound node (the normal
 * deployment) does not fail: it succeeds as the owner.
 *
 * Hence the two assertions on every cell, which is what makes it revert-proof:
 * the request is refused 403, AND the owner resolver is never consulted. Delete
 * `refuseMcpTokenOnTransport` from the resolver and both flip — the route runs
 * and the owner is resolved.
 *
 * Every request here comes from a real loopback peer with the auto-owner arm
 * ENABLED, because that is the dangerous configuration. The control on each
 * route is the same request with an ordinary `cli` session token, which passes.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db, Querier } from '../src/db/types.js';
import { createWsServer } from '../src/events/ws-server.js';
import { HandlerRegistry } from '../src/facade/registry.js';
import { CLIPBOARD_UPLOAD_PATH } from '../src/http/clipboard-upload.js';
import type { ServerConfig } from '../src/http/config.js';
import { createSessionIdentityResolver, createSocketIdentityResolver } from '../src/http/identity-resolver.js';
import { createFacadeServer, type FacadeServer } from '../src/http/server.js';
import { formatMcpToken, formatToken, generateSecret } from '../src/identity/crypto.js';
import { MCP_TOKEN_TRANSPORT_REFUSED } from '../src/identity/mcp-token.js';
import { MCP_ENDPOINT_PATH } from '../src/mcp/endpoint.js';

const ENTITY = '019f9896-928d-7e55-8f3a-6c1d2e3f4a5b';
const OWNER_IDENTITY = 'identity-node-owner';

const CONFIG: ServerConfig = {
  host: '127.0.0.1', port: 0, uiDir: undefined, maxBodyBytes: 1024 * 1024, databaseUrl: undefined,
};

/**
 * `carrier`: what rides in `Authorization`. The db stub resolves a `cli`
 * session for the session-token control and records every rpc, so a refused
 * request can be shown to have reached no lookup at all — stronger than the
 * link case, where the refusal happens AFTER the row is read.
 */
function stub(carrier: 'mcp' | 'session') {
  const sessionId = randomUUID();
  const token = carrier === 'mcp'
    ? formatMcpToken(randomUUID(), generateSecret())
    : formatToken(sessionId, generateSecret());
  const rpcs: string[] = [];
  const row = {
    sessionId, accountId: 'account-h', identityId: 'identity-h', username: 'h', displayName: null,
    isNodeAdmin: false, isOwner: false, kind: 'cli', actingAsTeamMemberId: null,
    workSessionId: null, runtimeMemberId: null, runtimeThreadRootId: null, runtimeChatId: null,
    spaceId: null, viaLinkId: null, expiresAt: new Date(Date.now() + 3_600_000).toISOString(), label: null,
  };
  const q = {
    rpc: vi.fn(async (name: string) => { rpcs.push(name); return name === 'resolve_auth_session' ? row : null; }),
    query: vi.fn(async () => { rpcs.push('query'); return []; }),
  } as unknown as Querier;
  const db = {
    tx: vi.fn(async (_claims: unknown, fn: (querier: Querier) => Promise<unknown>) => fn(q)),
    rpc: vi.fn(async (_claims: unknown, name: string) => { rpcs.push(name); return name === 'resolve_auth_session' ? row : null; }),
    query: vi.fn(async () => { rpcs.push('query'); return []; }),
    end: vi.fn(),
  } as unknown as Db;
  // A REAL owner, not a throwing one: the test's claim is that it is never
  // CONSULTED. An owner that throws would fail the reverted code for the wrong
  // reason (a 500 instead of a 200 as the owner).
  const owner = vi.fn(async () => ({ identityId: OWNER_IDENTITY, isNodeAdmin: true, isOwner: true }));
  const resolver = createSessionIdentityResolver({ db, owner: owner as never });
  return { token, rpcs, resolver, owner };
}

let server: FacadeServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function serve(carrier: 'mcp' | 'session') {
  const s = stub(carrier);
  const reached = (status: number) => vi.fn(async (_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(status).end();
    return true;
  });
  const upload = reached(204);
  const clipboard = reached(204);
  const handler = vi.fn(async () => ({ ok: true }));
  const registry = new HandlerRegistry().register('entities.get', handler);
  server = createFacadeServer({
    config: CONFIG, registry, identityResolver: s.resolver,
    fileUploadRoute: upload, clipboardUploadRoute: clipboard, authRateLimiter: null,
  });
  const { url } = await server.listen();
  // No X-TM8-Client and no cookie: exactly what Claude Desktop or `claude mcp`
  // sends. The CSRF gate exempts a cookieless bearer by construction (S6).
  return { ...s, url, headers: { authorization: `Bearer ${s.token}` }, upload, clipboard, handler };
}

async function refusal(res: Response): Promise<void> {
  expect(res.status).toBe(403);
  const body = await res.json() as { error?: { code?: string; message?: string; details?: { sqlstate?: string } } };
  expect(body.error).toMatchObject({
    code: 'forbidden', message: MCP_TOKEN_TRANSPORT_REFUSED, details: { sqlstate: '42501' },
  });
}

const ROUTES = [
  { label: 'a facade op (GET entities.get)', method: 'GET', path: `/v2/entities/${ENTITY}`, reached: 'handler' },
  { label: 'the PUT file upload', method: 'PUT', path: `/v2/files/uploads/${ENTITY}/content`, reached: 'upload' },
  { label: 'the POST clipboard upload', method: 'POST', path: CLIPBOARD_UPLOAD_PATH, reached: 'clipboard' },
] as const;

describe('§5.5 layer (i) — an MCP token is refused on every transport, and never becomes the node owner', () => {
  for (const route of ROUTES) {
    it(`${route.label}: 403/42501, no route, no lookup, and the owner is NOT resolved`, async () => {
      const mcp = await serve('mcp');
      await refusal(await fetch(`${mcp.url}${route.path}`, {
        method: route.method, headers: mcp.headers, ...(route.method === 'GET' ? {} : { body: 'x' }),
      }));
      expect(mcp.upload).not.toHaveBeenCalled();
      expect(mcp.clipboard).not.toHaveBeenCalled();
      expect(mcp.handler).not.toHaveBeenCalled();
      // The whole point: the auto-owner arm, which this credential would
      // otherwise fall into on a loopback peer, never ran.
      expect(mcp.owner).not.toHaveBeenCalled();
      // And nothing was looked up — the refusal is on the carrier, not on a row.
      expect(mcp.rpcs).toEqual([]);
      await server!.close();
      server = undefined;

      const session = await serve('session');
      const res = await fetch(`${session.url}${route.path}`, {
        method: route.method, headers: session.headers, ...(route.method === 'GET' ? {} : { body: 'x' }),
      });
      expect(res.status).toBeLessThan(300);
      expect(session[route.reached]).toHaveBeenCalledOnce();
    });
  }

  it('the WS upgrade: the socket resolver refuses the MCP token and admits a cli session', async () => {
    const mcp = stub('mcp');
    const authorize = createSocketIdentityResolver(mcp.resolver, false);
    const upgradeReq = (token: string) => ({
      url: '/v2/ws',
      headers: {
        upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        authorization: `Bearer ${token}`,
      },
      socket: { remoteAddress: '127.0.0.1' },
    }) as unknown as IncomingMessage;

    await expect(authorize(upgradeReq(mcp.token))).rejects.toMatchObject({
      code: 'forbidden', message: MCP_TOKEN_TRANSPORT_REFUSED, details: { sqlstate: '42501' },
    });
    expect(mcp.owner).not.toHaveBeenCalled();

    const ws = createWsServer({ authorize });
    const written: string[] = [];
    const socket = {
      end: vi.fn((chunk?: string) => { if (chunk) written.push(chunk); }),
      write: vi.fn((chunk: string) => { written.push(chunk); return true; }),
      destroy: vi.fn(), on: vi.fn(), once: vi.fn(), setNoDelay: vi.fn(), setTimeout: vi.fn(),
    } as unknown as Duplex;
    await ws.handleUpgrade(upgradeReq(mcp.token), socket, Buffer.alloc(0));
    expect(written.join('')).not.toMatch(/101 Switching Protocols/);

    const session = stub('session');
    expect(await createSocketIdentityResolver(session.resolver, false)(upgradeReq(session.token)))
      .toMatchObject({ kind: 'bearer', authKind: 'cli' });
  });

  it('and the mirror: a tm8 SESSION token is refused on /mcp, which takes only an MCP token', async () => {
    const session = await serve('session');
    const res = await fetch(`${session.url}${MCP_ENDPOINT_PATH}`, {
      method: 'POST', headers: { ...session.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    // No endpoint is mounted on this server, so the mount itself is what
    // answers: an honest 404 rather than a route that half-exists. The refusal
    // of a session bearer BY the endpoint is covered in db/mcp-tokens.pg.test.ts,
    // where a real one is wired.
    expect(res.status).toBe(404);
    expect(session.handler).not.toHaveBeenCalled();
  });
});
