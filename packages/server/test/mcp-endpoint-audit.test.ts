/**
 * B66 / §7.5: ON /mcp THE `started` AUDIT ROW IS FAIL-CLOSED.
 *
 * §7.5 says every use of a tm8-held credential is recorded. #1321 made that
 * load-bearing on the session path (B50) by letting the ONE pre-send audit
 * write throw; `/mcp` caught every audit failure instead, so a token call could
 * reach Gmail with tm8's credential and leave no row at all.
 *
 * What makes each cell revert-proof is the pair of assertions: the request is
 * refused with tm8's own audit message, AND `mcp_token_space_member` — the
 * first thing `proxy.request` does, inside the external `authorize` port — is
 * never called, so nothing reached a provider. Put the `try/catch` back around
 * the `started` write and both flip: `tools/call` answers with the connector
 * error from further down, `tools/list` answers `{tools: []}`, and the proxy is
 * entered in both.
 *
 * The control is the same endpoint with a writer that WORKS: the row is written,
 * it says `started`, and it is written BEFORE the proxy is entered.
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { mcpServerKey } from '@tm8/contract';
import type { Db, DbClaims, Querier } from '../src/db/types.js';
import { formatMcpToken, generateSecret } from '../src/identity/crypto.js';
import { createMcpEndpointRoute, type McpEndpointRoute } from '../src/mcp/endpoint.js';

/** The connector `offered()` finds, and the tool key §4.2 assigns it. */
const CONNECTOR_NAME = 'gmail';
const SERVER_KEY = mcpServerKey({ name: CONNECTOR_NAME });

interface Harness {
  route: McpEndpointRoute;
  token: string;
  spaceId: string;
  /** Every rpc the route made, in order. */
  names: string[];
  /** The `p_outcome` of every audit row the writer accepted. */
  written: string[];
}

function harness(audit: 'works' | 'fails'): Harness {
  const tokenId = randomUUID();
  const spaceId = randomUUID();
  const memberId = randomUUID();
  const serverId = randomUUID();
  const names: string[] = [];
  const written: string[] = [];
  const rpc = async (_claims: DbClaims, name: string, args: unknown[] = []): Promise<unknown> => {
    names.push(name);
    switch (name) {
      case 'resolve_mcp_token':
        return { tokenId, identityId: 'identity-m', spaceIds: [spaceId],
          expiresAt: new Date(Date.now() + 3_600_000).toISOString() };
      case 'mcp_token_spaces': return [{ spaceId, memberId }];
      // Only `authorize`, inside `proxy.request`, asks this — so seeing it is
      // seeing the call get past the point where the row had to exist.
      case 'mcp_token_space_member': return memberId;
      case 'record_mcp_token_call_audit':
        if (audit === 'fails') throw new Error('permission denied for function record_mcp_token_call_audit');
        written.push(String(args[6]));
        return null;
      default: return null;
    }
  };
  // The connector read is matched on `allowExternalClients`, which only
  // `externalConnectors` selects on; every other query (the proxy's own
  // definition read) finds nothing, as a connector that is gone would.
  const q = {
    query: async (sql: string) => (sql.includes('allowExternalClients')
      ? [{ id: serverId, name: CONNECTOR_NAME, server_key: null }] : []),
    rpc,
  } as unknown as Querier;
  const db = {
    rpc, query: async () => [], end: async () => undefined,
    tx: async (_claims: DbClaims, fn: (querier: Querier) => Promise<unknown>) => fn(q),
  } as unknown as Db;
  // Reached only through the proxy, and the proxy must not be reached.
  const unreachable = () => { throw new Error('the provider must not be reached'); };
  const route = createMcpEndpointRoute({
    db, maxBodyBytes: 64 * 1024,
    credentials: { read: vi.fn(unreachable), replace: vi.fn(unreachable) } as never,
    definition: vi.fn(unreachable) as never,
  });
  return { route, token: formatMcpToken(tokenId, generateSecret()), spaceId, names, written };
}

interface RpcAnswer { status: number; result?: unknown; error?: { code: number; message: string } }

async function call(h: Harness, body: unknown): Promise<RpcAnswer> {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  Object.assign(req, {
    method: 'POST', url: '/mcp', socket: { remoteAddress: '127.0.0.1' },
    headers: { authorization: `Bearer ${h.token}`, 'content-type': 'application/json' },
  });
  let status = 0;
  let payload = '';
  const res = {
    writeHead(code: number) { status = code; return res; },
    end(chunk?: string) { payload = chunk ?? ''; },
  } as unknown as ServerResponse;
  expect(await h.route(req, res, { requestId: 'req-1' })).toBe(true);
  const parsed = payload ? JSON.parse(payload) as { result?: unknown; error?: RpcAnswer['error'] } : {};
  return { status, ...parsed };
}

const REFUSAL = 'this call was not made: tm8 could not record it in the MCP call audit';

describe('B66 — an external /mcp call whose `started` row cannot be written is refused', () => {
  const methods = [
    { label: 'tools/call', body: (spaceId: string) => ({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: `${SERVER_KEY}__send`, arguments: { spaceId } } }) },
    { label: 'tools/list', body: () => ({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) },
  ] as const;

  for (const method of methods) {
    it(`${method.label}: refused with tm8's audit message, and the proxy is never entered`, async () => {
      const h = harness('fails');
      const answer = await call(h, method.body(h.spaceId));
      // An application refusal is a 200 carrying a JSON-RPC error, which is what
      // an MCP client turns into a failed tool call for its model.
      expect(answer.status).toBe(200);
      expect(answer.result).toBeUndefined();
      expect(answer.error?.message).toBe(REFUSAL);
      expect(h.written).toEqual([]);
      expect(h.names).toContain('record_mcp_token_call_audit');
      expect(h.names).not.toContain('mcp_token_space_member');
    });
  }

  it('the control: a writer that works writes `started` BEFORE the proxy is entered', async () => {
    const h = harness('works');
    const answer = await call(h, methods[0].body(h.spaceId));
    expect(h.written[0]).toBe('started');
    // The row precedes `authorize`'s own read, which is the ordering §7.5 needs.
    expect(h.names.indexOf('record_mcp_token_call_audit'))
      .toBeLessThan(h.names.indexOf('mcp_token_space_member'));
    // And the call itself is NOT refused for audit: it gets as far as the
    // connector read, which this harness lets fail.
    expect(answer.error?.message).not.toBe(REFUSAL);
  });
});
