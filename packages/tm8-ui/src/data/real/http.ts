/**
 * The fetch transport under createRealSeam() (LLD §5).
 *
 * Three jobs, all of them about honesty:
 *
 * 1. **URLs come from the catalog, never from a string literal.** Every request
 *    names an `OperationName`; the method and the path template are read out of
 *    `OPERATIONS` and the params are substituted by `bindPath`. A path this file
 *    can build is a path the contract declares — a typo becomes a compile error
 *    or a `bindPath` throw, never a 404 at runtime.
 *
 * 2. **Unwrap the DEV-6 envelope.** Success is `{data, requestId}`, failure is
 *    `{error:{code,message,details,requestId,retryable}}`. Callers get the bare
 *    payload or a thrown `CollabError`; the envelope never leaks upward.
 *
 * 3. **No second error vocabulary** (LLD §4). Unlike the old UI's `TmClient`,
 *    this client does NOT remap error codes: the new UI's error set IS the
 *    contract's `CommandErrorCode`, so the server's own code passes through
 *    verbatim and `limit_exceeded` needs no home to be found for it. The only
 *    codes this file *originates* are for things the server never said:
 *    unreachable node and non-JSON body, both `upstream_unavailable`.
 *
 * Everything external is injectable — `fetch`, the base URL, and the transport
 * signal — so the tests in this directory reach zero network by construction.
 */
import {
  CollabError,
  ERROR_STATUS,
  REQUEST_TIMEOUT_MS,
  TM8_CLIENT_HEADER,
  TM8_CLIENT_HEADER_VALUE,
  TM8_UPLOAD_TOKEN_HEADER,
  bindPath,
  getOperation,
  type CommandErrorCode,
  type OperationName,
} from '@tm8/contract';

/** The subset of `fetch` this client uses. Injectable; never captured at import time. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Query values. `undefined` keys are omitted entirely rather than sent as the
 * string "undefined" — several server query parsers reject unknown/garbage keys
 * with a hard 400 (inbox.list and entities.feed both do).
 */
export type QueryParams = Record<string, string | number | boolean | undefined>;

export interface HttpOptions {
  /**
   * Default is relative (''), which is the deployment shape: the vite dev
   * server on :4612 proxies /v2 to the node, so the app stays same-origin and
   * no origin is baked into the seam. Tests inject their own.
   */
  baseUrl?: string;
  /**
   * Injected `fetch`. There is deliberately NO default that reaches for
   * `globalThis.fetch` lazily-but-invisibly: the default is read once here, and
   * every test in this lane passes its own, so no code path in `src/data/real`
   * can touch a socket unless a caller handed it one.
   */
  fetch?: FetchLike;
  /**
   * Transport reachability signal (LLD §5: "network failure … flip connection
   * signal"). `false` means the request never reached the node; `true` means
   * the node answered — including when it answered with a refusal. A 403 is
   * evidence of reachability, not of disconnection.
   */
  onTransport?: (reachable: boolean) => void;
  /**
   * The viewer's `tm8s_…` pass for THIS server, or null. Read per request —
   * not captured at construction — so a sign-in or sign-out takes effect on
   * the next call without rebuilding the client. Absent or null means no
   * Authorization header at all, which on a loopback node resolves to the
   * auto-owner exactly as before this option existed (T-L7: local is the
   * degenerate case, and it must keep working credential-free).
   */
  getAuthToken?: () => string | null;
  /**
   * Ceiling on any single request, headers-to-body. Without one, a node whose
   * pool is wedged (accepts the socket, never answers) produces a promise that
   * NEVER SETTLES — no catch runs, no `bootError` is set, and the UI shows
   * `loading workspace` forever. This was the observed field failure, so the
   * default is on, not opt-in. A timeout reads as transport failure: the node
   * did not answer, which is the same honest fact as "connection refused",
   * only slower.
   */
  timeoutMs?: number;
}

