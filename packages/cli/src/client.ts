/**
 * The HTTP seam — a catalog-driven binding.
 *
 * Every path comes from `bindPath(<operationName>, params)`. There is not one
 * hand-written URL string in this package, and there must never be: the closed
 * operation catalog (T-L12) exists so that CLI, UI and MCP are *projections*
 * of one list rather than three drifting copies of it. A typo'd literal here
 * would be a 404 the catalog was specifically designed to make impossible.
 *
 * Three response shapes exist in the catalog and conflating them is how a CLI
 * corrupts a download or swallows an error:
 *
 *   envelope — `{data, requestId}` on success (DEV-6),
 *              `{error:{code,message,requestId,retryable,details?}}` on failure (DEV-8);
 *   bytes    — `files.download` and `bridge.fetchBlob` answer with the blob
 *              itself. This is the DOCUMENTED exception, not drift, and it is
 *              still a DEV-8 JSON body when it fails;
 *   stream   — `events.subscribe` is WS. Reaching it through this client is a
 *              usage error, never an HTTP attempt against a socket path.
 *
 * `201` (`entities.create`) and `202` (`tracking.refresh`) are successes. The
 * client accepts any 2xx: a status-code allowlist would turn a Server that
 * legitimately answers 200-instead-of-201 into a CLI failure.
 */
import {
  bindPath,
  getOperation,
  WireErrorBodySchema,
  type OperationName,
} from '@tm8/contract';
import {
  ApiError,
  ProtocolError,
  StreamOperationError,
  TransportError,
} from './errors.js';
import { CliError, EXIT_USAGE } from './exit.js';
import { journal } from './journal.js';
import { readCache, type CacheEntry, type ReadCache } from './read-cache.js';

export type ResponseMode = 'envelope' | 'bytes' | 'stream';

/**
 * Operations whose success body is raw bytes rather than the JSON envelope.
 * Closed and explicit: a new blob route must be added here deliberately, and
 * the exhaustiveness test proves every catalog row lands in exactly one mode.
 */
const BYTES_OPERATIONS: ReadonlySet<string> = new Set<OperationName>([
  'files.download',
  'bridge.fetchBlob',
  // `artifacts.export` answers a deterministic `application/zip` bundle from the
  // privileged origin (TM8-ARTIFACTS-DESIGN §9.6): raw bytes, never the JSON
  // envelope. It joins the closed bytes set so `artifact export` reads it
  // through `download()` and never utf8-decodes a blob.
  'artifacts.export',
]);

export function responseMode(name: OperationName): ResponseMode {
  if (getOperation(name).method === 'WS') return 'stream';
  return BYTES_OPERATIONS.has(name) ? 'bytes' : 'envelope';
}

/** The `:params` a path needs, read off the catalog rather than hand-listed. */
export function pathParamNames(name: OperationName): string[] {
  return [...getOperation(name).path.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1] as string);
}

export interface ClientOptions {
  baseUrl: string;
  /**
   * Phase-1 identity is a database-resolved loopback auto-owner; there is no
   * bearer auth. This is carried when set only because it is the reserved
   * Phase-2 transport seam.
   */
  token?: string | undefined;
  /** Per-request timeout. A booting agent must not hang on a dead Server. */
  timeoutMs?: number | undefined;
  fetchImpl?: typeof fetch;
  /** `--fresh`: skip the read-cache LOOKUP. The result is still stored. */
  fresh?: boolean | undefined;
  /** Injectable for tests; defaults to the session singleton (read-cache.ts). */
  cache?: ReadCache;
}

export interface InvokeOptions {
  params?: Record<string, string>;
  /** Repeated query values are emitted as repeated keys, never joined. */
  query?: Record<string, string | readonly string[] | undefined>;
  body?: unknown;
  timeoutMs?: number | undefined;
}

export interface InvokeResult<T> {
  data: T;
  requestId: string;
  status: number;
}

export interface BytesResult {
  bytes: Uint8Array;
  contentType: string | undefined;
  requestId: string;
  status: number;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export class Tm8Client {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly fresh: boolean;
  private readonly cache: ReadCache;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl;
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.fresh = opts.fresh ?? false;
    this.cache = opts.cache ?? readCache;
  }

  /** Invoke a catalog operation by NAME. The only way out of this package. */
  async invoke<T = unknown>(name: OperationName, opts: InvokeOptions = {}): Promise<T> {
    return (await this.invokeDetailed<T>(name, opts)).data;
  }

