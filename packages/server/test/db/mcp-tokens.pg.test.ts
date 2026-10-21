/**
 * §5.5 / §7.1 / §6.6 — MEMBER-OWNED MCP TOKENS ON `/mcp` (migration 357, D9, Q4,
 * backend decision B63).
 *
 * Driven end to end: a real HTTP server with the real `/mcp` route mounted, real
 * `mcp.tokens.create` rows, the real `McpProxy` and the real database, against a
 * fake upstream MCP server. The cells are the four the advisor named as
 * high-signal (B63), and they are all about one question — what a token can
 * reach — answered where it is actually decided, in SQL:
 *
 *   * a token limited to Space B cannot LIST or CALL Space A's tools, while a
 *     token for all the member's Spaces sees both: so the limit is the token's
 *     Space list and not an accident of the fixture;
 *   * a connector without `allowExternalClients` is invisible to both (Q4);
 *   * revoking the token kills the NEXT call;
 *   * losing the membership kills the next call, with the token untouched.
 *
 * Plus the two shapes nothing else covers: every call writes an
 * `via='external_token'` audit row with no session and the token's member as
 * root (§5.6), and a tm8 SESSION token is refused on this route.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';
import { createDb } from '../../src/db/client.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import type { RequestContext } from '../../src/http/types.js';
import type { ServerConfig } from '../../src/http/config.js';
import { createFacadeServer, type FacadeServer } from '../../src/http/server.js';
import { formatMcpToken, formatToken, generateSecret, hashToken } from '../../src/identity/crypto.js';
import { createMcpEndpointRoute, MCP_ENDPOINT_PATH } from '../../src/mcp/endpoint.js';
import { loadMcpServer } from '../../src/mcp/definitions.js';
import { registerMcpTokenHandlers } from '../../src/mcp/tokens.js';
import type { McpProxyPorts } from '../../src/mcp/proxy.js';
import type { McpTokenCreateResult, McpTokenView } from '@tm8/contract';
import { getOperation } from '@tm8/contract';

import { vi } from 'vitest';
vi.setConfig({ testTimeout: 120000, hookTimeout: 300000 });

let scratch: W1ScratchDatabase;
let db: Db;
let upstream: Server;
let upstreamUrl = '';
let server: FacadeServer;
let origin = '';
const registry = new HandlerRegistry();

const spaceA = randomUUID();
const spaceB = randomUUID();
const mia = { identity: `tok-mia-${randomUUID()}`, account: randomUUID(), inA: randomUUID(), inB: randomUUID() };
const connectors = { amail: '', bmail: '', bprivate: '' };
let tokenB = '';
let tokenAll = '';
let tokenBId = '';

const human = (pin?: string): DbClaims =>
  ({ identityId: mia.identity, authKind: 'browser', ...(pin ? { sessionSpaceId: pin } : {}) });

const CONFIG: ServerConfig = {
  host: '127.0.0.1', port: 0, uiDir: undefined, maxBodyBytes: 1024 * 1024, databaseUrl: undefined,
};

/** One JSON-RPC request to `/mcp`, exactly as an MCP client sends it. */
async function rpc(token: string, method: string, params?: unknown): Promise<{ status: number; body: {
  result?: { tools?: Array<{ name: string }>; content?: unknown }; error?: { code: number; message: string } } }> {
  const res = await fetch(`${origin}${MCP_ENDPOINT_PATH}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
  });
  return { status: res.status, body: await res.json() as never };
}
const toolNames = async (token: string): Promise<string[]> =>
  ((await rpc(token, 'tools/list')).body.result?.tools ?? []).map(tool => tool.name).sort();

/** `mcp.tokens.create` through the real handler, as the UI or CLI would. */
async function mint(spaceIds: string[] | null, label: string): Promise<McpTokenCreateResult> {
  const ctx = {
    op: getOperation('mcp.tokens.create'), opName: 'mcp.tokens.create', params: {},
    query: new URLSearchParams(), body: { clientMutationId: randomUUID(), label, spaceIds },
    requestId: `tok-${randomUUID()}`, headers: {}, method: 'POST', path: '/',
    identity: { kind: 'bearer', identityId: mia.identity, authKind: 'browser', sessionId: randomUUID() },
  } as unknown as RequestContext;
  return registry.get('mcp.tokens.create')!(ctx) as Promise<McpTokenCreateResult>;
}

const auditRows = () => scratch.query<Record<string, unknown>>(
  "select * from public.mcp_call_audit where via = 'external_token' order by id");

beforeAll(async () => {
  scratch = await createW1ScratchDatabase('mcp_tokens');
  scratch.apply(migrationFiles());
  db = createDb(scratch.url, { max: 4 });
  upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const message = JSON.parse(Buffer.concat(chunks).toString()) as { id?: number; method: string };
    res.setHeader('content-type', 'application/json');
    if (message.id === undefined) { res.writeHead(202); res.end(); return; }
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id,
      result: message.method === 'initialize' ? { protocolVersion: '2025-03-26' }
        : message.method === 'tools/list' ? { tools: [{ name: 'send_email', inputSchema: { type: 'object', properties: {} } }] }
        : { content: [{ type: 'text', text: 'sent' }] } }));
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/mcp`;

  await scratch.transaction(async c => {
    await c.query('set local role tm8_graph_owner');
    await c.query('insert into public.accounts(id,identity_id,username) values($1,$2,$3)',
      [mia.account, mia.identity, `tok-mia-${mia.account.slice(0, 8)}`]);
    await c.query('insert into public.user_profiles(identity_id,display_name) values($1,$2)', [mia.identity, 'Mia']);
    await c.query('insert into public.spaces(id,name,created_by_identity) values($1,$2,$4),($3,$5,$4)',
      [spaceA, 'Space A', spaceB, mia.identity, 'Space B']);
    for (const [member, space] of [[mia.inA, spaceA], [mia.inB, spaceB]] as const) {
      await c.query("insert into public.entities(id,space_id,kind,created_by) values($1,$2,'member',$1)", [member, space]);
      await c.query("insert into public.members(entity_id,space_id,identity_id,role,display_name) values($1,$2,$3,'owner','Mia')",
        [member, space, mia.identity]);
    }
  });

  const definition = (name: string, external: boolean) => JSON.stringify({
    name, transport: 'http', url: 'https://example.test/mcp', envKeys: [], headerKeys: [],
    auth: { type: 'none' }, approved: true, ...(external ? { allowExternalClients: true } : {}),
  });
  const create = async (space: string, name: string, external: boolean) =>
    (await db.rpc<{ entity: { id: string } }>(human(space), 'create_mcp_server_entity',
      [space, definition(name, external), null, randomUUID()])).entity.id;
  connectors.amail = await create(spaceA, 'amail', true);
  connectors.bmail = await create(spaceB, 'bmail', true);
  // Q4: approved and enabled, but NOT offered to external clients.
  connectors.bprivate = await create(spaceB, 'bprivate', false);

  const deps = { db, owner: async () => ({ identityId: mia.identity, isNodeAdmin: false }),
    config: CONFIG } as unknown as FacadeDeps;
  registerMcpTokenHandlers(registry, deps);
  /*
   * The proxy's ports, as `registerMcpRuntimeHandlers` builds them, with ONE
   * change: the definition handed to the proxy dials the fake upstream. Its
   * `spaceId` and its flags still come off the real row — which is what the
   * endpoint's `authorize` reads for the `allowExternalClients` check — so
   * nothing about access is faked here, only the hostname.
   */
  const ports: Pick<McpEndpointPorts, 'credentials' | 'definition'> = {
    credentials: { read: async () => { throw new Error('an auth:none connector reads no credential'); },
      replace: async () => { throw new Error('unused'); } } as unknown as McpProxyPorts['credentials'],
    definition: async (claims, id) => {
      const view = await db.tx(claims, q => loadMcpServer(q, id));
      return { id: view.id, spaceId: view.spaceId, version: view.securityRevision,
        ...view.definition, url: upstreamUrl, allowPrivateNetwork: true };
    },
  };
  server = createFacadeServer({
    config: CONFIG, registry, authRateLimiter: null,
    mcpEndpointRoute: createMcpEndpointRoute({ db, maxBodyBytes: CONFIG.maxBodyBytes, ...ports }),
  });
  origin = (await server.listen()).url;

  const b = await mint([spaceB], 'laptop-b');
  tokenB = b.secret;
  tokenBId = b.token.id;
  tokenAll = (await mint(null, 'laptop-all')).secret;
});

