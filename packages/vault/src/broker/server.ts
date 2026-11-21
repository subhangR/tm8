import { readFile, mkdir, lstat, chmod, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { Socket } from 'node:net';
import { VaultError, type VaultCaller } from '../core-types.js';
import {
  AttestationError, AttestationVerifier, VAULT_ATTESTATION_HEADER, loadAttestationPublicKey,
  type AttestationFailure,
} from '../relay/attestation.js';
import { VAULT_ALERTS_HEADER } from '../relay/alerts.js';
import { VAULT_BODY_LIMITS, vaultBodyLimit } from '../relay/routes.js';
import type { AlertOutbox } from './alerts.js';
import {
  brokerErrorResponse, createBrokerDispatcher, mapBrokerError, matchBrokerRoute, sweepBrokerResponse,
  type BrokerDependencies, type BrokerResponse,
} from './dispatcher.js';

export const BROKER_BODY_LIMITS = VAULT_BODY_LIMITS;
/** Unauthenticated errors have one byte-identical body, with no unverified request id. */
export const UNATTESTED_REQUEST_ID = '00000000-0000-4000-8000-000000000000';

export interface BrokerServerOptions extends BrokerDependencies {
  /** Must have a dedicated, owner-only directory. Existing paths are never unlinked on startup. */
  socketPath: string;
  relayPublicKeyFile: string;
  mtls?: { host: string; port: number; keyFile: string; certFile: string; caFile: string };
  /**
   * Pending owner alerts ride on attested responses only, so an unattested
   * connection never receives them. The relay strips the header (relay/alerts.ts).
   */
  alertOutbox?: AlertOutbox;
  maxHeaderSize?: number;
  headersTimeoutMs?: number;
  requestTimeoutMs?: number;
  closeGraceMs?: number;
  maxReplayEntries?: number;
}

export interface BrokerServer {
  readonly http: Server;
  readonly https: ReturnType<typeof createHttpsServer> | null;
  readonly socketPath: string;
  readonly attestationFailures: ReadonlyMap<AttestationFailure, number>;
  listen(): Promise<void>;
  close(): Promise<void>;
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`vault broker: invalid ${name}`);
  return value;
}

function rawTarget(target: string): { path: string; query: string } {
  const at = target.indexOf('?');
  return { path: at === -1 ? target : target.slice(0, at), query: at === -1 ? '' : target.slice(at + 1) };
}

/** Call only with the exact header that AttestationVerifier.verify has just accepted. */
function verifiedRequestId(header: string): string {
  return (JSON.parse(Buffer.from(header.split('.')[0]!, 'base64url').toString('utf8')) as { rid: string }).rid.toLowerCase();
}

async function readBody(req: IncomingMessage, cap: number): Promise<Buffer> {
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > cap)) throw new VaultError('payload_too_large');
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += bytes.length;
    if (total > cap) throw new VaultError('payload_too_large');
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

