import type { TokenSource } from './token.js';

/** No cause, response, request, URL or headers may escape through an error. */
export class GcpTransportError extends Error {
  constructor() { super('GCP request unavailable'); this.name = 'GcpTransportError'; }
}

export interface GcpResponse {
  status: number;
  headers: Headers;
  bytes: Buffer;
}

export function baseUrl(value: string): string {
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new GcpTransportError();
    }
    // Plain HTTP is for metadata and explicit loopback fakes only.
    if (url.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost', 'metadata.google.internal', '169.254.169.254'].includes(url.hostname)) {
      throw new GcpTransportError();
    }
    return url.origin;
  } catch { throw new GcpTransportError(); }
}

export function timeoutMs(value: number | undefined): number {
  const result = value ?? 5_000;
  if (!Number.isInteger(result) || result < 1 || result > 2_147_483_647) throw new GcpTransportError();
  return result;
}

/** Deadline includes token acquisition, response headers, and the complete bounded body. */
export async function request(options: {
  url: string;
  method: 'GET' | 'POST';
  timeoutMs: number;
  tokens?: TokenSource;
  headers?: Record<string, string>;
  body?: string;
}): Promise<GcpResponse> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new GcpTransportError()); }, options.timeoutMs);
    });
    const work = async (): Promise<GcpResponse> => {
      const headers = new Headers(options.headers);
      if (options.tokens) {
        const token = await options.tokens.getAccessToken();
        if (typeof token !== 'string' || !token || /\s/.test(token)) throw new GcpTransportError();
        headers.set('Authorization', `Bearer ${token}`);
      }
      // A token source can finish after the deadline; it must never start a late request.
      if (controller.signal.aborted) throw new GcpTransportError();
      const response = await fetch(options.url, {
        method: options.method, headers, body: options.body,
        redirect: 'error', signal: controller.signal,
      });
      // Error bodies are unnecessary and can contain credentials. Preserve the HTTP
      // status even if that body is malformed, oversized, or never completes.
      if (response.status < 200 || response.status >= 300) {
        void response.body?.cancel().catch(() => {});
        return { status: response.status, headers: response.headers, bytes: Buffer.alloc(0) };
      }
      const chunks: Buffer[] = [];
      let size = 0;
      if (response.body) {
        for await (const chunk of response.body) {
          size += chunk.byteLength;
          if (size > 1_048_576) { controller.abort(); throw new GcpTransportError(); }
          chunks.push(Buffer.from(chunk));
        }
      }
      return { status: response.status, headers: response.headers, bytes: Buffer.concat(chunks) };
    };
    return await Promise.race([work(), deadline]);
  } catch { throw new GcpTransportError(); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

export function jsonObject(bytes: Buffer): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GcpTransportError();
    return value as Record<string, unknown>;
  } catch { throw new GcpTransportError(); }
}

export function decodeBase64(value: unknown): Buffer {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new GcpTransportError();
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new GcpTransportError();
  return bytes;
}
