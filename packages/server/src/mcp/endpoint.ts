import type { IncomingMessage, ServerResponse } from 'node:http';
import { CollabError, assignMcpServerKeys, isCollabError, mcpServerKey } from '@tm8/contract';
import { MCP_PROTOCOL_VERSION, MCP_SERVER_INFO } from '@tm8/mcp';

import type { Db, DbClaims, Querier } from '../db/types.js';
import { readJsonBody } from '../http/body.js';
import { FixedWindowLimiter } from '../http/fixed-window.js';
import { wsClientKey } from '../http/ws-admission.js';
import { TOKEN_PREFIX } from '../identity/crypto.js';
import { resolveMcpTokenIdentity, type ResolvedMcpToken } from '../identity/mcp-token.js';
import { byteSize, mcpDenyReason, mcpToolName } from './audit.js';
import { loadMcpServer, resolveMcpSelections } from './definitions.js';
import { McpProxy, type McpProxyGrant, type McpProxyPorts } from './proxy.js';

/*
 * §7.1 / G14 — THE REMOTE MCP ENDPOINT, for external clients.
 *
 * One path, `POST /mcp`, speaking Streamable HTTP's JSON arm: one JSON-RPC
 * request in, one JSON response out. No stream, and no server-assigned session
 * — the spec allows a stateless server, and a session id here would be a second
 * thing to revoke beside the token. It is NOT a catalog operation and must never
 * become one: it is dispatched like the voice webhook and the remote-link
 * routes, before generic identity resolution, because it authenticates itself —
 * with the ONE credential every other transport refuses (identity/mcp-token.ts).
 *
 * WHAT IT EXPOSES, AND WHAT IT DELIBERATELY DOES NOT.
 * Connector tools only. §5.5 says an MCP token "is refused on the REST facade
 * and the CLI API", and every tm8 graph tool (`packages/mcp`) is a projection of
 * a catalog operation over exactly that facade — so serving them here would be
 * opening the door §5.5 closes, under another name. A client that wants the
 * graph tools runs the stdio tm8 server with a session bearer, as today.
 *
 * TOOL NAMES (§4.2) AND `spaceId` (§7.1). A tool is `<serverKey>__<tool>`, where
 * the keys come from `assignMcpServerKeys` — the same assigner the launcher uses
 * for bridge entries, so two connectors that would collide are suffixed
 * (`gmail`, `gmail_2`) rather than merged. One key therefore names exactly one
 * connector in exactly one Space, which is the strongest form of §7.1's "the
 * tool list never merges two Spaces' gmail.* into one ambiguous set". `spaceId`
 * is still REQUIRED on every connector tool, as §7.1 asks, and it is also a
 * cross-check: a client holding a stale list cannot land a call in a Space the
 * key has since moved to — it gets a refusal instead of someone else's Gmail.
 * It carries §4.2's stated consequence too: adding a connector that wants a
 * taken key renames the suffixed one, so a client re-lists after a change.
 *
 * HIDE, DON'T DENY (D8). A connector the caller cannot use does not appear:
 * not approved, not enabled, `allowExternalClients` off (Q4 — off by default),
 * no usable connection, the Space no longer theirs, or the provider itself
 * unreachable. Each of those is a connector MISSING from `tools/list`, never an
 * error about it; `tools/call` re-checks all of it anyway, through the same
 * `authorize` port the session proxy uses.
 *
 * EVERY CALL IS AUDITED, denials included (§5.6), through
 * `record_mcp_token_call_audit` (357) — the external sibling of 346's writer.
 * The `started` row is FAIL-CLOSED (B66, as B50 made it on the session path):
 * it is written before anything reaches a provider, and a call whose row cannot
 * be written is REFUSED rather than made unrecorded — §7.5 says every use of a
 * tm8-held credential is recorded, and a best-effort row there would make that
 * a hope. Every later row stays best-effort, because a row must never replace a
 * refusal nor turn a call the provider already acted on into an error.
 */

export const MCP_ENDPOINT_PATH = '/mcp';

export type McpEndpointRoute = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: { requestId: string },
) => Promise<boolean>;

