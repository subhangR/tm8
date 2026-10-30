#!/usr/bin/env node
// A minimal MCP server for checking tm8's HTTP connector path end to end.
// Zero dependencies: Streamable HTTP transport (JSON responses, no SSE), one
// endpoint at /mcp, guarded by an API key.
//
//   MCP_API_KEY=secret PORT=8787 node examples/mcp-test-server/server.mjs
//
// The key is accepted as `Authorization: Bearer <key>` (tm8's default for an
// api_key connector) or as `X-API-Key: <key>` (a connector with
// headerName=X-API-Key). Without MCP_API_KEY a random key is generated and
// printed at startup.
import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '127.0.0.1';
const API_KEY = process.env.MCP_API_KEY || randomBytes(24).toString('hex');
const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];

const sessions = new Map(); // mcp-session-id -> { calls, createdAt }

const tools = [
  {
    name: 'echo',
    description: 'Return the given text unchanged. Use to confirm the connector round-trips.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    run: ({ text }) => String(text),
  },
  {
    name: 'add',
    description: 'Add two numbers.',
    inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
    run: ({ a, b }) => {
      if (typeof a !== 'number' || typeof b !== 'number') throw new Error('a and b must be numbers');
      return String(a + b);
    },
  },
  {
    name: 'server_info',
    description: 'Report this test server\'s time, uptime, session id and how many tool calls it has served.',
    inputSchema: { type: 'object', properties: {} },
    run: (_args, session, sessionId) => JSON.stringify({
      server: 'tm8-mcp-test-server',
      now: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      sessionId: sessionId ?? null,
      callsThisSession: session?.calls ?? null,
    }, null, 2),
  },
];

function authorized(req) {
  const auth = req.headers.authorization;
  const presented = typeof auth === 'string' && /^bearer /i.test(auth) ? auth.slice(7).trim() : req.headers['x-api-key'];
  if (typeof presented !== 'string' || !presented) return false;
  // Hash both sides so the comparison is constant-time regardless of length.
  const digest = value => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(presented), digest(API_KEY));
}

function send(res, status, body, headers = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { ...(payload ? { 'content-type': 'application/json' } : {}), ...headers });
  res.end(payload);
}

const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

function handle(message, sessionId, newSessionHeaders) {
  const { id, method, params } = message ?? {};
  if (message?.jsonrpc !== '2.0' || typeof method !== 'string') return rpcError(id, -32600, 'Invalid Request');
  const isNotification = id === undefined;
  const session = sessionId ? sessions.get(sessionId) : undefined;

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      const protocolVersion = SUPPORTED.includes(requested) ? requested : SUPPORTED[0];
      const newId = randomUUID();
      sessions.set(newId, { calls: 0, createdAt: Date.now() });
      newSessionHeaders['mcp-session-id'] = newId;
      log(`initialize client=${params?.clientInfo?.name ?? '?'} protocol=${protocolVersion} session=${newId}`);
      return { jsonrpc: '2.0', id, result: {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'tm8-mcp-test-server', version: '0.1.0' },
        instructions: 'A test server: echo, add and server_info.',
      } };
    }
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };
    case 'tools/list':
      log('tools/list');
      return { jsonrpc: '2.0', id, result: { tools: tools.map(({ run: _run, ...tool }) => tool) } };
    case 'tools/call': {
      const tool = tools.find(t => t.name === params?.name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${params?.name}`);
      if (session) session.calls += 1;
      log(`tools/call ${tool.name} ${JSON.stringify(params?.arguments ?? {})}`);
      try {
        const text = tool.run(params?.arguments ?? {}, session, sessionId);
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }], isError: false } };
      } catch (error) {
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(error?.message ?? error) }], isError: true } };
      }
    }
    default:
      return isNotification ? null : rpcError(id, -32601, `Method not found: ${method}`);
  }
}

function log(line) { console.log(`${new Date().toISOString()} ${line}`); }

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  if (url.pathname === '/health') return send(res, 200, { ok: true });
  // The endpoint is /mcp, and / answers too, so a connector saved without the path still works.
  if (url.pathname !== '/mcp' && url.pathname !== '/') {
    log(`404 ${req.method} ${url.pathname} (the MCP endpoint is /mcp)`);
    return send(res, 404, { error: 'not found; the MCP endpoint is /mcp' });
  }
  if (!authorized(req)) {
    log(`401 ${req.method} ${url.pathname} (missing or wrong API key)`);
    return send(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
  }

  const sessionId = req.headers['mcp-session-id'];
  if (req.method === 'DELETE') {
    if (typeof sessionId === 'string') sessions.delete(sessionId);
    return send(res, 204);
  }
  // No server-initiated stream: GET is allowed to answer 405 under Streamable HTTP.
  if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' }, { allow: 'POST, DELETE' });
  if (typeof sessionId === 'string' && !sessions.has(sessionId)) return send(res, 404, rpcError(null, -32001, 'Session not found'));

  let raw = '';
  req.setEncoding('utf8');
  req.on('data', chunk => {
    raw += chunk;
    if (raw.length > 1_000_000) req.destroy();
  });
  req.on('end', () => {
    let body;
    try { body = JSON.parse(raw); } catch { return send(res, 400, rpcError(null, -32700, 'Parse error')); }
    const headers = {};
    const responses = (Array.isArray(body) ? body : [body])
      .map(message => handle(message, typeof sessionId === 'string' ? sessionId : undefined, headers))
      .filter(Boolean);
    if (responses.length === 0) return send(res, 202, undefined, headers);
    send(res, 200, Array.isArray(body) ? responses : responses[0], headers);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`tm8 MCP test server listening on http://${HOST}:${PORT}/mcp`);
  console.log(`API key: ${API_KEY}${process.env.MCP_API_KEY ? ' (from MCP_API_KEY)' : ' (generated; set MCP_API_KEY to fix it)'}`);
  console.log('Send it as "Authorization: Bearer <key>" or "X-API-Key: <key>".');
});
