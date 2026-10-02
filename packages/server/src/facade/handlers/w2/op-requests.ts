/**
 * `opRequests.*` (lane L5, owner decision D5, migration 280): an agent asks
 * for a human-only op, and a human approves or denies it.
 *
 * create  — any member. The op must be on the contract's allow-list
 *           (OP_REQUESTABLE); its path params must be exactly the op's, and
 *           its body must pass the op's own schema NOW, so a request a human
 *           sees is one that can run. The body's clientMutationId is the
 *           server's, never the requester's.
 * approve — HUMAN-ONLY, here and in SQL. Three steps:
 *             1. claim (SQL): pending → executing, stamped with the approver.
 *                It commits before anything runs, so two approvers can never
 *                both run the op.
 *             2. run: the op's own registered handler, IN-PROCESS, with the
 *                APPROVER'S request identity and through the same steps the
 *                HTTP frame takes (the space gate, idempotency normalisation,
 *                the op's input schema, the registry's link-bearer refusal).
 *                The agent's claims are never used. The op's own authority
 *                checks decide, so approving does not grant the approver
 *                anything they lack.
 *             3. settle (SQL): succeeded | failed, with the result or error.
 *           The allow-list is checked again before step 2: an op taken off
 *           the list after the request was filed fails rather than runs.
 * deny    — HUMAN-ONLY. Nothing runs.
 *
 * After approve or deny, the outcome is posted through `messages.post` as the
 * approver, to the requesting session and on the request, so the agent learns
 * it the way it learns any human message. A failed post never undoes the
 * decision; the response says whether the message went out.
 */
import {
  CollabError,
  OpRequestsCreateInputSchema,
  OpRequestsDecideInputSchema,
  OP_REQUEST_STATUSES,
  OP_REQUESTABLE,
  getOperation,
  isCollabError,
  isHumanAuthKind,
  isOperationName,
  opRequestMutationId,
  opRequestable,
  type OpRequestStatus,
  type OpRequestView,
  type OperationName,
} from '@tm8/contract';

import type { DbClaims } from '../../../db/types.js';
import { normalizeCommandInputForIdempotencyMode } from '../../../http/idempotency.js';
import { nextRequestId } from '../../../http/request-id.js';
import { assertSpaceGate } from '../../../http/space-gate.js';
import { isHandlerResult, type OperationHandler, type RequestContext } from '../../../http/types.js';
import { claimsFor } from '../../context.js';
import type { FacadeDeps } from '../../deps.js';
import { INPUT_SCHEMAS } from '../../input-schemas.js';
import type { HandlerRegistry } from '../../registry.js';

/** Typed `details.reason` values. Stable, and asserted by test. */
export const OP_REQUESTS_HUMAN_ONLY = 'op_requests_human_only';
export const OP_REQUEST_NOT_REQUESTABLE = 'op_request_not_requestable';
export const OP_REQUEST_BAD_PARAMS = 'op_request_bad_params';

/** The biggest op result stored on a request; anything larger is summarised. */
const RESULT_MAX_BYTES = 16_384;
const MESSAGE_RESULT_MAX = 1_500;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Layer 1 of the human-only rule; fails closed on an absent kind. */
export function requireHumanOpRequestSession(handler: OperationHandler): OperationHandler {
  return async (ctx) => {
    if (!isHumanAuthKind(ctx.identity.authKind)) {
      throw new CollabError(
        'forbidden',
        'only a human can approve or deny an op request',
        { details: { reason: OP_REQUESTS_HUMAN_ONLY } },
      );
    }
    return handler(ctx);
  };
}

function uuidParam(ctx: RequestContext, name: 'spaceId' | 'requestId'): string {
  const value = ctx.params[name];
  if (!value || !UUID_RE.test(value)) throw new CollabError('not_found', `${name} must be a uuid`);
  return value;
}