/**
 * Bounds, so one token cannot turn a `tools/list` into an unbounded fan-out.
 * Each is a cap on the work this endpoint does on the caller's behalf, not a
 * policy — the policy is `allowExternalClients`.
 */
const MAX_SPACES = 16;
const MAX_CONNECTORS_PER_SPACE = 16;
const MAX_CONNECTORS = 32;
const MAX_TOOLS = 256;
/**
 * The budget a tool NAME has. A client prefixes its own `mcp__<its name for
 * tm8>__`, so at 48 the whole thing stays inside the ~64-character tool-name
 * limits §4.2 cites. A provider tool whose name does not fit is left out, which
 * is the same answer as any other tool this caller cannot use.
 */
const MAX_TOOL_NAME = 48;
/**
 * B63.4: a leaked token must not be an unbounded relay. A whole `tools/list`
 * fan-out counts as one hit against its token, and so does one `tools/call`.
 *
 * A fixed window and not a token bucket because this repo has exactly one
 * rate-limiting algorithm on purpose (http/fixed-window.ts says why): the 2x
 * burst across the window seam is accepted, since the limit is here to catch a
 * flood and not to shape a well-behaved client's traffic.
 */
export const MCP_ENDPOINT_LIMIT = { limit: 60, windowMs: 60_000 } as const;
/** Failed credentials, per client key, so a token cannot be guessed at speed. */
export const MCP_ENDPOINT_AUTH_LIMIT = { limit: 20, windowMs: 60_000 } as const;

export interface McpEndpointOptions {
  readonly db: Db;
  readonly maxBodyBytes: number;
  /** The proxy's ports, exactly as `registerMcpRuntimeHandlers` built them. */
  readonly credentials: McpProxyPorts['credentials'];
  readonly definition: McpProxyPorts['definition'];
  readonly firstParty?: McpProxyPorts['firstParty'];
  readonly limiter?: FixedWindowLimiter;
  readonly authLimiter?: FixedWindowLimiter;
  /**
   * B63.2, the Streamable-HTTP DNS-rebinding defence: browser origins allowed to
   * reach this endpoint. EMPTY BY DEFAULT, which refuses every request that
   * carries an `Origin` at all — a desktop or CLI MCP client sends none, so the
   * clients §10.7 names are unaffected, and a page in a browser cannot drive a
   * token it somehow obtained.
   *
   * Deliberately NOT fed from `config.allowedOrigins`: those are the origins the
   * tm8 UI is served from, and the UI has no business driving this endpoint. No
   * node setting fills this yet either — nothing in §10.7's client list is a
   * browser, so the first operator who needs one should add the env var with
   * their reason in hand rather than inherit a list that means something else.
   */
  readonly allowedOrigins?: readonly string[];
}

/** One Space the token is admitted to, and the member it acts as there. */
interface AdmittedSpace { spaceId: string; memberId: string }
/** One connector offered to an external caller, with its assigned tool key. */
interface OfferedConnector { spaceId: string; memberId: string; serverId: string; serverKey: string }

/** One row 357's writer takes for an external call: no argument, no result. */
interface ExternalAuditEntry {
  method: 'tools/list' | 'tools/call';
  tool: string | null;
  outcome: 'started' | 'succeeded' | 'failed' | 'denied';
  denyReason?: string;
  requestBytes: number;
  responseBytes?: number;
  latencyMs?: number;
}
/** What `auditStarted` is given: the outcome and the timings are not its caller's. */
type StartedAuditEntry = Pick<ExternalAuditEntry, 'method' | 'tool' | 'requestBytes'>;

interface JsonRpcRequest { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown }

