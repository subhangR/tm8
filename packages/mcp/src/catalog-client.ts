/**
 * The MCP transport's only route to tm8.
 *
 * Operation names, methods and paths come from the closed catalog. The MCP
 * layer owns only curation: it never hand-writes a facade URL and it never
 * becomes a second API. The bearer token is deliberately private state; no
 * error or result includes headers, request options, or the token value.
 */
import { bindPath, getOperation, type OperationName } from '@tm8/contract';

export type QueryValue = string | readonly string[] | undefined;

export interface CatalogInvokeOptions {
  params?: Readonly<Record<string, string>>;
  query?: Readonly<Record<string, QueryValue>>;
  body?: unknown;
}

export interface CatalogTransport {
  invoke(operation: OperationName, options?: CatalogInvokeOptions): Promise<unknown>;
}

export interface HttpCatalogClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class CatalogHttpError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly details: unknown;

  constructor(input: {
    code: string;
    message: string;
    status: number;
    retryable?: boolean;
    details?: unknown;
  }) {
    super(input.message);
    this.name = 'CatalogHttpError';
    this.code = input.code;
    this.status = input.status;
    this.retryable = input.retryable ?? false;
    this.details = input.details;
  }
}

const DEFAULT_TIMEOUT_MS = 15_000;
/**
 * Operations whose server-side work outlives the default deadline: the same floors as the UI's and the
 * CLI's SLOW_OPERATION_TIMEOUT_MS. execution.spawn, execution.resume and a loop's Run now (a spawn) answer
 * only once the session's first turn has settled (up to ~150 s). At 15 s an agent was told the call was
 * unavailable while the session kept booting, and its retry, with a fresh id, started a second one.
 * Floors on the DEFAULT only: an explicit `timeoutMs` wins.
 */
export const SLOW_OPERATION_TIMEOUT_MS: Readonly<Partial<Record<OperationName, number>>> = {
  'execution.spawn': 180_000,
  'execution.resume': 180_000,
  'loops.runNow': 180_000,
};

export class HttpCatalogClient implements CatalogTransport {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly timeoutExplicit: boolean;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpCatalogClientOptions) {
    this.baseUrl = options.baseUrl;
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.timeoutExplicit = options.timeoutMs !== undefined;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async invoke(operation: OperationName, options: CatalogInvokeOptions = {}): Promise<unknown> {
    const binding = getOperation(operation);
    if (binding.method === 'WS') {
      throw new CatalogHttpError({
        code: 'invalid_input',
        message: `${operation} is a stream and cannot be invoked as an MCP tool call`,
        status: 400,
      });
    }

    const url = new URL(bindPath(operation, { ...(options.params ?? {}) }), this.baseUrl);
    for (const [key, raw] of Object.entries(options.query ?? {})) {
      if (raw === undefined) continue;
      for (const value of Array.isArray(raw) ? raw : [raw as string]) {
        url.searchParams.append(key, value);
      }
    }

    // One deadline for the headers AND the body: clearing it once the headers
    // arrived left a stalled body to hang the tool call with no bound at all.
    const controller = new AbortController();
    const deadline = this.timeoutExplicit ? this.timeoutMs : Math.max(this.timeoutMs, SLOW_OPERATION_TIMEOUT_MS[operation] ?? 0);
    const timer = setTimeout(() => controller.abort(), deadline);
    const unavailable = (error: unknown): CatalogHttpError => new CatalogHttpError({
      code: 'upstream_unavailable',
      message: `${binding.method} ${url.pathname} failed: ${error instanceof Error ? error.message : String(error)}`,
      status: 503,
      retryable: true,
    });
    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(url, {
        method: binding.method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.token}`,
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        signal: controller.signal,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
      text = await response.text();
    } catch (error) {
      throw unavailable(error);
    } finally {
      clearTimeout(timer);
    }

    let payload: unknown;
    try {
      payload = text === '' ? undefined : JSON.parse(text);
    } catch {
      throw new CatalogHttpError({
        code: 'protocol_error',
        message: `${binding.method} ${url.pathname} returned non-JSON`,
        status: response.status,
      });
    }

    if (!response.ok) {
      const wire = payload as {
        error?: { code?: unknown; message?: unknown; retryable?: unknown; details?: unknown };
      } | null;
      throw new CatalogHttpError({
        code: typeof wire?.error?.code === 'string' ? wire.error.code : 'upstream_error',
        message:
          typeof wire?.error?.message === 'string'
            ? wire.error.message
            : `${binding.method} ${url.pathname} returned ${response.status}`,
        status: response.status,
        retryable: wire?.error?.retryable === true,
        details: wire?.error?.details,
      });
    }

    const envelope = payload as { data?: unknown } | null;
    if (!envelope || typeof envelope !== 'object' || !('data' in envelope)) {
      throw new CatalogHttpError({
        code: 'protocol_error',
        message: `${binding.method} ${url.pathname} returned no {data} envelope`,
        status: response.status,
      });
    }
    return envelope.data;
  }
}