/** Creates listeners without listening. It reads only the public relay key and optional TLS credentials. */
export async function createBrokerServer(options: BrokerServerOptions): Promise<BrokerServer> {
  const maxHeaderSize = positive(options.maxHeaderSize ?? 16 * 1024, 'maxHeaderSize');
  const headersTimeout = positive(options.headersTimeoutMs ?? 5000, 'headersTimeoutMs');
  const requestTimeout = positive(options.requestTimeoutMs ?? 30_000, 'requestTimeoutMs');
  const closeGrace = positive(options.closeGraceMs ?? 1000, 'closeGraceMs');
  const verifier = new AttestationVerifier(loadAttestationPublicKey(await readFile(options.relayPublicKeyFile)),
    { clock: options.clock, maxReplayEntries: options.maxReplayEntries });
  const dispatch = createBrokerDispatcher(options);
  const failures = new Map<AttestationFailure, number>();
  const active = new Set<AbortController>();
  const sockets = new Set<Socket>();
  let closing = false;
  let listening = false;
  let socketInode: number | null = null;
  let closePromise: Promise<void> | null = null;

  const write = (res: ServerResponse, result: BrokerResponse, requestId: string, attested: boolean): void => {
    if (res.destroyed || res.writableEnded) return;
    let alerts: string | null = null;
    // Taken only once the response can still be written; a handler header can never set or replace it.
    try { alerts = attested ? options.alertOutbox?.take() ?? null : null; } catch { alerts = null; }
    const { [VAULT_ALERTS_HEADER]: _ignored, ...headers } = result.headers;
    res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
      'x-content-type-options': 'nosniff', ...(result.body === '' ? {} : { 'x-tm8-request-id': requestId }), ...headers,
      ...(alerts === null ? {} : { [VAULT_ALERTS_HEADER]: alerts }) });
    res.end(result.body);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const started = performance.now();
    const abort = new AbortController();
    active.add(abort);
    let requestId = UNATTESTED_REQUEST_ID;
    let caller: VaultCaller | null = null;
    let status = 500;
    let attested = false;
    const target = rawTarget(req.url ?? '');
    const route = matchBrokerRoute(req.method ?? '', target.path);
    const timer = setTimeout(() => { abort.abort(); req.destroy(); }, requestTimeout);
    timer.unref();
    const disconnected = () => { if (!res.writableFinished) abort.abort(); };
    req.once('aborted', disconnected);
    res.once('close', disconnected);
    try {
      if (closing) throw VaultError.reason('vault_unavailable');
      const header = req.headers[VAULT_ATTESTATION_HEADER];
      if (!header) throw new AttestationError('missing');
      const cap = vaultBodyLimit(route?.row.name);
      const body = await readBody(req, cap);
      caller = verifier.verify(header, { method: req.method ?? '', ...target, body });
      attested = true;
      // Claims have been signature/schema/replay checked. Never inspect this payload before verify succeeds.
      requestId = verifiedRequestId(header as string);
      const result = await dispatch({ method: req.method ?? '', ...target, body, headers: req.headers, caller, requestId, signal: abort.signal });
      status = result.status;
      write(res, result, requestId, true);
    } catch (error) {
      let result: BrokerResponse;
      if (error instanceof AttestationError) {
        failures.set(error.code, (failures.get(error.code) ?? 0) + 1);
        result = brokerErrorResponse(new VaultError('unauthenticated'), UNATTESTED_REQUEST_ID);
      } else {
        result = brokerErrorResponse(mapBrokerError(error, options.audit), requestId);
      }
      // Even pre-attestation errors are swept. No unverified identity is used for an alert.
      if (caller) result = sweepBrokerResponse(result, { caller, requestId }, options);
      else {
        try { if (options.components.canaries.matches(Buffer.from(result.body))) result = { status: 500, body: '', headers: {} }; }
        catch { result = { status: 500, body: '', headers: {} }; }
      }
      status = result.status;
      if (!attested) result.headers.connection = 'close';
      write(res, result, requestId, attested);
      if (!req.complete) req.resume();
    } finally {
      clearTimeout(timer);
      active.delete(abort);
      req.removeListener('aborted', disconnected);
      res.removeListener('close', disconnected);
      // Do not pass an Error or any request object to the logger.
      try { options.log?.({ op: route?.row.name ?? null, status, ms: Math.max(0, performance.now() - started), requestId }); }
      catch { /* Logging cannot affect an already decided response. */ }
    }
  };

  const http = createServer({ maxHeaderSize, headersTimeout, requestTimeout }, (req, res) => { void handle(req, res); });
  const tls = options.mtls;
  const https = tls ? createHttpsServer({
    maxHeaderSize, headersTimeout, requestTimeout, requestCert: true, rejectUnauthorized: true,
    minVersion: 'TLSv1.3', ca: await readFile(tls.caFile), key: await readFile(tls.keyFile), cert: await readFile(tls.certFile),
  }, (req, res) => { void handle(req, res); }) : null;
  const servers = https ? [http, https] : [http];
  for (const server of servers) {
    server.maxHeadersCount = 64;
    server.headersTimeout = headersTimeout;
    server.requestTimeout = requestTimeout;
    server.keepAliveTimeout = 1000;
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    // Parser failures get no echo of the rejected bytes, URL or headers.
    server.on('clientError', (_error, socket) => {
      if (!socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    });
  }

  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    closing = true;
    for (const abort of active) abort.abort();
    closePromise = (async () => {
      const kill = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, closeGrace);
      kill.unref();
      try {
        await Promise.all(servers.map((server) => new Promise<void>((resolve, reject) => {
          if (!server.listening) { resolve(); return; }
          server.close((error) => error ? reject(new Error('vault broker: close failed')) : resolve());
          server.closeIdleConnections();
        })));
      } finally {
        clearTimeout(kill);
        if (socketInode !== null) {
          try {
            const current = await lstat(options.socketPath);
            if (current.isSocket() && current.ino === socketInode) await unlink(options.socketPath);
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('vault broker: socket cleanup failed'); }
        }
      }
    })();
    return closePromise;
  };

  return {
    http, https, socketPath: options.socketPath, attestationFailures: failures,
    async listen() {
      if (closing || listening) throw new Error('vault broker: listener unavailable');
      const directory = dirname(options.socketPath);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700
        || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error('vault broker: socket directory must be owner-only');
      try { await lstat(options.socketPath); throw new Error('vault broker: socket path exists'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('vault broker: socket path unavailable'); }
      try {
        await new Promise<void>((resolve, reject) => {
          const failed = () => reject(new Error('vault broker: listen failed'));
          http.once('error', failed);
          http.listen(options.socketPath, () => { http.removeListener('error', failed); resolve(); });
        });
        socketInode = (await lstat(options.socketPath)).ino;
        await chmod(options.socketPath, 0o600);
        if (https && tls) await new Promise<void>((resolve, reject) => {
          const failed = () => reject(new Error('vault broker: mTLS listen failed'));
          https.once('error', failed);
          https.listen(tls.port, tls.host, () => { https.removeListener('error', failed); resolve(); });
        });
        listening = true;
      } catch (error) { await close(); throw error; }
    },
    close,
  };
}
