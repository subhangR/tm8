/**
 * `spaceLinks.invoke` and `spaceLinks.audit` (W7, migration 990; decisions
 * 31, 33, 38 and E2).
 *
 * An agent in home space A runs ONE catalog op in target space B as its
 * LAUNCHING member, through that member's own stored link session. Through a
 * link the agent is the FULL member, except for `SPACE_LINK_REFUSED`
 * (@tm8/contract), which this file applies on the HOME server, in this order,
 * before anything is unsealed or forwarded:
 *
 *   1. the op name must be a catalog op, spelled exactly (canonical); an
 *      unknown name or a case variant is refused, never guessed at;
 *   2. the refused set on the canonical name, prefix-matched plus exact
 *      entries (credentials.*, node.credentials.*, spaceLinks.* writes,
 *      auth.*, serverConnections.*, exactly voice.token.create) and the spawn
 *      rule for explicit credential sources (F9, K11);
 *   3. the via chain from `x-tm8-via` (it can only ADD spaces): at most
 *      SPACE_LINK_MAX_HOPS hops, never back into a space already in it;
 *   4. the caller's OWN token row (990 resolve, no sealed bytes): an agent
 *      resolves its launching member's row and nobody else's (T18);
 *   5. the target half of the via rule, and the row's spawn switch;
 *   6. a rate bucket per token row.
 *
 * Only then does `DbSpaceLinkStore.use` unseal the stored session in memory
 * and re-resolve it through `resolveBearerIdentity` (F6): a revoked session
 * fails there, marks the row signed_out, and the caller gets a typed
 * `space_link_signed_out` refusal. The op then runs in-process on B's
 * registered handler with B's identity, validated by its own schema.
 *
 * Every outcome writes one `cross_space_audit` row in A under the caller's
 * own claims. No token is put in a header, an error, a log line, the audit or
 * the inner request context (`identity.token` is dropped).
 */
import {
  CollabError,
  ERROR_STATUS,
  SPACE_LINK_MAX_HOPS,
  SPACE_LINK_VIA_HEADER,
  SpaceLinksInvokeInputSchema,
  getOperation,
  isCollabError,
  isOperationName,
  spaceLinkRefusal,
  spaceLinkViaRefusal,
  type CommandErrorCode,
  type OperationBinding,
  type OperationName,
  type SpaceLinkAuditEntry,
  type SpaceLinkRefusalReason,
  type SpaceLinksInvokeResult,
} from '@tm8/contract';

import type { DbClaims } from '../../../db/types.js';
import { FixedWindowLimiter } from '../../../http/fixed-window.js';
import { normalizeCommandInputForIdempotencyMode } from '../../../http/idempotency.js';
import { identityFromSession } from '../../../http/identity-resolver.js';
import { nextRequestId } from '../../../http/request-id.js';
import type { OperationHandler, RequestContext, RequestIdentity } from '../../../http/types.js';
import { isHandlerResult } from '../../../http/types.js';
import { SpaceLinkUnusable, type DbSpaceLinkStore, type SpaceLinkInvokeRow } from '../../../credentials/space-link-store.js';
import type { FacadeDeps } from '../../deps.js';
import { INPUT_SCHEMAS } from '../../input-schemas.js';
import type { HandlerRegistry } from '../../registry.js';

/** The typed refusal code for anything in the refused set or the via rule. */
export const SPACE_LINK_REFUSED_CODE = 'space_link_refused';
/** A stored session the target no longer accepts (F6). The caller's human must sign in again. */
export const SPACE_LINK_SIGNED_OUT = 'space_link_signed_out';
/** The caller has no row on the named link (T18, or never linked). */
export const SPACE_LINK_NOT_LINKED_MESSAGE =
  'no space link by that name for your member in this space: ask your human to run `tm8 link add`';

/** Default rate bucket per token row. */
export const SPACE_LINK_INVOKE_LIMIT = { limit: 120, windowMs: 60_000 } as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UNKNOWN_OP = '(unknown)';

