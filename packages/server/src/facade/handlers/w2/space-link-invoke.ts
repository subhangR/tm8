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
 *   2. the refused set, by prefix on the canonical name (credentials.*,
 *      node.credentials.*, spaceLinks.* writes, auth.*) and the spawn rule for
 *      explicit credential sources (F9, K11);
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
  SPACE_LINK_MAX_HOPS,
  SPACE_LINK_VIA_HEADER,
  SpaceLinksInvokeInputSchema,
  getOperation,
  isCollabError,
  isOperationName,
  spaceLinkRefusal,
  spaceLinkViaRefusal,
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

export interface SpaceLinkInvokeOptions {
  /** Overrides the per-token-row bucket (tests). */
  limiter?: FixedWindowLimiter;
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

    const handler = registry.get(requested);
    if (!handler || binding.status !== 'v1') {
      return refuse(new CollabError('not_implemented', `operation ${requested} is not implemented on this node`), 'not_implemented');
    }
    if (binding.kind === 'stream') {
      return refuse(new CollabError('invalid_input', 'a streaming operation cannot run through a space link'), 'stream_op');
    }

    // Unseal in memory and re-resolve (F6). A dead session fails HERE.
    let identity: RequestIdentity;
    try {
      const use = await store.use(claims, row.linkId, workSessionId ? { workSessionId } : {});
      identity = innerIdentity(identityFromSession(use.session, use.token, spaceSessions));
    } catch (error) {
      if (error instanceof SpaceLinkUnusable) {
        await audit('error', `link_${error.status}`).catch(() => undefined);
        throw new CollabError(
          error.status === 'signed_out' ? 'unauthenticated' : 'forbidden',
          `space link is ${error.status}: ask your human to sign in to the link again`,
          { details: { reason: error.status === 'signed_out' ? SPACE_LINK_SIGNED_OUT : `space_link_${error.status}` } },
        );
      }
      await audit('error', 'link_unusable').catch(() => undefined);
      throw error;
    }
    if (identity.authKind !== 'link') {
      // The row can only ever hold a link session; anything else is refused, not run.
      await audit('error', 'link_kind').catch(() => undefined);
      throw new CollabError('forbidden', 'the stored session is not a link session');
    }

    let body: unknown;
    try {
      body = validate(requested, normalizeCommandInputForIdempotencyMode(binding, input, idempotencyEnabled));
    } catch (error) {
      await audit('error', isCollabError(error) ? error.code : 'invalid_input').catch(() => undefined);
      throw error;
    }
    const search = new URLSearchParams(query ?? {});
    const inner: RequestContext = {
      op: binding,
      opName: requested,
      params: params ?? {},
      query: search,
      body,
      requestId: nextRequestId(),
      identity,
      // Only the chain travels: never authorization or cookie.
      headers: { [SPACE_LINK_VIA_HEADER]: [...via, homeSpaceId].join(',') },
      method: binding.method,
      path: binding.path,
    };

    let result: unknown;
    try {
      result = await handler(inner);
    } catch (error) {
      await audit('error', isCollabError(error) ? error.code : 'internal').catch(() => undefined);
      throw error;
    }
    let data: unknown = result;
    if (isHandlerResult(result)) {
      if (result.kind !== 'json') {
        await audit('error', 'raw_result').catch(() => undefined);
        throw new CollabError('invalid_input', `${requested} returns bytes and cannot run through a space link`);
      }
      data = result.data;
    }
    const auditId = await audit('ok', null, remoteIdOf(data) ?? inner.requestId);
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