export function createMcpEndpointRoute(options: McpEndpointOptions): McpEndpointRoute {
  const { db } = options;
  const limiter = options.limiter ?? new FixedWindowLimiter(MCP_ENDPOINT_LIMIT);
  const authLimiter = options.authLimiter ?? new FixedWindowLimiter(MCP_ENDPOINT_AUTH_LIMIT);
  const allowedOrigins = new Set(options.allowedOrigins ?? []);

  /*
   * The external `authorize` port. THE WHOLE ACCESS RULE FOR AN EXTERNAL CALL
   * LIVES HERE, and `McpProxy` re-runs it on every re-check: it calls
   * `authorize` again before each send and refuses on any difference from the
   * grant it started with. So a revoked token, a removed membership, an
   * un-approved connector or `allowExternalClients` turned off all stop a call
   * that is already in flight.
   *
   * §6.6: the ROOT is the token's member. There is no session, no binding and no
   * `launched_by` to walk — which is also why nothing here consults one.
   */
  const authorize = async (claims: DbClaims, sessionId: string, serverId: string): Promise<McpProxyGrant> => {
    const call = parseExternalSession(sessionId);
    if (!call) throw refused('MCP token access is unavailable');
    // The connector is named too, so SQL applies §5.5's per-token connector
    // allow-list on every one of the proxy's re-checks (B63.1/B63.4).
    const memberId = await db.rpc<string | null>({ identityId: claims.identityId, authKind: 'mcp' },
      'mcp_token_space_member', [call.tokenId, call.spaceId, serverId]);
    if (!memberId) throw refused('MCP token access is unavailable');
    return db.tx(claims, async q => {
      const server = await loadMcpServer(q, serverId);
      if (server.spaceId !== call.spaceId) throw refused('MCP connector unavailable');
      if (server.definition.allowExternalClients !== true) {
        throw refused('MCP connector is not available to external clients');
      }
      // The same resolver `bind` and `authorize` use, under the root's claims
      // with the root named: §3's order (pinned -> the root's personal -> the
      // Space's shared) and every readiness check answer identically for an
      // external caller. `pinnedOnly` is deliberately NOT set — there is no
      // binding to re-check, so the connection is resolved fresh on each call.
      const resolved = await resolveMcpSelections(q, { spaceId: call.spaceId, mcpSelections: [{ serverId }] },
        { rootMemberId: memberId });
      const selection = resolved.selections[0];
      if (!selection?.ready) throw refused('MCP connector access has changed');
      return {
        sessionId, identityId: claims.identityId!, spaceId: call.spaceId, serverId,
        rootMemberId: memberId, rootIdentityId: claims.identityId!,
        ...(selection.credentialId ? { credentialId: selection.credentialId } : {}),
      } satisfies McpProxyGrant;
    });
  };
  const proxy = new McpProxy({
    credentials: options.credentials, definition: options.definition, authorize,
    ...(options.firstParty ? { firstParty: options.firstParty } : {}),
  });

  return async (req, res, ctx) => {
    const url = new URL(req.url ?? '/', 'http://tm8.invalid');
    if (url.pathname !== MCP_ENDPOINT_PATH) return false;
    // GET is Streamable HTTP's server-to-client stream and DELETE ends a
    // session. This server is stateless and offers neither, which the spec says
    // to answer with 405 rather than by pretending.
    if (req.method !== 'POST') {
      sendJson(res, 405, ctx.requestId,
        { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'the tm8 MCP endpoint accepts POST only' } },
        { allow: 'POST' });
      return true;
    }
    let id: string | number | null = null;
    try {
      // B63.2, before anything is read or looked up. The frame's S3 transport
      // gate already refuses a foreign browser origin on the credentialed API,
      // and this is the same rule stated for THIS route, which does not go
      // through the shared identity path at all: an `Origin` the operator has
      // not allow-listed is refused, and the default list is empty.
      requireAllowedOrigin(req, allowedOrigins);
      const token = await authenticate(req, wsClientKey(req));
      const hit = limiter.hit(token.tokenId);
      if (!hit.ok) throw rateLimited(hit.retryAfterMs);
      const { value } = await readJsonBody(req, options.maxBodyBytes);
      // 2025-06-18 dropped JSON-RPC batching, and a batch here would also be one
      // HTTP request fanning out across several Spaces' credentials.
      if (Array.isArray(value)) {
        throw malformed('the tm8 MCP endpoint takes one JSON-RPC request, not a batch');
      }
      if (!value || typeof value !== 'object') throw malformed('a JSON-RPC request object is required');
      const message = value as JsonRpcRequest;
      id = isRpcId(message.id) ? message.id : null;
      const notification = message.id === undefined;
      const method = typeof message.method === 'string' ? message.method : '';
      const result = await dispatch(method, message.params, token, ctx.requestId);
      // A notification, and a method that answers nothing, get 202 and no body.
      if (notification || result === undefined) { res.writeHead(202, noStore(ctx.requestId)); res.end(); return true; }
      sendJson(res, 200, ctx.requestId, { jsonrpc: '2.0', id, result });
      return true;
    } catch (error) {
      sendError(res, error, ctx.requestId, id);
      return true;
    }
  };

  /**
   * The bearer, and only the bearer: no cookie arm, deliberately. A cookie
   * would make this endpoint reachable from a browser with ambient credentials,
   * which is both a CSRF surface and a second door onto the connectors.
   */
  async function authenticate(req: IncomingMessage, clientKey: string): Promise<ResolvedMcpToken> {
    const raw = bearerOf(req);
    if (!raw) throw unauthenticated('an MCP token is required');
    // The mirror of identity/mcp-token.ts: that file keeps MCP tokens off every
    // other transport, and this keeps SESSION tokens off this one. Checked
    // before the lookup, so a session token never even reaches it.
    if (raw.startsWith(TOKEN_PREFIX)) throw unauthenticated('a tm8 session token is not accepted on /mcp');
    const spent = authLimiter.peek(clientKey);
    if (spent.spent) throw rateLimited(spent.retryAfterMs);
    try {
      const token = await resolveMcpTokenIdentity(db, raw, clientIp(req));
      // Proving you hold the credential clears the record of having guessed.
      authLimiter.clear(clientKey);
      return token;
    } catch (error) {
      authLimiter.hit(clientKey);
      throw error;
    }
  }

  /** The JSON-RPC surface. `undefined` means "nothing to answer". */
  async function dispatch(method: string, params: unknown, token: ResolvedMcpToken,
    requestId: string): Promise<unknown> {
    switch (method) {
      case 'initialize':
        return {
          protocolVersion: protocolVersionOf(params) ?? MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: MCP_SERVER_INFO,
          instructions: 'tm8 serves the MCP connectors this token\'s member may use. Every tool takes a '
            + 'required spaceId: pass one of the values its own schema lists.',
        };
      case 'notifications/initialized':
      case 'notifications/cancelled':
        return undefined;
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: await listTools(token, requestId) };
      case 'tools/call':
        return callTool(token, params, requestId);
      default:
        throw new CollabError('not_found', `Method not found: ${method.slice(0, 60)}`);
    }
  }

  /** The Spaces this token may act in RIGHT NOW: its list ∩ live membership (357). */
  async function admitted(token: ResolvedMcpToken, requestId: string): Promise<AdmittedSpace[]> {
    const rows = await db.rpc<AdmittedSpace[]>(claimsFor(token, requestId), 'mcp_token_spaces', [token.tokenId]);
    return rows.slice(0, MAX_SPACES);
  }

  /**
   * Every connector OFFERED to this caller, with its tool key assigned across
   * the whole set — so `tools/list` and `tools/call` cannot disagree about which
   * connector a key names. Approved, enabled and `allowExternalClients` only
   * (Q4), read under the token's claims PINNED to each Space, so RLS and not
   * this query is what confines it.
   */
  async function offered(token: ResolvedMcpToken, requestId: string): Promise<OfferedConnector[]> {
    const found: Array<Omit<OfferedConnector, 'serverKey'> & { serverKey: string }> = [];
    for (const space of await admitted(token, requestId)) {
      if (found.length >= MAX_CONNECTORS) break;
      const rows = await db.tx(claimsFor(token, requestId, space.spaceId), q => externalConnectors(q, space.spaceId));
      for (const row of rows) {
        if (found.length >= MAX_CONNECTORS) break;
        found.push({ spaceId: space.spaceId, memberId: space.memberId, serverId: row.id, serverKey: row.serverKey });
      }
    }
    // The launcher's own key assigner (§4.2): deterministic, collision-suffixed,
    // `tm8` reserved, and an unusable key replaced by an opaque one.
    const keys = assignMcpServerKeys(found);
    return found.map(connector => ({ ...connector, serverKey: keys.get(connector.serverId) ?? connector.serverKey }));
  }

  /**
   * §7.1's per-caller tool list. One upstream `tools/list` per offered
   * connector, through the proxy — so the access rule runs at LIST time for an
   * external caller, which is the part §7.1 calls new. A connector that refuses
   * or fails is left out (D8): one broken provider must not take the list down.
   */
  async function listTools(token: ResolvedMcpToken, requestId: string): Promise<unknown[]> {
    const listed: unknown[] = [];
    for (const connector of await offered(token, requestId)) {
      if (listed.length >= MAX_TOOLS) break;
      const began = performance.now();
      // B66, before the send — and it refuses the whole request rather than
      // dropping this connector. A connector left out is D8's answer to "you
      // cannot use this"; it is NOT the answer to "tm8 cannot record what you
      // are about to do", which is a fault of this server and is said out loud.
      await auditStarted(token, connector, requestId, { method: 'tools/list', tool: null, requestBytes: 0 });
      let answer: unknown;
      try {
        answer = await proxy.request(claimsFor(token, requestId, connector.spaceId),
          externalSessionId(token.tokenId, connector.spaceId), connector.serverId, 'tools/list');
      } catch (error) {
        await auditExternal(token, connector, requestId, { method: 'tools/list', tool: null, outcome: 'denied',
          denyReason: mcpDenyReason(error) ?? 'forbidden', requestBytes: 0, latencyMs: performance.now() - began });
        continue;
      }
      await auditExternal(token, connector, requestId, { method: 'tools/list', tool: null, outcome: 'succeeded',
        requestBytes: 0, responseBytes: byteSize(answer), latencyMs: performance.now() - began });
      const tools = (answer as { tools?: unknown } | null)?.tools;
      if (!Array.isArray(tools)) continue;
      for (const raw of tools) {
        if (listed.length >= MAX_TOOLS) break;
        if (!raw || typeof raw !== 'object') continue;
        const tool = raw as Record<string, unknown>;
        const name = typeof tool['name'] === 'string' ? externalToolName(connector.serverKey, tool['name']) : null;
        if (!name) continue;
        listed.push(withSpaceIdArgument(name, tool, connector.spaceId));
      }
    }
    return listed;
  }

  /**
   * One `tools/call`. The key decides which connector, the `spaceId` argument
   * must agree with it, and the argument is removed before the call is relayed:
   * it is tm8's routing, not the provider's input.
   */
  async function callTool(token: ResolvedMcpToken, params: unknown, requestId: string): Promise<unknown> {
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      throw new CollabError('invalid_input', 'tools/call takes a params object');
    }
    const { name, arguments: args } = params as { name?: unknown; arguments?: unknown };
    if (typeof name !== 'string' || !name) throw new CollabError('invalid_input', 'tools/call needs a tool name');
    if (args !== undefined && (!args || typeof args !== 'object' || Array.isArray(args))) {
      throw new CollabError('invalid_input', 'tool arguments must be an object');
    }
    const supplied = { ...(args ?? {}) } as Record<string, unknown>;
    const spaceId = supplied['spaceId'];
    if (typeof spaceId !== 'string' || !spaceId) {
      throw new CollabError('invalid_input', 'every tm8 connector tool needs a spaceId argument');
    }
    const split = splitExternalToolName(name);
    const connector = split
      ? (await offered(token, requestId)).find(candidate => candidate.serverKey === split.serverKey)
      : undefined;
    // One answer for "no such key", "not yours any more" and "not offered to
    // external clients": a prober learns the same thing either way (D8).
    if (!split || !connector) throw new CollabError('invalid_input', `No such tool: ${name.slice(0, 60)}`);
    if (connector.spaceId !== spaceId) {
      throw new CollabError('invalid_input', `${name.slice(0, 60)} does not belong to the space you named`);
    }
    delete supplied['spaceId'];
    const callParams = { name: split.tool, arguments: supplied };
    const began = performance.now();
    const base = { method: 'tools/call' as const, tool: mcpToolName('tools/call', callParams),
      requestBytes: byteSize(supplied) };
    // B66: fail-closed, BEFORE the provider is reached.
    await auditStarted(token, connector, requestId, base);
    try {
      const result = await proxy.request(claimsFor(token, requestId, spaceId),
        externalSessionId(token.tokenId, spaceId), connector.serverId, 'tools/call', callParams);
      await auditExternal(token, connector, requestId,
        { ...base, outcome: 'succeeded', responseBytes: byteSize(result), latencyMs: performance.now() - began });
      return result;
    } catch (error) {
      const denyReason = mcpDenyReason(error);
      await auditExternal(token, connector, requestId, { ...base,
        ...(denyReason ? { outcome: 'denied' as const, denyReason } : { outcome: 'failed' as const }),
        latencyMs: performance.now() - began });
      throw error;
    }
  }

  /**
   * §5.6 for a caller with no session: 357's writer, under the token's own
   * claims. The raw write — it throws, and only `auditStarted` lets it.
   */
  function recordExternal(token: ResolvedMcpToken, connector: OfferedConnector, requestId: string,
    entry: ExternalAuditEntry): Promise<unknown> {
    return db.rpc(claimsFor(token, requestId, connector.spaceId), 'record_mcp_token_call_audit',
      [token.tokenId, connector.spaceId, connector.serverId, null, entry.method, entry.tool, entry.outcome,
       connector.memberId, entry.denyReason ?? null,
       entry.latencyMs === undefined ? null : Math.max(0, Math.round(entry.latencyMs)),
       entry.requestBytes, entry.responseBytes ?? null]);
  }

  /**
   * B66 — THE ONE AUDIT WRITE THAT MAY FAIL THE CALL. It runs before anything
   * reaches a provider, so failing closed costs nothing: nothing has happened
   * yet that a refusal would misreport. The alternative is the hole this closes
   * — an audit failure let an external call proceed with a tm8-held credential
   * and leave no trace, which §7.5 forbids. #1321 made exactly this write
   * throw on the session path (B50); this is the same rule for a caller with no
   * session.
   *
   * It runs before `authorize`, unlike the session path, because here authorize
   * is a port INSIDE `proxy.request` and the row has to precede the send. So a
   * call the proxy then refuses leaves a `started` row AND a `denied` one. That
   * over-records, which is the safe direction, and the row is attributable
   * either way: `offered()` has already proved the token admits this Space and
   * this connector.
   *
   * The database's own text is logged, never relayed (sendError says why): the
   * caller is told what happened in tm8's words and learns nothing else.
   */
  async function auditStarted(token: ResolvedMcpToken, connector: OfferedConnector, requestId: string,
    entry: StartedAuditEntry): Promise<void> {
    try {
      await recordExternal(token, connector, requestId, { ...entry, outcome: 'started' });
    } catch (error) {
      console.warn(`[tm8:mcp] external ${entry.method} on token ${token.tokenId} was REFUSED: `
        + `its started audit row could not be written: ${String(error)}`);
      throw new CollabError('invariant_violation',
        'this call was not made: tm8 could not record it in the MCP call audit');
    }
  }

  /**
   * Every row AFTER the call has begun. Never throws — a refusal's row must not
   * replace the refusal, and a succeeded row must not turn a call the provider
   * already acted on into an error the caller might retry (a second email).
   */
  async function auditExternal(token: ResolvedMcpToken, connector: OfferedConnector, requestId: string,
    entry: Omit<ExternalAuditEntry, 'outcome'> & { outcome: 'succeeded' | 'failed' | 'denied' }): Promise<void> {
    try {
      await recordExternal(token, connector, requestId, entry);
    } catch (error) {
      // A call naming a Space the token does not list records nothing, by design
      // (357): writing "someone tried" into a stranger's Space would be a write
      // into their audit. It is logged here instead.
      console.warn(`[tm8:mcp] external ${entry.outcome} call on token ${token.tokenId} was not audited: ${String(error)}`);
    }
  }
}