/*
 * TYPE-ONLY COPY. MUST EQUAL `packages/server/src/remote/forwarder.ts` (W8,
 * #885 @ 7c8a9ea6); replaced by an import on re-stack. Until then, when both
 * files are present, this compile-time equality check goes in beside the import:
 *
 *   type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
 *   const _req: Same<RemoteInvokeRequest, W8.RemoteInvokeRequest> = true;
 *   const _res: Same<RemoteInvokeResult, W8.RemoteInvokeResult> = true;
 *   const _fwd: Same<RemoteInvokeForwarder, W8.RemoteInvokeForwarder> = true;
 */
export interface RemoteInvokeRequest {
  claims: DbClaims;
  linkId: string;
  serverId: string;
  op: string;
  params?: Record<string, string>;
  query?: Record<string, string>;
  input: unknown;
  via: readonly string[];
  workSessionId?: string;
  timeoutMs?: number;
}
export type RemoteInvokeResult =
  | { kind: 'ok'; status: number; body: unknown }
  | { kind: 'refused'; status: number; code: string; message: string }
  | { kind: 'signed_out' }
  | { kind: 'unreachable'; reason: 'non_public_address' | 'invalid_url' | 'dns' | 'tls' }
  | { kind: 'offline'; reason: 'connect_refused' | 'timeout' | 'reset' }
  | { kind: 'disabled'; reason: 'remote_links_disabled' };
export interface RemoteInvokeForwarder {
  forward(req: RemoteInvokeRequest): Promise<RemoteInvokeResult>;
}

/** Typed `details.reason` for a remote target that did not run the op. */
export const SPACE_LINK_UNREACHABLE = 'space_link_unreachable';
export const SPACE_LINK_OFFLINE = 'space_link_offline';
export const SPACE_LINK_REMOTE_REFUSED = 'space_link_remote_refused';
export const SPACE_LINK_REMOTE_DISABLED = 'space_link_remote_disabled';

export interface SpaceLinkInvokeOptions {
  /** Overrides the per-token-row bucket (tests). */
  limiter?: FixedWindowLimiter;
  /**
   * Runs an invoke whose link targets another server (`target_server_id` set).
   * Absent: a remote link is refused as not implemented, never resolved here.
   */
  forwarder?: RemoteInvokeForwarder;
}

/** One guarded, resolved invoke, handed to whatever runs it on B. */
export interface SpaceLinkExecuteRequest {
  /** The caller's HOME claims (the store unseals under these). */
  readonly claims: DbClaims;
  readonly row: SpaceLinkInvokeRow;
  readonly op: OperationName;
  readonly binding: OperationBinding;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  /** The raw op input; the executor validates it against B's schema. */
  readonly input: unknown;
  /** The chain as received; the executor appends the home space when forwarding. */
  readonly via: readonly string[];
  readonly homeSpaceId: string;
  readonly workSessionId: string | null;
}

export interface SpaceLinkExecution {
  /** The op's JSON data (never bytes). */
  data: unknown;
  /** B-side request id, the audit's fallback remote id, when B names one. */
  requestId: string | null;
}

/**
 * THE seam between the home server's guards and the target. In-process (B on
 * this node) is the only implementation today; W8's `RemoteInvokeForwarder`
 * plugs in here for a remote target and nowhere else.
 */
export type SpaceLinkExecutor = (request: SpaceLinkExecuteRequest) => Promise<SpaceLinkExecution>;

/** An executor failure with the closed audit reason it should be recorded under. */
export class SpaceLinkExecuteFailure extends Error {
  constructor(readonly reason: string, readonly error: unknown) {
    super(reason);
    this.name = 'SpaceLinkExecuteFailure';
  }
}

/** `x-tm8-via`: a comma list of space ids already traversed. Malformed refuses. */
export function parseVia(header: string | string[] | undefined): string[] {
  const raw = Array.isArray(header) ? header.join(',') : header ?? '';
  const parts = raw.split(',').map((part) => part.trim()).filter((part) => part !== '');
  if (parts.length > SPACE_LINK_MAX_HOPS + 1 || parts.some((part) => !UUID_RE.test(part))) {
    throw refused('via_hops', 'x-tm8-via is malformed or longer than the hop limit');
  }
  return parts.map((part) => part.toLowerCase());
}

function refused(reason: SpaceLinkRefusalReason, message?: string): CollabError {
  return new CollabError('forbidden', message ?? `refused through a space link: ${reason}`, {
    details: { reason: SPACE_LINK_REFUSED_CODE, refusal: reason },
  });
}

