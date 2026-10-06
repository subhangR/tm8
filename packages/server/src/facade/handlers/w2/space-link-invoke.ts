/**
 * `spaceLinks.invoke` and `spaceLinks.audit` (W7, migration 260; decisions
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
 *   4. the caller's OWN token row (260 resolve, no sealed bytes): an agent
 *      resolves its launching member's row and nobody else's (T18);
 *   5. the target half of the via rule, and the row's spawn switch: a spawn
 *      op (SPACE_LINK_SPAWN_OPS — spawn, resume, dispatch; W7b, owner form
 *      response 01a0fbb4, no budget) passes only while it is on;
 *   6. a rate bucket per token row.
 *
 * Only then does `DbSpaceLinkStore.use` unseal the stored session in memory
 * and re-resolve it through `resolveBearerIdentity` (F6): a revoked session
 * fails there, marks the row signed_out, and the caller gets a typed
 * `space_link_signed_out` refusal. The op then runs in-process on B's
 * registered handler with B's identity, validated by its own schema. That
 * identity is authKind `link`, which the registry (W7p layer (ii)) refuses
 * on every op; the executor marks its one inner context with
 * `admitLinkInvoke` (identity/link-bearer.ts), the only admission there is.
 * Layer (iii) still applies to the inner call: a spawn op passes it only on
 * the context this executor admitted, under the link claim, and SQL then mints
 * the child only while the row is signed in with spawning allowed, hands it
 * B's DEFAULT credential only, stamps it with the link (256) and pins it to
 * B. After a spawn op the executor records the child's provenance in B
 * (`space_link_spawns`, 277) under the link session's claims, and the audit
 * row in A names the child session as its remote id.
 *
 * Every outcome writes one `cross_space_audit` row in A under the caller's
 * own claims. No token is put in a header, an error, a log line, the audit or
 * the inner request context (`identity.token` is dropped).
 */