/**
 * Approved, enabled, external-facing connectors of one Space (Q4), with the
 * effective server key §4.2 computes from the definition. Only the two fields
 * the key needs are read: a definition this endpoint cannot parse must not take
 * the Space's whole list down, and nothing else here depends on the rest of it.
 */
async function externalConnectors(q: Querier, spaceId: string): Promise<Array<{ id: string; serverKey: string }>> {
  const rows = await q.query<{ id: string; name: string | null; server_key: string | null }>(
    `select e.id, m.definition->>'name' as name, m.definition->>'serverKey' as server_key
       from public.entities e join public.mcp_servers m on m.entity_id = e.id
      where e.space_id = $1 and e.kind = 'mcp_server' and e.deleted_at is null
        and m.definition->>'allowExternalClients' = 'true'
        and m.definition->>'approved' = 'true'
        and coalesce(m.definition->>'enabled', 'true') = 'true'
      order by e.id limit $2`, [spaceId, MAX_CONNECTORS_PER_SPACE]);
  return rows.filter(row => row.name).map(row => ({ id: row.id,
    serverKey: mcpServerKey({ name: row.name!, ...(row.server_key ? { serverKey: row.server_key } : {}) }) }));
}

/**
 * The claims one external call runs under. `authKind: 'mcp'` is what
 * `require_human_auth_kind()` refuses — so the token reaches no human door — and
 * what 357's own functions demand. `sessionSpaceId` is 227's pin, bound only
 * once a Space has been admitted, so for the rest of the call RLS answers for
 * that Space alone. No `actorId`, and never node admin (§5.5: "Node admin
 * rights never widen it").
 */