/**
 * Ceiling on one request — no longer a number this file picks alone.
 *
 * It used to be a bare `15_000` here while `server/src/db/client.ts` set
 * `statement_timeout: 30_000`, with neither site naming the other. The server
 * was therefore allowed to spend TWICE as long as this client would ever wait,
 * which made the second half of every slow query waste by construction: the
 * abort below tears down the HTTP request, and the Postgres statement it
 * started used to run on regardless, into a socket nobody reads.
 *
 * What fixed that is NOT arithmetic between the two numbers — squeezing the
 * server's ceiling to fit inside this one was measured and rejected, see
 * `@tm8/contract`'s `timeouts.ts`. It is that the server now CANCELS a read
 * whose client has hung up, within milliseconds of the abort below firing. The
 * numbers still live together in that one file so a future change has to see
 * all of them at once:
 *
 *   - `server/src/db/client.ts`                     — the pool every read uses
 *   - `server/src/facade/services/w2/execution.ts`  — the delivery pool
 *
 * Raising this to 30s to match the server was considered and REJECTED: it makes
 * a failure that is currently fast into one that is slow, without making any
 * request more likely to succeed.
 *
 * KNOWN GAP, not fixed here. A COMMAND is deliberately never cancelled — a user
 * who clicks send and closes the tab has sent the message — so a slow-but-
 * successful mutation can still trip this abort and be reported to the caller
 * as a failure it was not. Reconciling that needs the caller to re-read the
 * outcome, which is a larger change than a timeout.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = REQUEST_TIMEOUT_MS;
/**
 * Uploads move real bytes; they get a proportionally longer leash.
 *
 * DELIBERATELY NOT PART OF THE SHARED BUDGET ABOVE, and it must not be folded
 * into it in a later tidy-up. The budget above exists to bound an INTERACTIVE
 * READ against a database statement; an upload's duration is a function of file
 * size and link speed, so there is no server-side statement whose ceiling this
 * should sit outside of. `putGrantedBytes` streams to the grant URL and touches
 * no pool.
 */
export const UPLOAD_TIMEOUT_MS = 120_000;

export interface RequestOptions {
  /** `:param` substitutions for the catalog path template. */
  params?: Record<string, string>;
  query?: QueryParams;
  /** Sent as JSON. `undefined` sends no body at all (not an empty `{}`). */
  body?: unknown;
}

/**
 * The closed error set, read off the contract's own status table rather than
 * re-listed here. A duplicated list is a list that drifts; `ERROR_STATUS` is
 * `Record<CommandErrorCode, number>`, so its keys ARE the vocabulary.
 */
function isCommandErrorCode(code: string): code is CommandErrorCode {
  return Object.prototype.hasOwnProperty.call(ERROR_STATUS, code);
}

/**
 * Wire error body → `CollabError`, preserving the server's own code.
 *
 * An unrecognised code becomes `upstream_unavailable` and keeps the original in
 * `details.serverCode`: inventing a precise-looking error for a code we do not
 * understand is a lie with a stack trace attached (the old UI's comment, still
 * true). The server's `requestId` also lands in `details` because `CollabError`
 * mints its own client-side id and would otherwise drop the server's — the id
 * you need to grep the node log is the server's.
 */
