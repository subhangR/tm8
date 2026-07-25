/**
 * Minimal stub server — the G0 red target. It exists so the conformance suite
 * runs end-to-end TODAY (and fails red): every catalog operation is routed and
 * answered with an honest, contract-shaped `501 not_implemented`; unknown
 * routes get a contract-shaped `404 not_found`; malformed JSON gets
 * `400 invalid_input`.
 *
 * This is NOT packages/server (that package is Altair's). The stub is a test
 * fixture demonstrating exactly two things: the wire error envelope, and 501
 * honesty. Everything semantic stays red until the real graph engine lands.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ERROR_STATUS, OPERATIONS, type CommandErrorCode } from '@tm8/contract';

let requestSeq = 0;

function sendError(res: ServerResponse, code: CommandErrorCode, message: string, details?: unknown): void {
  requestSeq += 1;
  const body = {
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
      requestId: `req_stub_${requestSeq.toString(36).padStart(6, '0')}`,
      retryable: code === 'rate_limited' || code === 'upstream_unavailable',
    },
  };
  res.writeHead(ERROR_STATUS[code], { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Compile catalog paths (`/v2/entities/:id`) into matchers. */
const ROUTES = OPERATIONS
  .filter((op) => op.method !== 'WS')
  .map((op) => ({
    op,
    re: new RegExp(`^${op.path.replace(/:[A-Za-z]+/g, '[^/]+')}$`),
  }));

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

function handler(req: IncomingMessage, res: ServerResponse): void {
  void (async () => {
    const url = new URL(req.url ?? '/', 'http://stub');
    const path = url.pathname;
    if (path === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, server: 'tm8-conformance-stub' }));
      return;
    }
    const raw = await readBody(req);
    if (raw) {
      try {
        JSON.parse(raw);
      } catch {
        sendError(res, 'invalid_input', 'request body is not valid JSON');
        return;
      }
    }
    const match = ROUTES.find((r) => r.op.method === req.method && r.re.test(path));
    if (!match) {
      sendError(res, 'not_found', `no operation bound to ${req.method} ${path}`);
      return;
    }
    // Reserved and v1 operations alike: the stub implements nothing, and says so.
    sendError(res, 'not_implemented', `operation ${match.op.name} is not implemented by the stub server`);
  })().catch(() => sendError(res, 'upstream_unavailable', 'stub failure'));
}

export function startStubServer(port: number): Promise<Server> {
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

export function stopStubServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
}