function claimsFor(token: ResolvedMcpToken, requestId: string, spaceId?: string): DbClaims {
  return { identityId: token.identityId, authKind: 'mcp', nodeAdmin: false, requestId,
    ...(spaceId ? { sessionSpaceId: spaceId } : {}) };
}

const EXTERNAL_SESSION_PREFIX = 'mcp-token';
/**
 * `McpProxy` keys its connection cache, its lock and its re-check comparison on
 * a session id. An external call has no session, so it carries the (token,
 * Space) pair it IS — the device `mcp.servers.test` already uses with its
 * literal `'test'`, but carrying what `authorize` needs, so that port stays a
 * pure function of its arguments.
 */
function externalSessionId(tokenId: string, spaceId: string): string {
  return `${EXTERNAL_SESSION_PREFIX}:${tokenId}:${spaceId}`;
}
function parseExternalSession(sessionId: string): { tokenId: string; spaceId: string } | null {
  const parts = sessionId.split(':');
  if (parts.length !== 3 || parts[0] !== EXTERNAL_SESSION_PREFIX || !parts[1] || !parts[2]) return null;
  return { tokenId: parts[1], spaceId: parts[2] };
}

/**
 * `<serverKey>__<tool>`, or null when the provider's tool name cannot be
 * carried. `__` is the field separator (§4.2), so a provider name containing one
 * is refused rather than split wrongly on the way back.
 */
