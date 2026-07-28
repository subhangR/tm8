/**
 * The request pipeline — the frame every W2 handler runs inside.
 *
 * Order is load-bearing, so it is written out once here and nowhere else:
 *
 *   1. mint a requestId (before anything can fail, so every response has one)
 *   2. transport checks (./security.ts — S1 aside, deferred no-ops today)
 *   3. `/health` — the liveness probe, deliberately OUTSIDE the catalog and
 *      outside the envelope: it is infrastructure, not an operation
 *   4. narrowly matched support transports (raw FileUploadGrant PUT)
 *   5. read + JSON-parse the body → `payload_too_large` / `invalid_input`
 *   6. route against the catalog → `not_found`
 *   7. resolve identity (S5 auto-owner today)
 *   8. handler lookup → `not_implemented` when unbuilt (DEV-13)
 *   9. zod-validate the input → `invalid_input`
 *  10. run the handler, wrap in the DEV-6 envelope
 *  11. anything thrown → the single DEV-8 error writer
 *
 * Two orderings are worth defending because they look arbitrary and are not:
 *
 * - **parse before route** (4 before 5). A malformed body is malformed
 *   whatever it was aimed at, and the conformance envelope suite asserts
 *   `POST /v2/entities` + `'{not json'` → 400 regardless of routing. The
 *   conformance stub does the same; matching it keeps the two servers
 *   comparable.
 * - **501 before validate** (7 before 8). An operation nobody implemented
 *   must say *that*, not complain about its input. Validating first would
 *   make `GET /v2/search` (reserved, DEV-13) answer 400 for a missing `q`
 *   instead of the 501 the contract demands.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { BASE_PATH, CONTRACT_VERSION, envelope } from '@tm8/contract';
import type { ZodTypeAny } from 'zod';
import { HandlerRegistry, INPUT_SCHEMAS } from '../facade/index.js';
import { readJsonBody } from './body.js';
import type { ServerConfig } from './config.js';
import { fail, notImplemented, sendWireError } from './errors.js';
import { nextRequestId } from './request-id.js';
import { Router } from './router.js';
import { autoOwnerResolver, BASE_SECURITY_HEADERS, checkTransport } from './security.js';
import type { StaticHandler } from './static.js';
import type { W2FileUploadRoute } from './w2-file-upload.js';
import {
  isHandlerResult,
  type HandlerResult,
  type IdentityResolver,
  type RequestContext,
} from './types.js';

const FILE_UPLOAD_SUPPORT_PATH = /^\/v2\/files\/uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/content$/;

/**
 * The WS side of the frame, kept behind a structural type so the HTTP
 * pipeline never imports the event block directly — the socket
 * implementation is swappable (see ../events/ws-server.ts).
 */
export interface UpgradeTarget {
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> | void;
  closeAll?(): void;
}

export interface FacadeServerOptions {
  readonly config: ServerConfig;
  readonly registry: HandlerRegistry;
  readonly router?: Router;
  readonly identityResolver?: IdentityResolver;
  readonly upgrades?: UpgradeTarget;
  readonly staticHandler?: StaticHandler;
  /** The sole non-catalog support transport: FileUploadGrant raw-byte PUT. */
  readonly fileUploadRoute?: W2FileUploadRoute;
}

export interface FacadeServer {
  readonly http: Server;
  readonly config: ServerConfig;
  readonly registry: HandlerRegistry;
  readonly router: Router;
  listen(): Promise<{ host: string; port: number; url: string }>;
  close(): Promise<void>;
}

