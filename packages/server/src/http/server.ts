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
import { normalizeCommandInputForIdempotencyMode } from './idempotency.js';
import { nextRequestId } from './request-id.js';
import { Router } from './router.js';
import {
  autoOwnerResolver,
  BASE_SECURITY_HEADERS,
  checkTransport,
  checkUpgradeTransport,
} from './security.js';
import type { StaticHandler } from './static.js';
import type { RemoteServerProxy } from './remote-proxy.js';
import type { W2FileUploadRoute } from './w2-file-upload.js';
import { VOICE_WEBHOOK_PATH, type VoiceWebhookRoute } from './voice-webhook.js';
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
  /**
   * The LiveKit webhook callback. Like the upload route it is dispatched
   * before `readJsonBody`, because LiveKit signs the RAW body and a
   * re-serialized one has a different digest.
   */
  readonly voiceWebhookRoute?: VoiceWebhookRoute;
  /** Same-origin relay for node-local named Server connections. */
  readonly remoteServerProxy?: RemoteServerProxy;
  /**
   * Answers "can this node actually serve a read right now?" — in practice, a
   * `select 1` through the SAME pool every space-scoped read uses. `/health`
   * without this reported only in-memory router state, which stays green while
   * the pool is exhausted — the exact outage it exists to detect (observed in
   * the field: `/health` 200 while every `/v2/spaces/:id/*` read hung).
   * Optional because a node wired without a database has no pool to probe and
   * its honest health is the 501s it serves.
   */
  readonly healthProbe?: () => Promise<void>;
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

  if (upgrades || opts.remoteServerProxy) {
    http.on('upgrade', (req, socket, head) => {
      // S2/S3 on the upgrade path. This listener never reaches `handle`, so
      // the transport checks there do NOT cover it (design C3: "two wiring
      // changes, not one") — a rebound Host or a foreign browser Origin must
      // be refused before any socket server sees the request.
      const upgradeDecision = checkUpgradeTransport(req.headers, config);
      if (upgradeDecision.refusal) {
        socket.write(
          'HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n' +
            `${upgradeDecision.refusal.message}\n`,
        );
        socket.destroy();
        return;
      }
      const pathname = new URL(req.url ?? '/', 'http://tm8.invalid').pathname;
      if (opts.remoteServerProxy?.matches(pathname)) {
        void opts.remoteServerProxy.handleUpgrade(req, socket, head);
        return;
      }
      if (!upgrades) {
        socket.destroy();
        return;
      }
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

      if (opts.remoteServerProxy?.matches(pathname)) {
        await opts.remoteServerProxy.handleHttp(req, res);
        return;
      }

      if (pathname === '/health') {
        // Unenveloped on purpose: `/health` is not a catalog operation, so it
        // must not look like one. It is a liveness probe for the dev
        // orchestrator, the conformance global-setup, and `doctor`. It also
        // reports how much of the catalog is actually built — the honest
        // answer to "is this a real server or a stub?".
        //
        // The DB probe is bounded at 2s: a health check that can hang is a
        // health check that lies by omission, and 2s is an eternity for
        // `select 1` on a local node — anything slower IS the outage. `db`
        // is reported as its own field (and flips `ok`) so a probe reading
        // only `ok` and a human reading the body both get the truth.
        let dbOk: boolean | undefined;
        if (opts.healthProbe) {
          try {
            await Promise.race([
              opts.healthProbe(),
              new Promise((_, reject) => {
                const t = setTimeout(() => reject(new Error('health probe timed out')), 2_000);
                (t as { unref?: () => void }).unref?.();
              }),
            ]);
            dbOk = true;
          } catch {
            dbOk = false;
          }
        }
        sendRaw(res, dbOk === false ? 503 : 200, requestId, {
          ok: dbOk !== false,
          server: 'tm8-server',
          contractVersion: CONTRACT_VERSION,
          operations: router.mounted().length,
          implemented: registry.size,
          ...(dbOk === undefined ? {} : { db: dbOk ? 'ok' : 'unavailable' }),
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

      // No identity resolution: the SFU is not a tm8 identity, and the route
      // authenticates it by signature instead. Before readJsonBody, deliberately.
      if (method === 'POST' && pathname === VOICE_WEBHOOK_PATH && opts.voiceWebhookRoute) {
        if (await opts.voiceWebhookRoute(req, res, { requestId })) return;
      }

      const { value: body } = await readJsonBody(req, config.maxBodyBytes);

      const match = router.match(method, pathname);
      if (!match) throw fail('not_found', `no operation bound to ${method} ${pathname}`);

      const identity = await resolveIdentity(req.headers);

      const handler = registry.get(match.opName);
      if (!handler) throw notImplemented(match.opName);

      const requestBody = normalizeCommandInputForIdempotencyMode(
        match.op,
        body,
        // `!== false`, not `=== true`. This is the site that REWRITES the
        // caller's clientMutationId when idempotency is off, so reading an
        // absent field as "off" silently discards every caller's id.
        config.idempotencyEnabled !== false,
      );
      const schema: ZodTypeAny | undefined = INPUT_SCHEMAS[match.opName];
      const input = schema ? validate(schema, requestBody) : requestBody;

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