/** The target-side id worth keeping in the audit: an entity or message id, never a body. */
function remoteIdOf(result: unknown): string | null {
  if (typeof result !== 'object' || result === null) return null;
  const record = result as Record<string, unknown>;
  for (const candidate of [record['id'], (record['entity'] as Record<string, unknown> | undefined)?.['id'],
    (record['message'] as Record<string, unknown> | undefined)?.['id']]) {
    if (typeof candidate === 'string' && UUID_RE.test(candidate)) return candidate;
  }
  return null;
}

function validate(opName: OperationName, body: unknown): unknown {
  const schema = INPUT_SCHEMAS[opName];
  if (!schema) return body;
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  throw new CollabError('invalid_input', 'request body failed contract validation', {
    details: { issues: parsed.error.issues },
  });
}

/** The inner identity: B's, off the re-resolved session, WITHOUT the raw token. */
function innerIdentity(identity: RequestIdentity): RequestIdentity {
  const { token: _token, ...rest } = identity;
  return rest;
}

export function createSpaceLinkInvokeHandlers(
  registry: HandlerRegistry,
  deps: FacadeDeps,
  store: DbSpaceLinkStore,
  claimsOf: (ctx: RequestContext) => Promise<DbClaims>,
  options: SpaceLinkInvokeOptions = {},
): { invoke: OperationHandler; audit: OperationHandler } {
  const limiter = options.limiter ?? new FixedWindowLimiter(SPACE_LINK_INVOKE_LIMIT);
  const spaceSessions = deps.config.spaceSessions ?? 'agents';
  const idempotencyEnabled = deps.config.idempotencyEnabled !== false;

  /** B on this node: unseal, re-resolve (F6), run B's registered handler as the member. */
  const inProcess: SpaceLinkExecutor = async (request) => {
    const { claims, row, op, binding } = request;
    const handler = registry.get(op);
    if (!handler) throw new SpaceLinkExecuteFailure('not_implemented',
      new CollabError('not_implemented', `operation ${op} is not implemented on this node`));

    // Unseal in memory and re-resolve (F6). A dead session fails HERE.
    let identity: RequestIdentity;
    try {
      const use = await store.use(claims, row.linkId, request.workSessionId ? { workSessionId: request.workSessionId } : {});
      identity = innerIdentity(identityFromSession(use.session, use.token, spaceSessions));
    } catch (error) {
      if (error instanceof SpaceLinkUnusable) {
        throw new SpaceLinkExecuteFailure(`link_${error.status}`, new CollabError(
          error.status === 'signed_out' ? 'unauthenticated' : 'forbidden',
          `space link is ${error.status}: ask your human to sign in to the link again`,
          { details: { reason: error.status === 'signed_out' ? SPACE_LINK_SIGNED_OUT : `space_link_${error.status}` } },
        ));
      }
      throw new SpaceLinkExecuteFailure('link_unusable', error);
    }
    if (identity.authKind !== 'link') {
      // The row can only ever hold a link session; anything else is refused, not run.
      throw new SpaceLinkExecuteFailure('link_kind', new CollabError('forbidden', 'the stored session is not a link session'));
    }

    let body: unknown;
    try {
      body = validate(op, normalizeCommandInputForIdempotencyMode(binding, request.input, idempotencyEnabled));
    } catch (error) {
      throw new SpaceLinkExecuteFailure(isCollabError(error) ? error.code : 'invalid_input', error);
    }
    const inner: RequestContext = {
      op: binding,
      opName: op,
      params: request.params,
      query: new URLSearchParams(request.query),
      body,
      requestId: nextRequestId(),
      identity,
      // Only the chain travels: never authorization or cookie.
      headers: { [SPACE_LINK_VIA_HEADER]: [...request.via, request.homeSpaceId].join(',') },
      method: binding.method,
      path: binding.path,
    };

    const result = await handler(inner);
    if (isHandlerResult(result)) {
      if (result.kind !== 'json') {
        throw new SpaceLinkExecuteFailure('raw_result',
          new CollabError('invalid_input', `${op} returns bytes and cannot run through a space link`));
      }
      return { data: result.data, requestId: inner.requestId };
    }
    return { data: result, requestId: inner.requestId };
  };
  /**
   * B on another server (W8). The home guards have all run; nothing is
   * unsealed or resolved here (`store.use` would resolve B's session against
   * THIS node and wrongly mark the row signed_out). Every result kind maps to
   * a typed error and a closed audit reason. On `signed_out` the FORWARDER
   * owns marking the home row (one owner); this side only types and audits.
   */
  const remote: SpaceLinkExecutor = async (request) => {
    const serverId = request.row.targetServerId;
    const forwarder = options.forwarder;
    if (!forwarder || !serverId) {
      throw new SpaceLinkExecuteFailure('remote_not_wired',
        new CollabError('not_implemented', 'this node cannot forward to a remote space link yet'));
    }
    const outcome = await forwarder.forward({
      claims: request.claims,
      linkId: request.row.linkId,
      serverId,
      op: request.op,
      params: { ...request.params },
      query: { ...request.query },
      input: request.input,
      via: [...request.via, request.homeSpaceId],
      ...(request.workSessionId ? { workSessionId: request.workSessionId } : {}),
    });
    switch (outcome.kind) {
      case 'ok':
        return { data: outcome.body, requestId: null };
      case 'signed_out':
        throw new SpaceLinkExecuteFailure('link_signed_out', new CollabError('unauthenticated',
          'space link is signed_out: ask your human to sign in to the link again',
          { details: { reason: SPACE_LINK_SIGNED_OUT } }));
      case 'unreachable':
        throw new SpaceLinkExecuteFailure(`unreachable.${outcome.reason}`, new CollabError('upstream_unavailable',
          `the linked server is unreachable (${outcome.reason})`,
          { details: { reason: SPACE_LINK_UNREACHABLE, cause: outcome.reason }, retryable: false }));
      case 'offline':
        throw new SpaceLinkExecuteFailure(`offline.${outcome.reason}`, new CollabError('upstream_unavailable',
          `the linked server is offline (${outcome.reason})`,
          { details: { reason: SPACE_LINK_OFFLINE, cause: outcome.reason }, retryable: true }));
      case 'disabled':
        throw new SpaceLinkExecuteFailure(outcome.reason, new CollabError('forbidden',
          'remote space links are disabled on this node', { details: { reason: SPACE_LINK_REMOTE_DISABLED } }));
      case 'refused': {
        // B's own refusal, re-typed: its code when it is one of ours, else by status. No B text is audited.
        const code: CommandErrorCode = outcome.code in ERROR_STATUS ? outcome.code as CommandErrorCode
          : outcome.status === 401 ? 'unauthenticated' : outcome.status === 404 ? 'not_found'
            : outcome.status === 400 ? 'invalid_input' : 'forbidden';
        throw new SpaceLinkExecuteFailure(`remote.${code}`, new CollabError(code, outcome.message,
          { details: { reason: SPACE_LINK_REMOTE_REFUSED, status: outcome.status } }));
      }
    }
  };
  /** THE seam: null target server is this node; anything else is forwarded. */
  const execute: SpaceLinkExecutor = (request) =>
    request.row.targetServerId === null || request.row.targetServerId === undefined
      ? inProcess(request) : remote(request);

  const invoke: OperationHandler = async (ctx): Promise<SpaceLinksInvokeResult> => {
    const homeSpaceId = ctx.params['spaceId'];
    const ref = ctx.params['link'];
    if (!homeSpaceId || !ref) throw new CollabError('invalid_input', 'spaceId and link are required');
    const { op: requested, params, query, input } = SpaceLinksInvokeInputSchema.parse(ctx.body);
    const claims = await claimsOf(ctx);
    const workSessionId = ctx.identity.workSessionId ?? null;

    let op = UNKNOWN_OP;
    let via: string[] = [];
    let row: SpaceLinkInvokeRow | null = null;
    const audit = async (
      result: SpaceLinkAuditEntry['result'],
      reason: string | null,
      remoteId: string | null = null,
    ): Promise<string> =>
      store.recordAudit(claims, {
        homeSpaceId, linkId: row?.linkId ?? null, linkRef: ref, targetSpaceId: row?.targetSpaceId ?? null,
        workSessionId, op, via, result, reason, remoteId,
      });
    /** Refusals are audited best-effort: a failed audit must not mask the refusal. */
    const refuse = async (error: CollabError, reason: string): Promise<never> => {
      await audit('refused', reason).catch(() => undefined);
      throw error;
    };

    // 1. Canonical op: the catalog's exact spelling or nothing.
    if (!isOperationName(requested)) {
      return refuse(refused('unknown_op', 'not a catalog operation (names are exact and case-sensitive)'), 'unknown_op');
    }
    op = requested;
    const binding = getOperation(requested);

    // 2. The refused set (the spawn switch waits for the row).
    const early = spaceLinkRefusal(requested, binding.kind, input, undefined);
    if (early) return refuse(refused(early), early);

    // 3. The via chain, before the target is known.
    try {
      via = parseVia(ctx.headers[SPACE_LINK_VIA_HEADER]);
    } catch (error) {
      return refuse(error as CollabError, 'via_hops');
    }
    const chainEarly = spaceLinkViaRefusal(via, homeSpaceId, null);
    if (chainEarly) return refuse(refused(chainEarly), chainEarly);

    // 4. The caller's own row. No row (another member's link, or none): T18.
    try {
      row = await store.resolveInvoke(claims, homeSpaceId, ref);
    } catch (error) {
      if (isCollabError(error) && (error.code === 'not_found' || error.details?.['sqlstate'] === 'P0002')) {
        return refuse(new CollabError('not_found', SPACE_LINK_NOT_LINKED_MESSAGE), 'not_linked');
      }
      if (isCollabError(error) && error.code === 'forbidden') return refuse(error, 'session_kind');
      throw error;
    }

    // 5. The target half of the via rule, then the row's spawn switch.
    const chainLate = spaceLinkViaRefusal(via, homeSpaceId, row.targetSpaceId);
    if (chainLate) return refuse(refused(chainLate), chainLate);
    const late = spaceLinkRefusal(requested, binding.kind, input, row.allowSpawn);
    if (late) return refuse(refused(late), late);

    // 6. Rate bucket per token row.
    const verdict = limiter.hit(row.tokenRowId);
    if (!verdict.ok) {
      return refuse(new CollabError('rate_limited', 'space link invoke rate exceeded for this link', {
        details: { retryAfterMs: verdict.retryAfterMs },
      }), 'rate_limited');
    }

    const local = row.targetServerId === null || row.targetServerId === undefined;
    if ((local && !registry.get(requested)) || binding.status !== 'v1') {
      return refuse(new CollabError('not_implemented', `operation ${requested} is not implemented on this node`), 'not_implemented');
    }
    if (binding.kind === 'stream') {
      return refuse(new CollabError('invalid_input', 'a streaming operation cannot run through a space link'), 'stream_op');
    }

    // Everything above is the home server's decision; from here the op runs
    // on B. The one seam a remote target (W8) plugs into.
    let outcome: SpaceLinkExecution;
    try {
      outcome = await execute({ claims, row, op: requested, binding, params: params ?? {}, query: query ?? {},
        input, via, homeSpaceId, workSessionId });
    } catch (error) {
      if (error instanceof SpaceLinkExecuteFailure) {
        await audit('error', error.reason).catch(() => undefined);
        throw error.error;
      }
      await audit('error', isCollabError(error) ? error.code : 'internal').catch(() => undefined);
      throw error;
    }
    const { data, requestId } = outcome;
    const auditId = await audit('ok', null, remoteIdOf(data) ?? requestId);
    return { op: requested, linkId: row.linkId, targetSpaceId: row.targetSpaceId, auditId, result: data };
  };

  const audit: OperationHandler = async (ctx): Promise<SpaceLinkAuditEntry[]> => {
    const linkId = ctx.params['linkId'];
    if (!linkId || !UUID_RE.test(linkId)) throw new CollabError('not_found', 'no such space link');
    const limit = Number(ctx.query.get('limit') ?? 50);
    return store.listAudit(await claimsOf(ctx), linkId, {
      limit: Number.isFinite(limit) ? limit : 50,
      before: ctx.query.get('before'),
    });
  };

  return { invoke, audit };
}
