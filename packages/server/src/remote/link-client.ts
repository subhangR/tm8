/**
 * W9c: the HOME server's client for the target's server-to-server routes
 * (`REMOTE_SPACE_LINK_PATHS`). Every call goes through `guardedHttpsRequest`
 * (HTTPS only, public addresses only, no redirects, header allow-list, capped
 * body), except ONE operator opt-in for development:
 * `TM8_REMOTE_SPACE_LINKS_ALLOW_LOOPBACK=1` lets a base URL that is plain
 * http(s) on a loopback literal be reached directly, so two servers on one
 * machine can link. The guard itself is not changed or bypassed for any other
 * address: a non-loopback URL takes the guarded path whatever the switch says.
 */
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';

import {
  GUARDED_CONNECT_TIMEOUT_MS,
  GUARDED_MAX_RESPONSE_BYTES,
  GUARDED_TOTAL_TIMEOUT_MS,
  guardedHttpsRequest,
  type GuardedHttpsOptions,
  type GuardedResult,
} from './guarded-https.js';

export interface RemoteLinkClientOptions {
  /** Dev only: reach a loopback http(s) base URL directly. */
  allowLoopback?: boolean;
  /** Tests only: the guard's resolver and transport. */
  https?: GuardedHttpsOptions;
  timeoutMs?: number;
}

export interface RemoteLinkPost {
  baseUrl: string;
  path: string;
  body: unknown;
  /** The link session, sent as `authorization: Bearer`. Never logged. */
  bearer?: string;
  via?: readonly string[];
  timeoutMs?: number;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export function isLoopbackBaseUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOSTS.has(url.hostname)
      && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

/** Resolve `path` against the server's base URL, keeping any base path prefix. */
export function remoteLinkUrl(baseUrl: string, path: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}${path}`;
}

export async function postRemoteLink(request: RemoteLinkPost, options: RemoteLinkClientOptions = {}): Promise<GuardedResult> {
  const url = remoteLinkUrl(request.baseUrl, request.path);
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
    'user-agent': 'tm8-remote-space-link/1',
  };
  if (request.bearer) headers['authorization'] = `Bearer ${request.bearer}`;
  if (request.via && request.via.length > 0) headers['x-tm8-via'] = request.via.join(',');
  const body = JSON.stringify(request.body ?? {});
  const timeoutMs = request.timeoutMs ?? options.timeoutMs ?? GUARDED_TOTAL_TIMEOUT_MS;
  if (options.allowLoopback && isLoopbackBaseUrl(request.baseUrl)) {
    return loopbackPost(url, headers, body, timeoutMs);
  }
  return guardedHttpsRequest({ url, method: 'POST', headers, body, timeoutMs }, options.https ?? {});
}

/** The dev path: same result shape, timeouts and body cap as the guarded client. */
function loopbackPost(raw: string, headers: Record<string, string>, body: string, timeoutMs: number): Promise<GuardedResult> {
  const url = new URL(raw);
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<GuardedResult>((resolveResult) => {
    let settled = false;
    let connected = false;
    const settle = (result: GuardedResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(totalTimer);
      req.destroy();
      resolveResult(result);
    };
    const req = send({
      hostname: url.hostname.replace(/^\[|\]$/g, ''),
      port: url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) },
      agent: false,
    });
    const connectTimer = setTimeout(() => {
      if (!connected) settle({ kind: 'offline', reason: 'timeout' });
    }, Math.min(timeoutMs, GUARDED_CONNECT_TIMEOUT_MS));
    const totalTimer = setTimeout(() => settle({ kind: 'offline', reason: 'timeout' }), timeoutMs);
    req.on('socket', (socket) => socket.once('connect', () => { connected = true; }));
    req.on('error', (error) => {
      const code = (error as { code?: string }).code;
      settle(code === 'ECONNRESET' || code === 'EPIPE' ? { kind: 'offline', reason: 'reset' }
        : code === 'ETIMEDOUT' ? { kind: 'offline', reason: 'timeout' }
          : { kind: 'offline', reason: 'connect_refused' });
    });
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
      res.on('error', () => settle({ kind: 'offline', reason: 'reset' }));
      res.on('end', () => settle({
        kind: 'response',
        status: res.statusCode ?? 0,
        contentType: String(res.headers['content-type'] ?? ''),
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.end(body);
  });
}

/** The error envelope of a non-2xx answer, if it is one of ours. */
export function errorEnvelopeOf(body: string): { code: string; message: string } | null {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown; message?: unknown } };
    const code = parsed.error?.code;
    const message = parsed.error?.message;
    if (typeof code === 'string') return { code, message: typeof message === 'string' ? message.slice(0, 500) : code };
  } catch {
    // not JSON
  }
  return null;
}

/** The `data` of a 2xx envelope (`{ data }`), or the body itself. */
export function dataOf(body: string): unknown {
  const parsed = JSON.parse(body) as unknown;
  if (typeof parsed === 'object' && parsed !== null && 'data' in parsed) return (parsed as { data: unknown }).data;
  return parsed;
}
