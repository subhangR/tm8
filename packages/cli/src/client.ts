/**
 * The HTTP seam — a catalog-driven binding, cribbed from
 * `tools/conformance/src/client.ts` on purpose.
 *
 * Every path comes from `bindPath(<operationName>, params)`. There is not one
 * hand-written URL string in this package, and there must never be: the closed
 * operation catalog (T-L12) exists so that CLI, UI and MCP are *projections*
 * of one list rather than three drifting copies of it. A typo'd literal here
 * would be a 404 the catalog was specifically designed to make impossible.
 *
 * Envelope handling follows DEV-6 (`{data, requestId}` on success) and DEV-8
 * (`{error:{code,message,requestId,retryable,details?}}` on failure).
 */
import {
  bindPath,
  getOperation,
  WireErrorBodySchema,
  type CommandErrorCode,
  type OperationName,
} from '@tm8/contract';
import { EXIT_REFUSED, EXIT_UNAVAILABLE } from './exit.js';

/** A typed failure carrying the server's own taxonomy code. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: CommandErrorCode,
    message: string,
    readonly requestId: string,
    readonly retryable: boolean,
    readonly details: unknown,
    /** The body failed WireErrorBodySchema — the server drifted off DEV-8. */
    readonly malformedBody: boolean,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /**
   * `not_implemented` is not a refusal — it is a handler that does not exist
   * yet (DEV-13). During G1A that distinction is the whole story, so it maps
   * to UNAVAILABLE alongside transport failures rather than to REFUSED.
   */
  get exitCode(): number {
    return this.code === 'not_implemented' || this.code === 'upstream_unavailable'
      ? EXIT_UNAVAILABLE
      : EXIT_REFUSED;
  }
}

/** The server was not reachable at all (DNS, ECONNREFUSED, abort, non-JSON). */
export class TransportError extends Error {
  readonly exitCode = EXIT_UNAVAILABLE;
  constructor(message: string) {
    super(message);
    this.name = 'TransportError';
  }
}

export interface ClientOptions {
  baseUrl: string;
  token?: string | undefined;
  /** Per-request timeout. A booting agent must not hang on a dead server. */
  timeoutMs?: number;
}

export interface InvokeOptions {
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
}

export class Tm8Client {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly timeoutMs: number;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl;
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  /** Invoke a catalog operation by NAME. The only way out of this package. */
  async invoke<T = unknown>(name: OperationName, opts: InvokeOptions = {}): Promise<T> {
    const op = getOperation(name);
    if (op.method === 'WS') {
      throw new TransportError(`operation ${name} is a stream; the CLI has no WS client`);
    }

    const url = new URL(bindPath(name, opts.params ?? {}), this.baseUrl);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);

    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method: op.method,
        headers,
        signal: controller.signal,
        ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new TransportError(`${op.method} ${url.pathname} failed: ${reason} (is tm8-server running at ${this.baseUrl}?)`);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = undefined;
    }

    if (res.status >= 400) throw toApiError(res.status, parsed);

    const envelope = parsed as { data?: unknown } | undefined;
    if (!envelope || typeof envelope !== 'object' || !('data' in envelope)) {
      throw new TransportError(
        `${op.method} ${url.pathname} answered ${res.status} without a {data, requestId} envelope (DEV-6)`,
      );
    }
    return envelope.data as T;
  }
}

function toApiError(status: number, body: unknown): ApiError {
  const parsed = WireErrorBodySchema.safeParse(body);
  if (parsed.success) {
    const { code, message, requestId, retryable, details } = parsed.data.error;
    return new ApiError(status, code, message, requestId, retryable, details, false);
  }
  return new ApiError(
    status,
    status >= 500 ? 'upstream_unavailable' : 'invalid_input',
    `server answered ${status} with a body that is not a contract error (DEV-8)`,
    '',
    false,
    body,
    true,
  );
}