function toCollabError(status: number, body: unknown): CollabError {
  const err = (body as { error?: Record<string, unknown> } | null | undefined)?.error;
  const rawCode = typeof err?.code === 'string' ? err.code : undefined;
  const message = typeof err?.message === 'string'
    ? err.message
    : `tm8 returned HTTP ${status}`;
  const rawDetails = err?.details;
  const details: Record<string, unknown> =
    rawDetails !== null && typeof rawDetails === 'object'
      ? { ...(rawDetails as Record<string, unknown>) }
      : rawDetails === undefined ? {} : { value: rawDetails };

  if (typeof err?.requestId === 'string') details.serverRequestId = err.requestId;

  // The status the wire ACTUALLY carried, on every served error — not only
  // the unrecognised-code fallback it used to mark. `CollabError.status` is
  // recomputed from the code, so a client-minted "node unreachable" error and
  // a served 503 both read `status: 503` off the class; this field is the
  // only record that a response arrived at all. The boot retry keys its
  // backoff on that difference: an overloaded node is answering, and every
  // fast retry against it is added load.
  details.httpStatus = status;

  let code: CommandErrorCode;
  if (rawCode !== undefined && isCommandErrorCode(rawCode)) {
    code = rawCode;
  } else {
    code = 'upstream_unavailable';
    if (rawCode !== undefined) details.serverCode = rawCode;
  }

  return new CollabError(code, message, {
    retryable: typeof err?.retryable === 'boolean' ? err.retryable : undefined,
    details,
  });
}

function buildQuery(query: QueryParams | undefined): string {
  if (query === undefined) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.length === 0 ? '' : `?${parts.join('&')}`;
}

export interface HttpClient {
  /** Catalog-bound request. The method and path template come from `OPERATIONS`. */
  call<T>(op: OperationName, opts?: RequestOptions): Promise<T>;
  /**
   * Catalog-bound request for a route that answers RAW BYTES (today exactly
   * one: `artifacts.export`). Same URL construction, headers and timeout as
   * `call`, and a non-2xx still carries the JSON error envelope and becomes
   * the same `CollabError` — but success resolves the body as a `Blob` and
   * NEVER parses it: a zip through `JSON.parse` is corruption, not a download.
   */
  callBytes(op: OperationName, opts?: RequestOptions): Promise<Blob>;
  /**
   * ESCAPE HATCH for a route the catalog does not declare yet — today exactly
   * one: `execution.liveness` (LLD C-1 / §13 open item). See `ops.ts`; this is
   * not a generic op-name dispatcher and must not grow one.
   */
  callPath<T>(method: string, path: string, opts?: RequestOptions): Promise<T>;
  /** Raw upload to the server-minted grant URL, authorized by its bearer token. */
  putGrantedBytes(uploadUrl: string, token: string | null | undefined, body: BodyInit): Promise<void>;
  readonly baseUrl: string;
}

