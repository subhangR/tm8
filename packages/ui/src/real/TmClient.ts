/**
 * TmClient — the HTTP transport under RealFacade. Nothing above this file
 * knows that tm8 speaks JSON over HTTP.
 *
 * Two jobs, both of them about honesty:
 *
 * 1. Unwrap the DEV-6 envelope. Every tm8 success is `{data, requestId}` and
 *    every failure is `{error:{code,message,details,requestId,retryable}}`.
 *    Callers get the bare payload or a thrown CollabError — the envelope never
 *    leaks past this file, because the facade seam's contract says so.
 *
 * 2. Translate tm8's error taxonomy into the UI's CLOSED error set. The UI's
 *    CommandErrorCode was frozen before tm8 added `limit_exceeded`, so that one
 *    code has no home and must be mapped rather than passed through — see
 *    LIMIT_EXCEEDED below. An unrecognised code becomes `upstream_unavailable`
 *    instead of being coerced to something specific, because inventing a
 *    precise-looking error for a code we do not understand is a lie with a
 *    stack trace attached.
 */
import {
  CollabError,
  type CommandErrorCode,
} from '../collab-v2/types/contract';

/** The UI's frozen error set. Anything outside it must be mapped explicitly. */
const KNOWN_CODES = new Set<CommandErrorCode>([
  'invalid_input', 'invalid_cursor', 'unauthenticated', 'forbidden',
  'not_found', 'version_conflict', 'invariant_violation', 'payload_too_large',
  'rate_limited', 'not_implemented', 'upstream_unavailable',
]);

/**
 * tm8's AM-2 §4 amendment adds `limit_exceeded` (a governance cap — e.g. the
 * execution.spawn session-concurrency ceiling) which the UI snapshot's union
 * does not contain. It shares 429 and retryability with `rate_limited`, so
 * that is the faithful landing spot: same status, same "try again once
 * capacity frees" affordance. The original code is preserved in `details.tm8Code`
 * so the surfaced message can still say *which* limit was hit.
 */
const LIMIT_EXCEEDED: CommandErrorCode = 'rate_limited';

function toCollabError(status: number, body: unknown): CollabError {
  const err = (body as { error?: Record<string, unknown> } | null)?.error;
  const rawCode = typeof err?.code === 'string' ? err.code : undefined;
  const message = typeof err?.message === 'string'
    ? err.message
    : `tm8 returned HTTP ${status}`;
  const details = (err?.details ?? {}) as Record<string, unknown>;

  let code: CommandErrorCode;
  if (rawCode === 'limit_exceeded') {
    code = LIMIT_EXCEEDED;
  } else if (rawCode && KNOWN_CODES.has(rawCode as CommandErrorCode)) {
    code = rawCode as CommandErrorCode;
  } else {
    code = status === 404 ? 'not_found' : 'upstream_unavailable';
  }

  return new CollabError(code, message, {
    retryable: typeof err?.retryable === 'boolean' ? err.retryable : undefined,
    details: rawCode && rawCode !== code ? { ...details, tm8Code: rawCode } : details,
  });
}

export type ConnectionListener = (connected: boolean) => void;

export class TmClient {
  /**
   * Relative by default: the Vite dev server proxies /v2 to the tm8 node, so
   * the page stays same-origin and no base URL is baked into the seam.
   */
  private readonly baseUrl: string;
  private connected = true;
  private readonly listeners = new Set<ConnectionListener>();

  constructor(baseUrl = '') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  isConnected(): boolean {
    return this.connected;
  }

  onConnectionChange(cb: ConnectionListener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private setConnected(next: boolean): void {
    if (this.connected === next) return;
    this.connected = next;
    for (const cb of this.listeners) cb(next);
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      // The node is unreachable — a transport fact, distinct from any refusal
      // the server might have expressed. Flip the connection flag so the shell's
      // offline banner tells the truth instead of the UI silently showing stale
      // state as if it were live.
      this.setConnected(false);
      throw new CollabError('upstream_unavailable', `cannot reach the tm8 server: ${String(cause)}`);
    }

    this.setConnected(true);

    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      throw new CollabError('upstream_unavailable', `tm8 returned non-JSON (HTTP ${res.status})`);
    }

    if (!res.ok) throw toCollabError(res.status, parsed);

    return (parsed as { data: T } | undefined)?.data as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body ?? {});
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body ?? {});
  }

  /**
   * DELETE and PUT are not dead code. Nine catalog operations bind to them —
   * `entities.delete`, `edges.delete`, `messages.delete`, `taskAxes.delete`,
   * `savedViews.delete` and `projects.unlink` on DELETE; `entities.react`,
   * `inbox.markRead` and `readMarks.upsert` on PUT. Without these wrappers the
   * TRANSPORT is what blocks them, so a facade method could not be written even
   * against a server that had implemented the route — a failure that would look
   * like a missing feature rather than a missing verb. `entities.react` already
   * has live call sites above the seam, which is what makes this worth having
   * ahead of the server rather than after it.
   */
  delete<T>(path: string): Promise<T> {
    // No body, deliberately: HTTP DELETE conventionally carries none, and all
    // six DELETE bindings name their subject in the path. `request` omits the
    // body entirely when it is undefined, so no empty `{}` is sent either.
    return this.request<T>('DELETE', path);
  }

  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, body ?? {});
  }
}