  /** Same, keeping the requestId and status a caller may need to render. */
  async invokeDetailed<T = unknown>(
    name: OperationName,
    opts: InvokeOptions = {},
  ): Promise<InvokeResult<T>> {
    const mode = responseMode(name);
    if (mode === 'stream') throw new StreamOperationError(name);
    if (mode === 'bytes') {
      throw new CliError(
        `operation ${name} answers with raw bytes; use the client's download() path`,
        EXIT_USAGE,
      );
    }

    const { res, url, method, text } = await this.send(name, opts);
    const requestId = res.headers.get('x-tm8-request-id') ?? '';

    let parsed: unknown;
    try {
      parsed = text ? (JSON.parse(text) as unknown) : undefined;
    } catch {
      parsed = undefined;
    }

    if (res.status >= 400) throw toWireError(res.status, parsed, text, name);

    // 204/205 carry no body by definition; anything else must be an envelope.
    if (res.status === 204 || res.status === 205) {
      return { data: undefined as T, requestId, status: res.status };
    }

    const envelope = parsed as { data?: unknown; requestId?: unknown } | undefined;
    if (!envelope || typeof envelope !== 'object' || !('data' in envelope)) {
      throw new ProtocolError(
        `${method} ${url.pathname} answered ${res.status} without a {data, requestId} envelope (DEV-6)`,
        res.status,
        parsed ?? text,
      );
    }
    return {
      data: envelope.data as T,
      requestId: typeof envelope.requestId === 'string' ? envelope.requestId : requestId,
      status: res.status,
    };
  }

  /**
   * The raw-bytes path. Separate from `invoke` on purpose: a blob must never
   * reach the JSON parser, and structured output must never reach a blob's
   * destination (§7.3).
   */
  async download(name: OperationName, opts: InvokeOptions = {}): Promise<BytesResult> {
    const mode = responseMode(name);
    if (mode === 'stream') throw new StreamOperationError(name);
    if (mode !== 'bytes') {
      throw new CliError(
        `operation ${name} answers with the JSON envelope, not bytes; use invoke()`,
        EXIT_USAGE,
      );
    }

    const { res, text } = await this.send(name, opts, 'bytes');
    const requestId = res.headers.get('x-tm8-request-id') ?? '';
    if (res.status >= 400) {
      // A failed blob read is still a DEV-8 JSON body — `bridge.fetchBlob` is
      // reserved and answers an honest 501 exactly this way.
      let parsed: unknown;
      try {
        parsed = text ? (JSON.parse(text) as unknown) : undefined;
      } catch {
        parsed = undefined;
      }
      throw toWireError(res.status, parsed, text, name);
    }
    const buf = await res.arrayBuffer();
    return {
      bytes: new Uint8Array(buf),
      contentType: res.headers.get('content-type') ?? undefined,
      requestId,
      status: res.status,
    };
  }

  /**
   * The ~free revalidation: one `events.poll ?since=<seq>` against the entry's
   * Space. UNCHANGED means no replayed event names any entity the payload is
   * about. Every uncertain outcome — poll refused, envelope unparseable,
   * transport down — answers CHANGED, so uncertainty always costs a refetch
   * and never serves a stale byte. A quiet replay also advances the session's
   * per-space watermark: evidence this cheap is worth keeping.
   */
  private async unchangedSince(entry: CacheEntry): Promise<boolean> {
    try {
      const { res, text } = await this.send(
        'events.poll',
        { params: { spaceId: entry.spaceId }, query: { since: String(entry.seq) } },
        'text',
        true,
      );
      if (res.status >= 400) return false;
      const data = (JSON.parse(text) as { data?: unknown }).data;
      // The LIVE page shape is `{items, nextCursor}` (poll.ts DurableEventPage,
      // pinned by the conformance suite). `data.events` and a bare array are
      // kept as accepted legacy shapes; anything else is still unreadable and
      // fails CLOSED to a refetch.
      const page = data as { events?: unknown; items?: unknown } | null | undefined;
      const events = Array.isArray(data)
        ? data
        : Array.isArray(page?.events)
          ? (page.events as unknown[])
          : Array.isArray(page?.items)
            ? (page.items as unknown[])
            : null;
      if (events === null) return false; // a page shape this build cannot read
      const replay = JSON.stringify(events).toLowerCase();
      if (entry.entityIds.some((id) => replay.includes(id))) return false;
      const seqs = events
        .map((e) => (e as { seq?: unknown }).seq)
        .filter((s): s is number => typeof s === 'number');
      if (seqs.length > 0) this.cache.advanceWatermark(entry.spaceId, Math.max(...seqs));
      return true;
    } catch {
      return false;
    }
  }

