import { request as httpsRequest } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { LookupFunction } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import type { Readable } from 'node:stream';
import type { ResolvedAddress } from '@tm8/integrations';
import { EgressRefusal, type HttpMethod } from '../types.js';

/** Already validated by the executor. This seam is NOT a policy bypass. */
export interface PinnedHttpsRequest {
  url: URL;
  address: ResolvedAddress;
  method: HttpMethod;
  headers: Readonly<Record<string, string>>;
  body?: Buffer;
  connectTimeoutMs: number;
  totalTimeoutMs: number;
  signal: AbortSignal;
}

export interface PinnedHttpsResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  /** Wire bytes. The executor caps the decoded stream, not this stream. */
  body: Readable;
  /** Must stop the socket/stream and release timers; idempotent. */
  close(): void;
}

export type EgressTransport = (input: PinnedHttpsRequest) => Promise<PinnedHttpsResponse>;

function networkFailure(error: unknown): EgressRefusal {
  if (error instanceof EgressRefusal) return error;
  const code = (error as { code?: unknown } | null)?.code;
  return new EgressRefusal(code === 'ETIMEDOUT' || code === 'ABORT_ERR' ? 'timeout' : 'upstream_unreachable');
}

/**
 * Direct HTTPS only, with a lookup that returns the checked address exclusively.
 * A custom CA is accepted only here so the real transport can be tested against
 * a local TLS server. It adds trust anchors; verification cannot be disabled.
 * Executor options deliberately do not expose this test seam or a port bypass.
 */
export function nodeHttpsTransport(
  input: PinnedHttpsRequest,
  trust?: { ca: string | Buffer | (string | Buffer)[] },
): Promise<PinnedHttpsResponse> {
  return new Promise((resolve, reject) => {
    let req: ClientRequest | undefined;
    let response: IncomingMessage | undefined;
    let delivered = false;
    let stopped = false;
    const lookup: LookupFunction = (_hostname, options, callback) => {
      const address = { address: input.address.address, family: input.address.family };
      if (typeof options === 'object' && options?.all) {
        (callback as unknown as (error: null, addresses: ResolvedAddress[]) => void)(null, [address]);
      } else callback(null, address.address, address.family);
    };
    const cleanup = () => {
      clearTimeout(connectTimer); clearTimeout(totalTimer);
      input.signal.removeEventListener('abort', onAbort);
    };
    const close = () => {
      if (stopped) return;
      stopped = true; cleanup(); response?.destroy(); req?.destroy();
    };
    const fail = (error: unknown) => {
      if (stopped) return;
      const refusal = networkFailure(error);
      if (delivered) response?.destroy(refusal);
      else reject(refusal);
      close();
    };
    const onAbort = () => fail(new EgressRefusal('timeout'));
    const connectTimer = setTimeout(onAbort, input.connectTimeoutMs);
    const totalTimer = setTimeout(onAbort, input.totalTimeoutMs);
    input.signal.addEventListener('abort', onAbort, { once: true });
    if (input.signal.aborted) { onAbort(); return; }
    try {
      req = httpsRequest({
        protocol: 'https:', hostname: input.url.hostname, servername: input.url.hostname,
        port: input.url.port ? Number(input.url.port) : 443,
        path: `${input.url.pathname}${input.url.search}`, method: input.method, headers: input.headers,
        lookup, family: input.address.family, agent: false,
        rejectUnauthorized: true, checkServerIdentity,
        ...(trust ? { ca: trust.ca } : {}),
      });
      req.once('socket', (socket) => socket.once('secureConnect', () => clearTimeout(connectTimer)));
      req.on('error', fail);
      req.once('response', (res) => {
        if (stopped) { res.destroy(); return; }
        response = res; delivered = true; clearTimeout(connectTimer);
        res.once('end', cleanup);
        res.once('close', cleanup);
        // An error may happen between delivery and the consumer attaching its
        // iterator. Keep a listener so that it cannot become an uncaught error.
        res.on('error', () => {});
        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(res.headers)) {
          if (value !== undefined) headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
        }
        resolve({ status: res.statusCode ?? 0, headers, body: res, close });
      });
      req.end(input.body);
    } catch (error) { fail(error); }
  });
}