export function externalToolName(serverKey: string, tool: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(tool) || tool.includes('__')) return null;
  const name = `${serverKey}__${tool}`;
  return name.length <= MAX_TOOL_NAME ? name : null;
}
export function splitExternalToolName(name: string): { serverKey: string; tool: string } | null {
  const at = name.indexOf('__');
  if (at <= 0) return null;
  const serverKey = name.slice(0, at);
  const tool = name.slice(at + 2);
  if (!serverKey || !tool || tool.includes('__')) return null;
  return { serverKey, tool };
}

/**
 * §7.1: `spaceId` is REQUIRED on every connector tool. Its `enum` is the one
 * Space this key names, so the model is told the value rather than left to guess
 * it, and a stale list cannot route a call into another Space. The provider's
 * own schema passes through untouched apart from that property, so a provider
 * that declares none still gets a usable one.
 */
function withSpaceIdArgument(name: string, tool: Record<string, unknown>, spaceId: string): Record<string, unknown> {
  const schema = (tool['inputSchema'] ?? {}) as Record<string, unknown>;
  const properties = { ...((schema['properties'] as Record<string, unknown> | undefined) ?? {}) };
  const required = Array.isArray(schema['required']) ? (schema['required'] as unknown[]).filter(v => typeof v === 'string') : [];
  properties['spaceId'] = { type: 'string', enum: [spaceId],
    description: 'The tm8 Space to run this tool in. Required: one token can reach several Spaces.' };
  return { ...tool, name,
    inputSchema: { ...schema, type: 'object', properties, required: [...new Set([...required as string[], 'spaceId'])] } };
}

