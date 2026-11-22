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

/**
 * Deadline includes token acquisition, response headers, and the complete bounded body.
 *
 * Responses can carry key material (KMS decrypt) or credentials (the metadata token), so the body is
 * kept in as few copies as the runtime allows (review F05). `identity` stops the runtime from
 * decompressing through zlib buffers we cannot wipe. Each stream chunk is already a fresh copy that
 * we own (test/gcp/body-chunks.test.ts pins that for the runtime in use), so it is used in place and
 * every chunk not returned is wiped, on every path. The caller owns `bytes` and wipes it once parsed.
 * Copies inside the runtime (socket, TLS and parser buffers) are out of reach; the host controls
 * against core dumps and swap cover those.
 */
export async function request(options: {
  url: string;
  method: 'GET' | 'POST';
  timeoutMs: number;
  tokens?: TokenSource;
  headers?: Record<string, string>;
  body?: string | Buffer<ArrayBuffer>;
}): Promise<GcpResponse> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new GcpTransportError()); }, options.timeoutMs);
    });
    const work = async (): Promise<GcpResponse> => {
      const headers = new Headers(options.headers);
      headers.set('Accept-Encoding', 'identity');
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
      try {
        if (response.body) {
          for await (const chunk of response.body) {
            chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
            size += chunk.byteLength;
            if (size > 1_048_576) { controller.abort(); throw new GcpTransportError(); }
          }
        }
        const bytes = chunks.length === 1 ? chunks.pop()! : Buffer.concat(chunks, size);
        return { status: response.status, headers: response.headers, bytes };
      } finally {
        for (const chunk of chunks) chunk.fill(0);
      }
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

/**
 * Strict standard base64. The final group must be canonical (its unused low bits zero), so each
 * accepted string decodes to exactly one byte string and back. That is checked on the text, never by
 * re-encoding the decoded bytes: for a KMS decrypt, those bytes are the DEK (review F05).
 */
export function decodeBase64(value: unknown): Buffer {
  if (typeof value !== 'string'
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$/.test(value)) {
    throw new GcpTransportError();
  }
  return Buffer.from(value, 'base64');
}

/** The characters from `first` to `last`, in code order. */
function charRange(first: string, last: string): string {
  const start = first.charCodeAt(0);
  return String.fromCharCode(...Array.from({ length: last.charCodeAt(0) - start + 1 }, (_, i) => start + i));
}

const BASE64_ALPHABET = Buffer.from(`${charRange('A', 'Z')}${charRange('a', 'z')}${charRange('0', '9')}+/`, 'latin1');

/** Standard padded base64 of `input`, written into a buffer the caller wipes: no string copy exists (review F05). */
export function encodeBase64Bytes(input: Buffer): Buffer {
  const output = Buffer.alloc(Math.ceil(input.length / 3) * 4);
  let at = 0;
  for (let i = 0; i < input.length; i += 3) {
    const a = input[i]!;
    const b = i + 1 < input.length ? input[i + 1]! : -1;
    const c = i + 2 < input.length ? input[i + 2]! : -1;
    output[at++] = BASE64_ALPHABET[a >> 2]!;
    output[at++] = BASE64_ALPHABET[((a & 3) << 4) | (b < 0 ? 0 : b >> 4)]!;
    output[at++] = b < 0 ? 0x3d : BASE64_ALPHABET[((b & 15) << 2) | (c < 0 ? 0 : c >> 6)]!;
    output[at++] = c < 0 ? 0x3d : BASE64_ALPHABET[c & 63]!;
  }
  return output;
}