/** `:name` segments of an op's path, in order. */
export function opPathParams(path: string): string[] {
  return path.split('/').filter((segment) => segment.startsWith(':')).map((segment) => segment.slice(1));
}

/**
 * The op's path params, exactly. A missing `:spaceId` defaults to the
 * request's own Space; anything else missing or extra is refused.
 */
function resolveParams(op: OperationName, spaceId: string, given: Record<string, string> | undefined): Record<string, string> {
  const names = opPathParams(getOperation(op).path);
  const params: Record<string, string> = { ...(given ?? {}) };
  if (names.includes('spaceId') && params['spaceId'] === undefined) params['spaceId'] = spaceId;
  const missing = names.filter((name) => params[name] === undefined);
  const extra = Object.keys(params).filter((name) => !names.includes(name));
  if (missing.length > 0 || extra.length > 0) {
    throw new CollabError('invalid_input', `${op} takes path params ${names.length ? names.join(', ') : '(none)'}`, {
      details: { reason: OP_REQUEST_BAD_PARAMS, expected: names, missing, extra },
    });
  }
  return params;
}

/** The op's body as it will run: the request's input plus the server's mutation id. */
function opBody(op: OperationName, requestId: string, input: Record<string, unknown>): Record<string, unknown> {
  return getOperation(op).kind === 'command'
    ? { ...input, clientMutationId: opRequestMutationId(requestId) }
    : { ...input };
}

function validateOpBody(op: OperationName, body: unknown): unknown {
  const schema = INPUT_SCHEMAS[op];
  if (!schema) return body;
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  throw new CollabError('invalid_input', `the body does not fit ${op}`, {
    details: { issues: parsed.error.issues },
  });
}