function protocolVersionOf(params: unknown): string | undefined {
  const requested = (params as { protocolVersion?: unknown } | null)?.protocolVersion;
  return typeof requested === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(requested) ? requested : undefined;
}

function isRpcId(value: unknown): value is string | number | null {
  return typeof value === 'string' || typeof value === 'number' || value === null;
}

function bearerOf(req: IncomingMessage): string | null {
  const raw = req.headers['authorization'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const match = /^Bearer\s+(\S+)$/i.exec(value?.trim() ?? '');
  return match ? match[1]! : null;
}

function clientIp(req: IncomingMessage): string | undefined {
  // The socket peer, never a forwarded header: a caller-controlled value in an
  // audit column is worse than an empty one.
  return req.socket.remoteAddress ?? undefined;
}

/**
 * B63.2. An MCP client is not a browser: Claude Desktop, Cursor and `claude mcp`
 * send no `Origin`, so refusing every origin that is not explicitly allowed
 * costs nothing and closes the DNS-rebinding path the Streamable-HTTP guidance
 * warns about — a page on any origin resolving a name to 127.0.0.1 and driving
 * this endpoint. The allow-list is empty unless an operator fills it.
 */
function requireAllowedOrigin(req: IncomingMessage, allowed: ReadonlySet<string>): void {
  const raw = req.headers['origin'];
  const origin = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!origin) return;
  if (!allowed.has(origin)) throw refused('this origin is not allowed to reach the tm8 MCP endpoint');
}

