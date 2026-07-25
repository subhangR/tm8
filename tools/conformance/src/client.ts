/**
 * Conformance HTTP client — a thin, catalog-driven binding. It never invents
 * semantics (L4): paths come from the contract's operation catalog, envelopes
 * are unwrapped per DEV-6, and error bodies become CollabError-shaped
 * rejections asserted against the DEV-8 taxonomy.
 */
import {
  bindPath, CollabError, WireErrorBodySchema,
  type CommandErrorCode, type OperationName,
} from '@tm8/contract';

export const BASE_URL =
  process.env.TM8_CONFORMANCE_BASE_URL ?? 'http://localhost:4610';

export interface RawResponse {
  status: number;
  headers: Headers;
  /** Parsed JSON body, or undefined when the body is not JSON. */
  body: unknown;
}

export async function rawRequest(
  method: string,
  path: string,
  body?: unknown,
  opts: { query?: Record<string, string>; rawBody?: string } = {},
): Promise<RawResponse> {
  const url = new URL(path, BASE_URL);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: opts.rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  let parsed: unknown;
  const text = await res.text();
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }
  return { status: res.status, headers: res.headers, body: parsed };
}

/** A conformance-side view of a wire error (shape-checked before use). */
export class WireError extends Error {
  constructor(
    readonly status: number,
    readonly code: CommandErrorCode,
    message: string,
    readonly requestId: string,
    readonly retryable: boolean,
    readonly details: unknown,
    /** True when the body failed WireErrorBodySchema — taxonomy drift. */
    readonly malformedBody: boolean,
    readonly rawBody: unknown,
  ) {
    super(message);
    this.name = 'WireError';
  }
}

export function isWireError(e: unknown): e is WireError {
  return e instanceof WireError;
}

function toWireError(res: RawResponse): WireError {
  const parsed = WireErrorBodySchema.safeParse(res.body);
  if (parsed.success) {
    const { code, message, requestId, retryable, details } = parsed.data.error;
    return new WireError(res.status, code, message, requestId, retryable, details, false, res.body);
  }
  return new WireError(res.status, 'upstream_unavailable', `malformed error body (status ${res.status})`,
    '', false, undefined, true, res.body);
}

async function invoke(
  name: OperationName,
  opts: { params?: Record<string, string>; body?: unknown; query?: Record<string, string> } = {},
): Promise<unknown> {
  const { getOperation } = await import('@tm8/contract');
  const op = getOperation(name);
  if (op.method === 'WS') throw new Error(`operation ${name} is a stream; use a WS client`);
  const res = await rawRequest(op.method, bindPath(name, opts.params), opts.body, { query: opts.query });
  if (res.status >= 400) throw toWireError(res);
  const envelope = res.body as { data?: unknown; requestId?: unknown } | undefined;
  if (!envelope || typeof envelope !== 'object' || !('data' in envelope)) {
    throw new WireError(res.status, 'upstream_unavailable',
      `response missing {data, requestId} envelope (DEV-6)`, '', false, undefined, true, res.body);
  }
  return envelope.data;
}

export const api = {
  raw: rawRequest,
  invoke,
  read: (name: OperationName, params?: Record<string, string>, query?: Record<string, string>) =>
    invoke(name, { params, query }),
  command: (name: OperationName, body: unknown, params?: Record<string, string>) =>
    invoke(name, { params, body }),
};

/** Assert helper: run `p`, expect a WireError with `code` (returns it). */
export async function expectError(p: Promise<unknown>, code: CommandErrorCode): Promise<WireError> {
  try {
    await p;
  } catch (e) {
    if (isWireError(e)) {
      if (e.malformedBody) {
        throw new Error(`expected ${code} with a contract error body, got malformed body: ${JSON.stringify(e.rawBody)}`);
      }
      if (e.code !== code) {
        throw new Error(`expected error code ${code}, got ${e.code} (status ${e.status}): ${e.message}`);
      }
      return e;
    }
    throw e;
  }
  throw new Error(`expected ${code}, but the call succeeded`);
}

export { CollabError };