type McpEndpointPorts = Parameters<typeof createMcpEndpointRoute>[0];

afterAll(async () => {
  await server?.close();
  await db?.end();
  await scratch?.destroy();
  await new Promise<void>(resolve => upstream ? upstream.close(() => resolve()) : resolve());
});

describe('§7.1 per-caller tools/list — hide, don\'t deny (D8)', () => {
  it('a token limited to Space B lists only Space B\'s external connector', async () => {
    expect(await toolNames(tokenB)).toEqual(['bmail__send_email']);
  });

  it('the same member\'s all-Spaces token lists both Spaces, and neither lists a connector without allowExternalClients (Q4)', async () => {
    expect(await toolNames(tokenAll)).toEqual(['amail__send_email', 'bmail__send_email']);
    for (const token of [tokenB, tokenAll]) {
      expect(await toolNames(token)).not.toContain('bprivate__send_email');
    }
  });

  it('every tool carries a REQUIRED spaceId whose enum is the one Space it names (§7.1)', async () => {
    const tools = (await rpc(tokenAll, 'tools/list')).body.result?.tools as unknown as Array<{
      name: string; inputSchema: { required: string[]; properties: { spaceId: { enum: string[] } } } }>;
    const bmail = tools.find(tool => tool.name === 'bmail__send_email')!;
    expect(bmail.inputSchema.required).toContain('spaceId');
    expect(bmail.inputSchema.properties.spaceId.enum).toEqual([spaceB]);
  });
});