export function createHttpClient(options: HttpOptions = {}): HttpClient {
  const baseUrl = (options.baseUrl ?? '').replace(/\/$/, '');
  const doFetch: FetchLike | undefined = options.fetch;
  const onTransport = options.onTransport;
  const getAuthToken = options.getAuthToken;
  const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

  /**
   * The timeout covers the WHOLE exchange — connect, headers, and body — via
   * one AbortController. Headers-then-stalled-body is the same wedge as
   * never-connected as far as a caller awaiting `data` is concerned.
   */
  function armTimeout(ms: number): { signal: AbortSignal; timedOut: () => boolean; disarm: () => void } {
    const controller = new AbortController();
    let fired = false;
    const timer = setTimeout(() => {
      fired = true;
      controller.abort();
    }, ms);
    return {
      signal: controller.signal,
      timedOut: () => fired,
      disarm: () => clearTimeout(timer),
    };
  }

  async function callPath<T>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    if (doFetch === undefined) {
      // Not a network error: a wiring error. Saying so plainly beats an
      // `undefined is not a function` from three frames down.
      throw new CollabError('upstream_unavailable', 'no fetch implementation was provided to createHttpClient()');
    }
    const url = `${baseUrl}${path}${buildQuery(opts.query)}`;
    const hasBody = opts.body !== undefined;
    const guard = armTimeout(timeoutMs);
    // Read per request (see the option's docblock): the pass can change
    // between calls, and a stale capture here would keep acting as a viewer
    // who already signed out.
    const authToken = getAuthToken?.() ?? null;

    try {
      let res: Response;
      try {
        res = await doFetch(url, {
          method,
          // S6 on EVERY request, not just mutations. The gate only applies to
          // state-changing methods, but there is no list of "the mutating
          // calls" in this file to keep in sync with the server's — sending it
          // unconditionally makes the client correct by construction, and the
          // header is inert on a read.
          headers: {
            [TM8_CLIENT_HEADER]: TM8_CLIENT_HEADER_VALUE,
            ...(hasBody ? { 'content-type': 'application/json' } : {}),
            ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
          },
          ...(hasBody ? { body: JSON.stringify(opts.body) } : {}),
          signal: guard.signal,
        });
      } catch (cause) {
        // The node is unreachable — a transport fact, distinct from any refusal
        // the server might have expressed. A timeout is the same fact observed
        // more slowly: nothing answered.
        onTransport?.(false);
        throw new CollabError(
          'upstream_unavailable',
          guard.timedOut()
            ? `the tm8 node did not answer within ${timeoutMs}ms`
            : `cannot reach the tm8 node: ${String(cause)}`,
          { retryable: true, details: { url } },
        );
      }

      // It answered. A refusal is still an answer.
      onTransport?.(true);

      let text: string;
      try {
        text = await res.text();
      } catch (cause) {
        if (!guard.timedOut()) throw cause;
        onTransport?.(false);
        throw new CollabError('upstream_unavailable', `the tm8 node did not answer within ${timeoutMs}ms`, {
          retryable: true,
          details: { url },
        });
      }
      let parsed: unknown;
      try {
        parsed = text === '' ? undefined : JSON.parse(text);
      } catch {
        // `httpStatus` alongside the legacy `status` key: a proxy's own 502/503
        // error page is non-JSON and lands here, and the boot retry must read
        // it as "answered, overloaded" — same marker toCollabError sets.
        throw new CollabError('upstream_unavailable', `tm8 returned non-JSON (HTTP ${res.status})`, {
          details: { url, status: res.status, httpStatus: res.status },
        });
      }

      if (!res.ok) throw toCollabError(res.status, parsed);

      return (parsed as { data?: T } | undefined)?.data as T;
    } finally {
      guard.disarm();
    }
  }

  /**
   * `callPath` for a bytes route. Kept as its own function rather than a flag
   * on `callPath` because the two success paths are irreconcilable — one MUST
   * parse the body and one MUST NOT — and a boolean that flips "parse" is the
   * kind of parameter that ends with a zip through `JSON.parse`.
   */
  async function callPathBytes(method: string, path: string, opts: RequestOptions = {}): Promise<Blob> {
    if (doFetch === undefined) {
      throw new CollabError('upstream_unavailable', 'no fetch implementation was provided to createHttpClient()');
    }
    const url = `${baseUrl}${path}${buildQuery(opts.query)}`;
    const guard = armTimeout(timeoutMs);
    const authToken = getAuthToken?.() ?? null;

    try {
      let res: Response;
      try {
        res = await doFetch(url, {
          method,
          headers: {
            [TM8_CLIENT_HEADER]: TM8_CLIENT_HEADER_VALUE,
            ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
          },
          signal: guard.signal,
        });
      } catch (cause) {
        onTransport?.(false);
        throw new CollabError(
          'upstream_unavailable',
          guard.timedOut()
            ? `the tm8 node did not answer within ${timeoutMs}ms`
            : `cannot reach the tm8 node: ${String(cause)}`,
          { retryable: true, details: { url } },
        );
      }

      onTransport?.(true);

      // A refusal is still JSON: the error envelope arrives on the same route
      // that answers bytes on success, so the failure path parses and the
      // success path does not.
      if (!res.ok) {
        const text = await res.text();
        let parsed: unknown;
        try {
          parsed = text === '' ? undefined : JSON.parse(text);
        } catch {
          throw new CollabError('upstream_unavailable', `tm8 returned non-JSON (HTTP ${res.status})`, {
            details: { url, status: res.status, httpStatus: res.status },
          });
        }
        throw toCollabError(res.status, parsed);
      }

      try {
        return await res.blob();
      } catch (cause) {
        if (!guard.timedOut()) throw cause;
        onTransport?.(false);
        throw new CollabError('upstream_unavailable', `the tm8 node did not answer within ${timeoutMs}ms`, {
          retryable: true,
          details: { url },
        });
      }
    } finally {
      guard.disarm();
    }
  }

  async function putGrantedBytes(
    uploadUrl: string,
    token: string | null | undefined,
    body: BodyInit,
  ): Promise<void> {
    if (token === null || token === undefined || token === '') {
      throw new CollabError('unauthenticated', 'the upload grant has no bearer token');
    }
    if (doFetch === undefined) {
      throw new CollabError('upstream_unavailable', 'no fetch implementation was provided to createHttpClient()');
    }

    // An absolute grant URL points at a foreign store, not at our node. S6 is
    // ours, so the header goes only on the relative (same-node) form — adding
    // a custom header to a cross-origin PUT buys nothing here and would put a
    // preflight in front of somebody else's bucket.
    const foreign = /^https?:\/\//i.test(uploadUrl);
    const url = foreign
      ? uploadUrl
      : `${baseUrl}${uploadUrl.startsWith('/') ? uploadUrl : `/${uploadUrl}`}`;
    const guard = armTimeout(UPLOAD_TIMEOUT_MS);
    // THE GRANT DOES NOT GO IN `Authorization` ON OUR OWN NODE — that header is
    // the viewer's, and this is the one request in the app that used to take it
    // away from them. The browser attaches the `__Host-tm8-session` cookie to
    // this same-origin PUT whether we like it or not, so a grant in
    // `Authorization` reaches the node as a second, different credential and
    // the identity path refuses the pair outright: every browser upload came
    // back `unauthenticated`, rendered as "Sign in again before uploading
    // files" to a viewer who was signed in. The capability gets its own header
    // (`TM8_UPLOAD_TOKEN_HEADER`) and `Authorization` carries the same pass
    // every other call sends, so cookie and header name one principal.
    //
    // A FOREIGN store has no tm8 identity to preserve and no cookie of ours to
    // collide with; there the grant IS the credential, in the header a
    // presigned PUT expects.
    const authToken = getAuthToken?.() ?? null;
    let res: Response;
    try {
      res = await doFetch(url, {
        method: 'PUT',
        headers: foreign
          ? { authorization: `Bearer ${token}` }
          : {
              [TM8_UPLOAD_TOKEN_HEADER]: token,
              [TM8_CLIENT_HEADER]: TM8_CLIENT_HEADER_VALUE,
              ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
            },
        body,
        signal: guard.signal,
      });
    } catch (cause) {
      onTransport?.(false);
      throw new CollabError(
        'upstream_unavailable',
        guard.timedOut()
          ? `the upload target did not answer within ${UPLOAD_TIMEOUT_MS}ms`
          : `cannot reach the upload target: ${String(cause)}`,
        { retryable: true, details: { url } },
      );
    } finally {
      guard.disarm();
    }

    onTransport?.(true);
    if (res.ok) return;

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text === '' ? undefined : JSON.parse(text);
    } catch {
      throw new CollabError('upstream_unavailable', `upload target returned non-JSON (HTTP ${res.status})`, {
        details: { url, status: res.status },
      });
    }
    throw toCollabError(res.status, parsed);
  }

  return {
    baseUrl,
    callPath,
    putGrantedBytes,
    call<T>(op: OperationName, opts: RequestOptions = {}): Promise<T> {
      const binding = getOperation(op);
      return callPath<T>(binding.method, bindPath(op, opts.params ?? {}), opts);
    },
    callBytes(op: OperationName, opts: RequestOptions = {}): Promise<Blob> {
      const binding = getOperation(op);
      return callPathBytes(binding.method, bindPath(op, opts.params ?? {}), opts);
    },
  };
}