import {
  CollabError,
  ERROR_STATUS,
  SPACE_LINK_MAX_HOPS,
  SPACE_LINK_SPAWN_OPS,
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
import { admitLinkInvoke } from '../../../identity/link-bearer.js';
import { nextRequestId } from '../../../http/request-id.js';
import type { OperationHandler, RequestContext, RequestIdentity } from '../../../http/types.js';
import { isHandlerResult } from '../../../http/types.js';
import { SpaceLinkUnusable, type DbSpaceLinkStore, type SpaceLinkInvokeRow } from '../../../credentials/space-link-store.js';
import type { FacadeDeps } from '../../deps.js';
import { INPUT_SCHEMAS } from '../../input-schemas.js';
import type { HandlerRegistry } from '../../registry.js';
import type { RemoteInvokeForwarder } from '../../../remote/forwarder.js';

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

// W8 (#885, rebuilt on main f01b1566): the forwarder types, formerly a
// type-only copy here, now come from their one home.
export type { RemoteInvokeForwarder, RemoteInvokeRequest, RemoteInvokeResult } from '../../../remote/forwarder.js';

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
   * Defaults to `deps.remoteInvokeForwarder` — in production W8's
   * `DisabledRemoteInvokeForwarder`, so a remote link refuses at once with
   * `space_link_remote_disabled`. Neither set: refused as not implemented,
   * never resolved here.
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
  /** A spawn op's child work session in B (W7b), the audit's remote id. */
  spawnedSessionId?: string | null;
  /** A spawn op whose provenance record in B failed: audited, never thrown. */
  provenanceUnrecorded?: boolean;
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

/**
 * The work session a spawn op started (or resumed) in B: the spawned
 * entity, the resumed id, or the dispatcher a dispatch had to spawn first.
 * Null when it started none (a dispatch to a live dispatcher).
 */
export function spawnedSessionOf(op: OperationName, params: Readonly<Record<string, string>>, result: unknown): string | null {
  const record = typeof result === 'object' && result !== null ? result as Record<string, unknown> : {};
  let id: unknown = null;
  if (op === 'execution.spawn') id = (record['entity'] as Record<string, unknown> | undefined)?.['id'];
  else if (op === 'execution.resume') id = params['id'];
  else if (op === 'execution.dispatch' && record['dispatcherSpawned'] === true) id = record['dispatcherSessionId'];
  return typeof id === 'string' && UUID_RE.test(id) ? id : null;
}

/**
 * The input without the caller's HOME actor. A session's CLI stamps its own
 * actor (`TM8_ACTOR_ID`, a team member of A) on every write as `actorId`; in B
 * that id is nobody the link session can act as, so B's `resolve_actor`
 * refused every write with "not permitted to act as this actor". Through a
 * link the agent acts as the launching member, so its home actor is dropped
 * and B resolves the actor from the link session itself. Any other actorId is
 * left for B to authorize.
 */
export function withoutHomeActor(input: unknown, homeActorId: string | undefined): unknown {
  if (!homeActorId || typeof input !== 'object' || input === null || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  if (typeof record['actorId'] !== 'string' || record['actorId'].toLowerCase() !== homeActorId.toLowerCase()) {
    return input;
  }
  const { actorId: _home, ...rest } = record;
  return rest;
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
    // Pinned to the link's target Space in EVERY TM8_SPACE_SESSIONS mode, the
    // way viaLinkId already is. identityFromSession drops the pin under `off`,
    // and nothing else compares an input spaceId with the target: without
    // this, an invoke under `off` read and wrote the HOME Space as the member.
    // A pinned session never carries node admin (K6).
    identity = { ...identity, sessionSpaceId: row.targetSpaceId, nodeAdmin: false };

    let body: unknown;
    try {
      body = validate(op, normalizeCommandInputForIdempotencyMode(binding, request.input, idempotencyEnabled));
    } catch (error) {
      throw new SpaceLinkExecuteFailure(isCollabError(error) ? error.code : 'invalid_input', error);
    }
    let inner: RequestContext = {
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

    // Layer (ii)'s one admission of a link identity (lead ruling (a)): this
    // context object, this op, one dispatch. Every home-side refusal above has
    // already run; a nested dispatch from inside the handler finds no marker.
    // A completer named from home (`task complete --by <home id>`) is nobody
    // in B: credit the member the link acts as there instead.
    const completerIds = await homeCompletersInB(op, inner.body, [claims.actorId, row.memberId], async () =>
      (await deps.db.query<{ id: string | null }>(await claimsOf(inner),
        'select internal.current_member_id($1)::text as id', [row.targetSpaceId]))[0]?.id ?? null);
    if (completerIds) inner = { ...inner, body: { ...(inner.body as Record<string, unknown>), completerIds } };

    admitLinkInvoke(inner, op);
    let result: Awaited<ReturnType<OperationHandler>>;
    try {
      result = await handler(inner);
    } catch (error) {
      // An actor B refused (300) is one the caller named itself: say what to do.
      const refusal = actorRefusalThroughLink(error, row);
      if (refusal) throw new SpaceLinkExecuteFailure(auditReasonOf(refusal), refusal);
      throw error;
    }
    let data: unknown = result;
    if (isHandlerResult(result)) {
      if (result.kind !== 'json') {
        throw new SpaceLinkExecuteFailure('raw_result',
          new CollabError('invalid_input', `${op} returns bytes and cannot run through a space link`));
      }
      data = result.data;
    }
    if (!SPACE_LINK_SPAWN_OPS.includes(op)) return { data, requestId: inner.requestId };

    // W7b: the child's provenance in B, under the link session's own claims.
    // The child is already running, so a failed record is audited in A
    // (`provenance_unrecorded`) rather than thrown: the caller must not retry
    // a spawn that happened. Its auth session carries via_link_id regardless.
    const spawnedSessionId = spawnedSessionOf(op, request.params, data);
    let provenanceUnrecorded = false;
    if (spawnedSessionId) {
      try {
        await store.recordSpawn(await claimsOf(inner), {
          workSessionId: spawnedSessionId, op, sourceSessionId: request.workSessionId,
        });
      } catch (error) {
        provenanceUnrecorded = true;
        console.warn('[space-link] cross-space spawn provenance was not recorded', {
          linkId: row.linkId, op, workSessionId: spawnedSessionId,
          code: isCollabError(error) ? error.code : 'internal',
        });
      }
    }
    return { data, requestId: inner.requestId, spawnedSessionId, provenanceUnrecorded };
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
    const forwarder = options.forwarder ?? deps.remoteInvokeForwarder;
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

    // 2. The refused set (the spawn switch waits for the row, step 5).
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
    // Fail closed: only a row that says allow_spawn is true lets a spawn op on.
    const late = spaceLinkRefusal(requested, binding.kind, input, row.allowSpawn === true);
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
        input: withoutHomeActor(input, ctx.identity.actorId), via, homeSpaceId, workSessionId });
    } catch (error) {
      if (error instanceof SpaceLinkExecuteFailure) {
        await audit('error', error.reason).catch(() => undefined);
        throw error.error;
      }
      await audit('error', auditReasonOf(error)).catch(() => undefined);
      throw error;
    }
    const { data, requestId, spawnedSessionId, provenanceUnrecorded } = outcome;
    // A spawn has already happened by now: a failed audit insert must not turn
    // it into an error the caller retries into a second child (review of #993).
    // The audit stays best-effort for spawns, like the provenance record.
    const recorded = audit('ok', provenanceUnrecorded ? 'provenance_unrecorded' : null,
      spawnedSessionId ?? remoteIdOf(data) ?? requestId);
    const auditId = spawnedSessionId ? await recorded.catch(() => '') : await recorded;
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

/** The audit column's own shape (260): a closed reason, never text. */
const AUDIT_REASON_RE = /^[a-z0-9_.]{1,80}$/;

/**
 * The audit reason for an error B raised: B's closed `details.reason` when it
 * names one (`actor_not_permitted`, `cross_space_edge`), for every error, so a
 * refusal can be told apart from any other after the fact; else its code.
 * Never B's text.
 */
export function auditReasonOf(error: unknown): string {
  if (!isCollabError(error)) return 'internal';
  const reason = error.details?.['reason'];
  return typeof reason === 'string' && AUDIT_REASON_RE.test(reason) ? reason : error.code;
}

/**
 * B refused the actor a write named (resolve_actor, 300: `actor_not_permitted`).
 * Through a link that is an actor the caller set itself (`--as`, or an
 * `actorId` other than its home actor, which is already dropped): re-typed
 * with what to do, since the bare "not permitted to act as this actor" sent
 * agents guessing. Anything else: null, B's error stands.
 */
export function actorRefusalThroughLink(error: unknown, row: SpaceLinkInvokeRow | null): CollabError | null {
  if (!row || !isCollabError(error) || error.code !== 'forbidden' || error.details?.['reason'] !== 'actor_not_permitted') {
    return null;
  }
  const actorId = typeof error.details['actorId'] === 'string' ? error.details['actorId'] : 'the requested actor';
  return new CollabError('forbidden',
    `through space link ${row.linkId} you act in space ${row.targetSpaceId} as the member who made the link, `
      + `and ${actorId} is not an actor that member can act as there (an id from your own space never is): `
      + 'drop --as (and any actorId) and the link acts as that member, or pass --as with an actor of the linked space',
    { details: { ...error.details, linkId: row.linkId, targetSpaceId: row.targetSpaceId } });
}

/**
 * `entities.commands.complete` through a link: the completer ids with every
 * HOME id (the caller's own actor, or the launching member's row in A) put
 * back as the member the link acts as in B. A session's CLI suggests its own
 * team member for `--by`, and B's complete_task refused any id outside B as
 * "invalid completer". Null when nothing names home (B authorizes the rest
 * as before). Refused, with what to do, when B has no member to credit.
 */
export async function homeCompletersInB(
  op: OperationName,
  body: unknown,
  homeIds: ReadonlyArray<string | null | undefined>,
  memberInB: () => Promise<string | null>,
): Promise<string[] | null> {
  if (op !== 'entities.commands.complete' || typeof body !== 'object' || body === null) return null;
  const ids = (body as Record<string, unknown>)['completerIds'];
  if (!Array.isArray(ids)) return null;
  const home = new Set(homeIds.filter((id): id is string => typeof id === 'string').map((id) => id.toLowerCase()));
  if (!ids.some((id) => typeof id === 'string' && home.has(id.toLowerCase()))) return null;
  const member = await memberInB();
  if (!member) {
    throw new CollabError('invalid_input',
      'a completer from your own space is nobody in the linked space, and the link has no member there to credit: '
        + 'pass --by with a member or teammate id of the linked space',
      { details: { reason: 'home_completer' } });
  }
  const out: string[] = [];
  for (const id of ids as unknown[]) {
    const next = typeof id === 'string' && home.has(id.toLowerCase()) ? member : id;
    if (typeof next === 'string' && !out.includes(next)) out.push(next);
  }
  return out;
}