describe('§6.6 tools/call', () => {
  it('a Space-B token cannot call a Space A tool, whichever spaceId it names', async () => {
    for (const spaceId of [spaceA, spaceB]) {
      const refused = await rpc(tokenB, 'tools/call', { name: 'amail__send_email', arguments: { spaceId } });
      expect(refused.body.error?.message).toMatch(/No such tool/);
      expect(refused.body.result).toBeUndefined();
    }
    // And the control: its OWN tool works.
    const ok = await rpc(tokenB, 'tools/call', { name: 'bmail__send_email', arguments: { spaceId: spaceB } });
    expect(JSON.stringify(ok.body.result)).toContain('sent');
  });

  it('spaceId must agree with the connector the tool names', async () => {
    const mismatch = await rpc(tokenAll, 'tools/call', { name: 'bmail__send_email', arguments: { spaceId: spaceA } });
    expect(mismatch.body.error?.message).toMatch(/does not belong to the space you named/);
  });

  it('and a missing spaceId is refused rather than guessed', async () => {
    const bare = await rpc(tokenB, 'tools/call', { name: 'bmail__send_email', arguments: {} });
    expect(bare.body.error?.message).toMatch(/needs a spaceId argument/);
  });
});

describe('§5.6 the external-token audit', () => {
  it('every call leaves a row with no session, the token, and the token\'s member as root', async () => {
    const rows = await auditRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toMatchObject({ session_id: null, chat_id: null, chain: null, mcp_token_id: expect.any(String) });
      expect(row['via']).toBe('external_token');
      // §6.6: the root is the token's member IN THE SPACE the call landed in.
      expect(row['root_member_id']).toBe(row['space_id'] === spaceB ? mia.inB : mia.inA);
    }
    // The successful call on Space B's connector is in there, with its tool named.
    expect(rows.some(row => row['space_id'] === spaceB && row['method'] === 'tools/call'
      && row['tool'] === 'send_email' && row['outcome'] === 'succeeded')).toBe(true);
    // And no row was ever written for Space A on the Space-B token's behalf.
    expect(rows.some(row => row['space_id'] === spaceA && row['mcp_token_id'] === tokenBId)).toBe(false);
  });
});

describe('a tm8 session token is not a credential here', () => {
  it('/mcp refuses one with 401 before any lookup', async () => {
    const session = formatToken(randomUUID(), generateSecret());
    const refused = await rpc(session, 'tools/list');
    expect(refused.status).toBe(401);
    expect(refused.body.error?.message).toMatch(/session token is not accepted/);
  });

  it('and a well-formed MCP token nobody issued is 401, like a revoked one', async () => {
    const forged = formatMcpToken(randomUUID(), generateSecret());
    expect((await rpc(forged, 'tools/list')).status).toBe(401);
  });
});

describe('§5.5 what stops a live token', () => {
  it('revoking it kills the NEXT call', async () => {
    expect(await toolNames(tokenB)).toEqual(['bmail__send_email']);
    const ctx = {
      op: getOperation('mcp.tokens.revoke'), opName: 'mcp.tokens.revoke', params: { tokenId: tokenBId },
      query: new URLSearchParams(), body: { clientMutationId: randomUUID() },
      requestId: `tok-revoke-${randomUUID()}`, headers: {}, method: 'POST', path: '/',
      identity: { kind: 'bearer', identityId: mia.identity, authKind: 'browser', sessionId: randomUUID() },
    } as unknown as RequestContext;
    const revoked = await registry.get('mcp.tokens.revoke')!(ctx) as McpTokenView;
    expect(revoked.revokedAt).not.toBeNull();
    expect((await rpc(tokenB, 'tools/list')).status).toBe(401);
    // Revoke is a tombstone, never a delete: the audit rows keep their token.
    expect((await auditRows()).some(row => row['mcp_token_id'] === tokenBId)).toBe(true);
  });

  it('losing the membership kills the next call, with the token itself untouched', async () => {
    expect(await toolNames(tokenAll)).toContain('bmail__send_email');
    await scratch.transaction(async c => {
      await c.query('set local role tm8_graph_owner');
      await c.query("update public.members set status='removed', left_at=now() where entity_id=$1", [mia.inB]);
    });
    // Space B is gone from the SAME token, which is still live and still lists A.
    expect(await toolNames(tokenAll)).toEqual(['amail__send_email']);
  });
});