function refused(message: string): CollabError {
  return new CollabError('forbidden', message, { details: { sqlstate: '42501' } });
}
function unauthenticated(message: string): CollabError {
  return new CollabError('unauthenticated', message);
}
/**
 * The envelope itself was unreadable — not a JSON-RPC request at all. That is
 * the one failure the transport answers with a 4xx (Streamable HTTP says so),
 * where every APPLICATION refusal is a 200 carrying a JSON-RPC error, because
 * that is what an MCP client turns back into a failed tool call for its model
 * instead of a dead connection.
 */
function malformed(message: string): CollabError {
  return new CollabError('invalid_input', message, { details: { transport: true } });
}
function rateLimited(retryAfterMs: number): CollabError {
  return new CollabError('rate_limited', 'too many MCP endpoint requests',
    { details: { retryAfterMs, retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)) } });
}

function noStore(requestId: string): Record<string, string> {
  return { 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff',
    'cache-control': 'no-store', 'x-tm8-request-id': requestId };
}

function sendJson(res: ServerResponse, status: number, requestId: string, body: unknown,
  extra: Record<string, string> = {}): void {
  res.writeHead(status, { ...noStore(requestId), ...extra });
  res.end(JSON.stringify(body));
}

/**
 * One error writer. A JSON-RPC error carries OUR message or nothing: an
 * upstream's or the database's text is logged, never relayed, so the endpoint
 * cannot be used to read internals. The HTTP status is the transport's answer
 * (401 so a client knows to re-authenticate, 429 so it backs off); an
 * application refusal is a 200 with a JSON-RPC error, which is what an MCP
 * client surfaces to its model as a failed tool call.
 */
function sendError(res: ServerResponse, error: unknown, requestId: string, id: string | number | null): void {
  const collab = isCollabError(error) ? error : undefined;
  if (!collab) console.error(`[tm8:mcp] /mcp error (requestId=${requestId}): ${String(error)}`);
  const code = collab?.code;
  const status = code === 'unauthenticated' ? 401
    : code === 'rate_limited' ? 429
    : code === 'payload_too_large' ? 413
    : collab?.details?.['transport'] === true ? 400
    : 200;
  sendJson(res, status, requestId,
    { jsonrpc: '2.0', id, error: { code: rpcCode(code), message: collab ? collab.message : 'MCP request failed' } },
    status === 401 ? { 'www-authenticate': 'Bearer realm="tm8", error="invalid_token"' } : {});
}

function rpcCode(code: string | undefined): number {
  switch (code) {
    case 'invalid_input': return -32602;
    case 'not_found': return -32601;
    default: return -32000;
  }
}