function compact(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

/** "Link a space: spaceId=…, targetSpaceId=…, alias=…". */
export function opRequestTitle(label: string, params: Record<string, string>, input: Record<string, unknown>): string {
  const facts = [...Object.entries(params), ...Object.entries(input)]
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${compact(value)}`);
  const title = facts.length > 0 ? `${label}: ${facts.join(', ')}` : label;
  return title.length > 480 ? `${title.slice(0, 477)}...` : title;
}

function storedResult(data: unknown): unknown {
  if (data === undefined) return null;
  const text = JSON.stringify(data);
  if (text === undefined) return null;
  return text.length <= RESULT_MAX_BYTES ? data : { truncated: true, bytes: text.length };
}

function errorOf(error: unknown): { code: string; message: string } {
  if (isCollabError(error)) return { code: error.code, message: error.message };
  return { code: 'internal', message: error instanceof Error ? error.message : 'the op failed' };
}

/** The message the requesting agent receives. */
export function outcomeMessage(request: OpRequestView): string {
  const head = `Your op request ${request.id} (${request.label}, \`${request.op}\`)`;
  const note = request.decisionNote ? `\nNote from the approver: ${request.decisionNote}` : '';
  switch (request.status) {
    case 'succeeded': {
      const result = request.result === null || request.result === undefined ? '' : JSON.stringify(request.result);
      const shown = result.length > MESSAGE_RESULT_MAX ? `${result.slice(0, MESSAGE_RESULT_MAX)}...` : result;
      return `${head} was APPROVED and ran as the approver. It succeeded.${note}${shown ? `\nResult: ${shown}` : ''}`;
    }
    case 'failed':
      return `${head} was APPROVED, but the op FAILED when it ran as the approver: ` +
        `${request.error?.code ?? 'unknown'}: ${request.error?.message ?? ''}${note}`;
    case 'denied':
      return `${head} was DENIED. Nothing ran.${note}`;
    default:
      return `${head} is ${request.status}.`;
  }
}

export interface OpRequestDecision {
  request: OpRequestView;
  /** Whether the outcome message was posted to the requesting session. */
  notified: boolean;
  /** `messages.post`'s per-session delivery answer for that message. */
  delivery?: unknown[];
  notifyError?: { code: string; message: string };
}

export function registerOpRequestHandlers(registry: HandlerRegistry, deps: FacadeDeps): void {
  const spaceSessions = deps.config.spaceSessions ?? 'agents';
  const idempotencyEnabled = deps.config.idempotencyEnabled !== false;

  const claimsOf = async (ctx: RequestContext): Promise<DbClaims> => {
    const claims = claimsFor(await deps.owner(), ctx);
    if (!claims.identityId) throw new CollabError('unauthenticated', 'no identity resolved for this request');
    return claims;
  };

  const create: OperationHandler = async (ctx): Promise<OpRequestView> => {
    const spaceId = uuidParam(ctx, 'spaceId');
    const body = OpRequestsCreateInputSchema.parse(ctx.body);
    const entry = opRequestable(body.op);
    if (!entry || !isOperationName(entry.op)) {
      throw new CollabError('invalid_input', `${body.op} cannot be requested`, {
        details: { reason: OP_REQUEST_NOT_REQUESTABLE, requestable: OP_REQUESTABLE.map((e) => e.op) },
      });
    }
    const op = entry.op;
    const params = resolveParams(op, spaceId, body.params);
    const input = { ...(body.input ?? {}) };
    if ('clientMutationId' in input) {
      throw new CollabError('invalid_input', 'the op body must not carry clientMutationId: the server sets it');
    }
    // The body must run as written: validate it against the op's own schema now.
    validateOpBody(op, normalizeCommandInputForIdempotencyMode(
      getOperation(op), opBody(op, '00000000-0000-0000-0000-000000000000', input), idempotencyEnabled));
    const bearerSession = ctx.identity.kind === 'bearer' ? ctx.identity.workSessionId ?? null : null;
    const raw = await deps.db.rpc<{ request: OpRequestView }>(await claimsOf(ctx), 'create_op_request', [
      spaceId, op, entry.label, opRequestTitle(entry.label, params, input),
      JSON.stringify(params), JSON.stringify(input), body.justification, entry.approver,
      bearerSession, null, body.clientMutationId,
    ]);
    return raw.request;
  };

  const list: OperationHandler = async (ctx): Promise<OpRequestView[]> => {
    const spaceId = uuidParam(ctx, 'spaceId');
    const status = ctx.query.get('status');
    if (status !== null && !OP_REQUEST_STATUSES.includes(status as OpRequestStatus)) {
      throw new CollabError('invalid_input', `status must be one of ${OP_REQUEST_STATUSES.join(', ')}`);
    }
    const limitText = ctx.query.get('limit');
    const limit = limitText === null ? 50 : Number(limitText);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new CollabError('invalid_input', 'limit must be an integer from 1 to 200');
    }
    return deps.db.rpc<OpRequestView[]>(await claimsOf(ctx), 'list_op_requests', [spaceId, status, limit]);
  };

  const get: OperationHandler = async (ctx): Promise<OpRequestView> =>
    deps.db.rpc<OpRequestView>(await claimsOf(ctx), 'get_op_request', [uuidParam(ctx, 'requestId')]);

  /** Step 2 of approve: the op, as the approver, through the frame's own steps. */
  const runAsApprover = async (ctx: RequestContext, request: OpRequestView): Promise<unknown> => {
    const entry = opRequestable(request.op);
    if (!entry || !isOperationName(entry.op)) {
      throw new CollabError('forbidden', `${request.op} is no longer requestable`, {
        details: { reason: OP_REQUEST_NOT_REQUESTABLE },
      });
    }
    const op = entry.op;
    const binding = getOperation(op);
    assertSpaceGate(spaceSessions, ctx.identity, op);
    const handler = registry.get(op);
    if (!handler) throw new CollabError('not_implemented', `operation ${op} is not implemented on this node`);
    const body = validateOpBody(op, normalizeCommandInputForIdempotencyMode(
      binding, opBody(op, request.id, request.input), idempotencyEnabled));
    const inner: RequestContext = {
      op: binding,
      opName: op,
      params: { ...request.params },
      query: new URLSearchParams(),
      body,
      requestId: nextRequestId(),
      // The APPROVER: the identity on this approve call, never the requester's.
      identity: ctx.identity,
      headers: {},
      method: binding.method,
      path: binding.path,
    };
    const result = await handler(inner);
    if (isHandlerResult(result)) {
      if (result.kind !== 'json') throw new CollabError('invalid_input', `${op} returns bytes and cannot be requested`);
      return result.data;
    }
    return result;
  };

  /** The outcome, as the approver, to the requesting session and on the request. */
  const notify = async (ctx: RequestContext, request: OpRequestView): Promise<Omit<OpRequestDecision, 'request'>> => {
    const post = registry.get('messages.post');
    if (!post) return { notified: false, notifyError: { code: 'not_implemented', message: 'messages.post is not registered' } };
    const anchorIds = request.requestingSessionId ? [request.requestingSessionId, request.id] : [request.id];
    const binding = getOperation('messages.post');
    try {
      const body = validateOpBody('messages.post', normalizeCommandInputForIdempotencyMode(binding, {
        anchorIds,
        // The request is the conversation: the session copy threads under it.
        ...(anchorIds.length > 1 ? { conversationAnchorId: request.id } : {}),
        body: outcomeMessage(request),
        clientMutationId: `${opRequestMutationId(request.id)}:outcome`,
      }, idempotencyEnabled));
      const posted = await post({
        op: binding, opName: 'messages.post', params: {}, query: new URLSearchParams(), body,
        requestId: nextRequestId(), identity: ctx.identity, headers: {}, method: binding.method, path: binding.path,
      });
      const delivery = (posted as { delivery?: unknown[] } | null)?.delivery;
      return { notified: request.requestingSessionId !== null, ...(delivery ? { delivery } : {}) };
    } catch (error) {
      return { notified: false, notifyError: errorOf(error) };
    }
  };

  const approve: OperationHandler = async (ctx): Promise<OpRequestDecision> => {
    const requestId = uuidParam(ctx, 'requestId');
    const { note } = OpRequestsDecideInputSchema.parse(ctx.body);
    const claims = await claimsOf(ctx);
    const claimed = await deps.db.rpc<OpRequestView>(claims, 'claim_op_request', [requestId, note ?? null]);
    // Already decided: the answer, not a second run.
    if (claimed.status !== 'executing') return { request: claimed, notified: false };

    let settled: OpRequestView;
    try {
      const data = await runAsApprover(ctx, claimed);
      settled = await deps.db.rpc<OpRequestView>(claims, 'settle_op_request', [
        requestId, true, JSON.stringify(storedResult(data)), null,
      ]);
    } catch (error) {
      settled = await deps.db.rpc<OpRequestView>(claims, 'settle_op_request', [
        requestId, false, null, JSON.stringify(errorOf(error)),
      ]);
    }
    return { request: settled, ...await notify(ctx, settled) };
  };

  const deny: OperationHandler = async (ctx): Promise<OpRequestDecision> => {
    const requestId = uuidParam(ctx, 'requestId');
    const { note } = OpRequestsDecideInputSchema.parse(ctx.body);
    const before = await deps.db.rpc<OpRequestView>(await claimsOf(ctx), 'get_op_request', [requestId]);
    const denied = await deps.db.rpc<OpRequestView>(await claimsOf(ctx), 'deny_op_request', [requestId, note ?? null]);
    // A repeated deny answers without a second message.
    if (before.status === 'denied') return { request: denied, notified: false };
    return { request: denied, ...await notify(ctx, denied) };
  };

  registry.registerAll({
    'opRequests.create': create,
    'opRequests.list': list,
    'opRequests.get': get,
    'opRequests.approve': requireHumanOpRequestSession(approve),
    'opRequests.deny': requireHumanOpRequestSession(deny),
  });
}
