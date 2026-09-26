/**
 * THE OUTBOUND CLIENT for remote servers (W8, T27). Every byte tm8 sends to
 * another server goes through `guardedHttpsRequest`.
 *
 *   - HTTPS only. No `http:`, no embedded credentials.
 *   - SSRF guard: the host is resolved ONCE by `resolvePublicAddresses` (the
 *     same list `web_fetch` uses, @tm8/mcp outbound-guard.ts) and the socket is
 *     pinned to the first checked address, so DNS rebinding cannot swap in a
 *     private one after the check. A loopback-only or private target is
 *     `unreachable` and nothing is sent.
 *   - No redirects: a 3xx is returned as a response, never followed.
 *   - A fixed header allow-list; the response body is capped.
 *   - A down target is `offline` inside the budget: a connect timeout and a
 *     whole-request timeout, both bounded by `timeoutMs`.
 *
 * `transport` and `resolve` are injectable for tests only: the guard itself
 * (protocol, credentials, address policy) is not.
 */
import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { LookupFunction } from 'node:net';

import { OutboundGuardError, resolvePublicAddresses, type HostResolver } from '@tm8/mcp';

export const GUARDED_CONNECT_TIMEOUT_MS = 3_000;
export const GUARDED_TOTAL_TIMEOUT_MS = 10_000;
export const GUARDED_MAX_RESPONSE_BYTES = 1024 * 1024;

/** The only request headers that ever leave this node. */
const ALLOWED_HEADERS: ReadonlySet<string> = new Set([
  'accept', 'authorization', 'content-type', 'user-agent', 'x-tm8-via',
]);

export interface GuardedRequest {
  url: string;
  method: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: string;
  /** Whole-request budget; the connect timeout is the smaller of this and 3s. */
  timeoutMs?: number;
}

export type GuardedResult =
  | { kind: 'response'; status: number; contentType: string; body: string }
  | { kind: 'unreachable'; reason: 'non_public_address' | 'invalid_url' | 'dns' | 'tls' }
  | { kind: 'offline'; reason: 'connect_refused' | 'timeout' | 'reset' };

export type HttpsTransport = (options: RequestOptions) => ClientRequest;

export interface GuardedHttpsOptions {
  resolve?: HostResolver;
  transport?: HttpsTransport;
}

const TLS_CODES = new Set([
  'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID',
]);

function failureOf(error: unknown): GuardedResult {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === 'string') {
    if (TLS_CODES.has(code) || code.startsWith('ERR_TLS_') || code.startsWith('ERR_SSL_')) {
      return { kind: 'unreachable', reason: 'tls' };
    }
    if (code === 'ECONNRESET' || code === 'EPIPE') return { kind: 'offline', reason: 'reset' };
    if (code === 'ETIMEDOUT') return { kind: 'offline', reason: 'timeout' };
  }
  return { kind: 'offline', reason: 'connect_refused' };
}

export async function guardedHttpsRequest(
  input: GuardedRequest,
  options: GuardedHttpsOptions = {},
): Promise<GuardedResult> {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return { kind: 'unreachable', reason: 'invalid_url' };
  }
  let pinned;
  try {
    [pinned] = await resolvePublicAddresses(url, {
      protocols: ['https:'],
      ...(options.resolve ? { resolve: options.resolve } : {}),
    });
  } catch (error) {
    if (error instanceof OutboundGuardError) {
      return {
        kind: 'unreachable',
        reason: error.reason === 'non_public' ? 'non_public_address' : error.reason,
      };
    }
    throw error;
  }
  if (!pinned) return { kind: 'unreachable', reason: 'dns' };
  const address = pinned;

  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    if (ALLOWED_HEADERS.has(name.toLowerCase())) headers[name.toLowerCase()] = value;
  }
  if (input.body !== undefined) headers['content-length'] = String(Buffer.byteLength(input.body));

  const total = Math.max(1, input.timeoutMs ?? GUARDED_TOTAL_TIMEOUT_MS);
  const connectBudget = Math.min(total, GUARDED_CONNECT_TIMEOUT_MS);
  const lookup: LookupFunction = (_hostname, lookupOptions, callback) => {
    if (typeof lookupOptions === 'object' && lookupOptions?.all) {
      (callback as unknown as (e: null, a: typeof address[]) => void)(null, [address]);
    } else {
      callback(null, address.address, address.family);
    }
  };
  const transport = options.transport ?? httpsRequest;

  return await new Promise<GuardedResult>((resolveResult) => {
    let settled = false;
    let connected = false;
    let req: ClientRequest | undefined;
    const settle = (result: GuardedResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(totalTimer);
      req?.destroy();
      resolveResult(result);
    };
    const connectTimer = setTimeout(() => {
      if (!connected) settle({ kind: 'offline', reason: 'timeout' });
    }, connectBudget);
    const totalTimer = setTimeout(() => settle({ kind: 'offline', reason: 'timeout' }), total);

    try {
      req = transport({
        protocol: 'https:',
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        servername: url.hostname,
        port: url.port ? Number(url.port) : 443,
        path: `${url.pathname}${url.search}`,
        method: input.method,
        headers,
        lookup,
        agent: false,
      });
    } catch (error) {
      settle(failureOf(error));
      return;
    }
    req.on('socket', (socket) => {
      socket.once('secureConnect', () => { connected = true; });
      socket.once('connect', () => { connected = true; });
    });
    req.on('error', (error) => settle(failureOf(error)));
    req.on('response', (res: IncomingMessage) => {
      connected = true;
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > GUARDED_MAX_RESPONSE_BYTES) {
          settle({ kind: 'offline', reason: 'reset' });
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', (error) => settle(failureOf(error)));
      res.on('end', () => settle({
        kind: 'response',
        status: res.statusCode ?? 0,
        contentType: String(res.headers['content-type'] ?? ''),
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.end(input.body);
  });
}
