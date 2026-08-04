/**
 * The seam types every other file in the frame binds to.
 *
 * This file is the contract BETWEEN the HTTP frame (http/), the handler
 * registry (facade/), and the event stream (events/). W2 handlers plug in
 * here and nowhere else — if a W2 implementation needs a shape that is not
 * expressed here, that is a frame change, not a handler workaround.
 *
 * Nothing in this file touches a database. The skeleton is contract-only.
 */
import type { IncomingHttpHeaders } from 'node:http';
import type { OperationBinding, OperationName } from '@tm8/contract';

/**
 * Who the caller is, as resolved by the auth seam.
 *
 * v1 local mode auto-authenticates the owner (T-L7 / 10-SECURITY S5). The
 * skeleton's resolver always returns `auto-owner` because the node binds
 * loopback-only; the bearer path (S8, CLI + spawned agents) is declared here
 * so W2 has a typed slot rather than an invention.
 */
export interface RequestIdentity {
  kind: 'auto-owner' | 'bearer' | 'anonymous';
  /** identity row id — becomes `SET LOCAL tm8.identity_id` at W2 (Cygnus R2). */
  identityId?: string;
  /** acting actor entity id — becomes `SET LOCAL tm8.actor_id`. */
  actorId?: string;
  /** Raw bearer credential when `kind === 'bearer'`; never logged. */
  token?: string;
  /**
   * Node-level admin, resolved from the verified session's account when
   * `kind === 'bearer'`. Absent for `auto-owner` (the owner resolver already
   * knows) and `anonymous`. Never widens `can_act_as` (T-L7).
   */
  nodeAdmin?: boolean;
  /** Verified account row id when `kind === 'bearer'`. */
  accountId?: string;
  /** Verified `auth_sessions` row id when `kind === 'bearer'`. */
  sessionId?: string;
  /** Exact work session bound to an agent bearer credential. */
  workSessionId?: string;
}

/** Everything a handler is allowed to know about one request. */
export interface RequestContext {
  /** The catalog binding this request routed to — the ONLY source of op truth. */
  readonly op: OperationBinding;
  readonly opName: OperationName;
  /** Path params extracted from the catalog path (`:id` → `params.id`). */
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  /**
   * Parsed JSON request body, or `undefined` when the request carried none.
   * Replaced by the zod-validated value when the op has a bound input schema.
   */
  readonly body: unknown;
  /**
   * Server-generated id, echoed in the DEV-6 envelope and the DEV-8 error
   * body, and stamped into `SET LOCAL tm8.request_id` at W2 so an audit row
   * and a client-visible id are joinable.
   */
  readonly requestId: string;
  readonly identity: RequestIdentity;
  readonly headers: IncomingHttpHeaders;
  readonly method: string;
  readonly path: string;
}

/** A JSON result — the frame wraps `data` in the DEV-6 `{data, requestId}` envelope. */
export interface JsonResult {
  kind: 'json';
  data: unknown;
  /** Defaults to 200. Commands that create may use 201. */
  status?: number;
  headers?: Record<string, string>;
}

/**
 * A raw byte result that deliberately escapes the envelope. Exactly one v1
 * operation needs this: `files.download` returns bytes, not JSON (catalog
 * line 105). Handlers must not use it for anything else.
 */
export interface RawResult {
  kind: 'raw';
  status: number;
  headers: Record<string, string>;
  body: Buffer | string;
}

export type HandlerResult = JsonResult | RawResult;

/**
 * A handler may return a `HandlerResult` for full control, or any other value
 * — which the frame treats as the `data` of a 200 JSON response. Returning a
 * plain DTO is the common case.
 */
export type OperationHandler = (ctx: RequestContext) => Promise<HandlerResult | unknown> | HandlerResult | unknown;

export function isHandlerResult(v: unknown): v is HandlerResult {
  return (
    typeof v === 'object' &&
    v !== null &&
    'kind' in v &&
    ((v as { kind: unknown }).kind === 'json' || (v as { kind: unknown }).kind === 'raw')
  );
}

/** Convenience constructors so handlers never hand-build envelopes. */
export function json(data: unknown, opts: { status?: number; headers?: Record<string, string> } = {}): JsonResult {
  return { kind: 'json', data, ...opts };
}

export function raw(status: number, headers: Record<string, string>, body: Buffer | string): RawResult {
  return { kind: 'raw', status, headers, body };
}

/** Facts supplied by the transport, never by a caller-controlled header. */
export interface IdentityResolutionContext {
  /** The TCP peer reported by Node. Only an actual loopback peer may auto-own. */
  readonly remoteAddress: string | undefined;
  /** Operator kill switch. When true, even a bare loopback request is anonymous. */
  readonly disableAutoOwner: boolean;
}

/**
 * Resolves the caller's identity. The skeleton ships `autoOwnerResolver`;
 * W2/identity adds the bearer arm to this same seam.
 */
export type IdentityResolver = (
  headers: IncomingHttpHeaders,
  context: IdentityResolutionContext,
) => RequestIdentity | Promise<RequestIdentity>;