  private async send(
    name: OperationName,
    opts: InvokeOptions,
    read: 'text' | 'bytes' = 'text',
    revalidating = false,
  ): Promise<{ res: Response; url: URL; method: string; text: string }> {
    const op = getOperation(name);
    const url = new URL(bindPath(name, opts.params ?? {}), this.baseUrl);
    for (const [key, raw] of Object.entries(opts.query ?? {})) {
      if (raw === undefined) continue;
      for (const v of Array.isArray(raw) ? raw : [raw as string]) url.searchParams.append(key, v);
    }

    // ── The read-cache seam (F2). GET catalog reads only, never the poll that
    // revalidates them. `--fresh` skips the LOOKUP but the fetch below still
    // stores, so a forced refetch repairs the entry instead of orphaning it.
    const cacheable =
      !revalidating && read === 'text' && this.cache.enabled
      && op.method === 'GET' && op.kind === 'read' && name !== 'events.poll';
    if (cacheable && !this.fresh) {
      const key = this.cache.keyFor(name, url.pathname, url.searchParams);
      const entry = key === null ? null : this.cache.read(key);
      if (entry !== null) {
        if (await this.unchangedSince(entry)) {
          this.cache.notice(entry);
          // No HTTP happened, so no journal call is recorded — the journal
          // records calls the caller PAID for, and this one was free.
          const res = new Response(null, {
            status: entry.status,
            headers: { 'x-tm8-request-id': 'cached' },
          });
          return { res, url, method: op.method, text: entry.text };
        }
        this.cache.evict(key as string);
      }
    }

    const headers: Record<string, string> = { accept: 'application/json' };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (this.token) headers.authorization = `Bearer ${this.token}`;

    const controller = new AbortController();
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Only the SIZE of the request body is journalled, never its content and
    // never the headers — `authorization` is set two lines above.
    const requestChars = opts.body === undefined ? 0 : JSON.stringify(opts.body).length;
    const startedMs = Date.now();
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: op.method,
        headers,
        signal: controller.signal,
        ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      });
    } catch (err) {
      // A transport failure is still a call the agent made and paid for, so it
      // is journalled with a null status: the node never answered.
      journal.noteCall({
        operation: name,
        method: op.method,
        path: url.pathname,
        baseUrl: this.baseUrl,
        status: null,
        requestChars,
        responseChars: 0,
        durationMs: Date.now() - startedMs,
      });
      if (controller.signal.aborted) {
        throw new TransportError(
          `${op.method} ${url.pathname} timed out after ${timeoutMs}ms (per-request deadline)`,
          err,
        );
      }
      const reason = err instanceof Error ? err.message : String(err);
      throw new TransportError(
        `${op.method} ${url.pathname} failed: ${reason} (is tm8-server running at ${this.baseUrl}?)`,
        err,
      );
    } finally {
      clearTimeout(timer);
    }

    // A byte response is only drained as text when it FAILED; a success is
    // read as an ArrayBuffer by the caller so no blob is ever utf8-decoded.
    const text = read === 'text' || res.status >= 400 ? await res.text() : '';

    if (res.status < 400) {
      if (cacheable && text !== '') {
        // The store refuses entries with no coherence basis; see read-cache.ts.
        this.cache.store(name, url.pathname, url.searchParams, res.status, text);
      }
      if (!revalidating && this.cache.enabled && op.kind === 'command') {
        // A mutation this session made: every cached read about the entities
        // it names is now suspect. Ids are swept from the URL and the body —
        // over-invalidation costs a refetch, under-invalidation costs truth.
        const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
        const bodyText = opts.body === undefined ? '' : JSON.stringify(opts.body);
        this.cache.invalidate([
          ...(url.pathname.match(UUID) ?? []),
          ...(bodyText.match(UUID) ?? []),
        ]);
      }
    }

    journal.noteCall({
      operation: name,
      method: op.method,
      path: url.pathname,
      baseUrl: this.baseUrl,
      status: res.status,
      requestChars,
      // A successful bytes read is not drained here, so its size is unknown
      // rather than zero. `content-length` is the honest source when present.
      responseChars: text.length || Number(res.headers.get('content-length') ?? 0),
      durationMs: Date.now() - startedMs,
    });
    return { res, url, method: op.method, text };
  }
}

/**
 * Map an error status to the typed taxonomy. A body that is not a contract
 * error is a PROTOCOL failure (exit 10) — not a guessed taxonomy code. The
 * prototype fabricated `upstream_unavailable`/`invalid_input` here, which
 * meant a Server that had drifted off DEV-8 was reported as though it had
 * answered correctly.
 */
function toWireError(
  status: number,
  body: unknown,
  text: string,
  operation: OperationName,
): ApiError | ProtocolError {
  const parsed = WireErrorBodySchema.safeParse(body);
  if (parsed.success) {
    const { code, message, requestId, retryable, details } = parsed.data.error;
    return new ApiError(status, code, message, requestId, retryable, details, operation);
  }
  return new ProtocolError(
    `${operation} answered ${status} with a body that is not a contract error (DEV-8): ${
      text ? text.slice(0, 200) : '<empty>'
    }`,
    status,
    body ?? text,
  );
}