export function createFacadeServer(opts: FacadeServerOptions): FacadeServer {
  const { config, registry, staticHandler, upgrades } = opts;
  const router = opts.router ?? new Router();
  const resolveIdentity = opts.identityResolver ?? autoOwnerResolver;

  const http = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      // Last-resort net: `handle` already funnels its own failures, so
      // reaching here means the error writer itself threw.
      try {
        sendWireError(res, err, nextRequestId());
      } catch {
        res.destroy();
      }
    });
  });

  if (upgrades) {
    http.on('upgrade', (req, socket, head) => {
      void Promise.resolve(upgrades.handleUpgrade(req, socket, head)).catch(() => {
        socket.destroy();
      });
    });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = nextRequestId();
    const method = req.method ?? 'GET';
    // The base is a placeholder: only pathname + search are ever read from it.
    const url = new URL(req.url ?? '/', 'http://tm8.invalid');
    const pathname = url.pathname;

    try {
      const decision = checkTransport(method, req.headers, config);
      if (decision.refusal) throw fail(decision.refusal.code, decision.refusal.message);

      if (pathname === '/health') {
        // Unenveloped on purpose: `/health` is not a catalog operation, so it
        // must not look like one. It is a liveness probe for the dev
        // orchestrator, the conformance global-setup, and `doctor`. It also
        // reports how much of the catalog is actually built — the honest
        // answer to "is this a real server or a stub?".
        sendRaw(res, 200, requestId, {
          ok: true,
          server: 'tm8-server',
          contractVersion: CONTRACT_VERSION,
          operations: router.mounted().length,
          implemented: registry.size,
        });
        return;
      }

      // NOTE: the interim `GET /pty/output` 500ms scrollback poll used to live
      // here. It was replaced by the real push stream — the PTY WebSocket in
      // ../pty/, which shares the events WS path and is told apart by its
      // `sessionId` query param. The poll WAS the terminal lag: it re-rendered
      // on a fixed 500ms tick regardless of output, so a fast agent arrived in
      // visible bursts. Do not reintroduce it as a fallback; a live PTY has one
      // delivery path and a second one desynchronizes the offset accounting.

      const isApiPath = pathname === BASE_PATH || pathname.startsWith(`${BASE_PATH}/`);

      // Static assets never get a chance to shadow the API surface: an unknown
      // `/v2/...` path is an honest `not_found`, never an index.html with a 200.
      if (!isApiPath && staticHandler && method === 'GET') {
        if (await staticHandler.serve(pathname, res)) return;
      }

      if (method === 'PUT' && FILE_UPLOAD_SUPPORT_PATH.test(pathname) && opts.fileUploadRoute) {
        const identity = await resolveIdentity(req.headers);
        if (await opts.fileUploadRoute(req, res, { requestId, identity })) return;
      }

      const { value: body } = await readJsonBody(req, config.maxBodyBytes);

      const match = router.match(method, pathname);
      if (!match) throw fail('not_found', `no operation bound to ${method} ${pathname}`);

      const identity = await resolveIdentity(req.headers);

      const handler = registry.get(match.opName);
      if (!handler) throw notImplemented(match.opName);

      const schema: ZodTypeAny | undefined = INPUT_SCHEMAS[match.opName];
      const input = schema ? validate(schema, body) : body;

      const ctx: RequestContext = {
        op: match.op,
        opName: match.opName,
        params: match.params,
        query: url.searchParams,
        body: input,
        requestId,
        identity,
        headers: req.headers,
        method,
        path: pathname,
      };

      const result = await handler(ctx);
      writeResult(res, requestId, result);
    } catch (err) {
      sendWireError(res, err, requestId);
    }
  }

  return {
    http,
    config,
    registry,
    router,
    listen() {
      return new Promise((resolveListen, rejectListen) => {
        http.once('error', rejectListen);
        http.listen(config.port, config.host, () => {
          http.removeListener('error', rejectListen);
          // Read the port back off the socket rather than trusting config:
          // `port: 0` (tests) binds an ephemeral port and must report the real one.
          const address = http.address();
          const port = typeof address === 'object' && address !== null ? address.port : config.port;
          resolveListen({
            host: config.host,
            port,
            url: `http://${config.host}:${port}`,
          });
        });
      });
    },
    close() {
      upgrades?.closeAll?.();
      return new Promise((resolveClose, rejectClose) =>
        http.close((e) => (e ? rejectClose(e) : resolveClose())),
      );
    },
  };
}

/** Zod failure → the taxonomy's `invalid_input`, with the issue list as details. */
function validate(schema: ZodTypeAny, body: unknown): unknown {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  throw fail('invalid_input', 'request body failed contract validation', {
    issues: parsed.error.issues,
  });
}

/**
 * DEV-6: a successful response is `{ data, requestId }` and nothing else —
 * in particular `nextCursor` lives inside `data.page` on list shapes, never
 * at the envelope level. The one sanctioned escape is a `raw` result, used by
 * `files.download`, which returns bytes rather than JSON by contract.
 */
function writeResult(res: ServerResponse, requestId: string, result: HandlerResult | unknown): void {
  if (isHandlerResult(result)) {
    if (result.kind === 'raw') {
      res.writeHead(result.status, {
        ...BASE_SECURITY_HEADERS,
        ...result.headers,
        'x-tm8-request-id': requestId,
      });
      res.end(result.body);
      return;
    }
    sendJson(res, result.status ?? 200, requestId, result.data, result.headers);
    return;
  }

  sendJson(res, 200, requestId, result);
}

function sendJson(
  res: ServerResponse,
  status: number,
  requestId: string,
  data: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  sendRaw(res, status, requestId, envelope(data, requestId), extraHeaders);
}

/** Writes a JSON body verbatim — used only for `/health`, which is not an operation. */
function sendRaw(
  res: ServerResponse,
  status: number,
  requestId: string,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  res.writeHead(status, {
    ...BASE_SECURITY_HEADERS,
    ...extraHeaders,
    'content-type': 'application/json; charset=utf-8',
    'x-tm8-request-id': requestId,
  });
  res.end(JSON.stringify(body));
}
