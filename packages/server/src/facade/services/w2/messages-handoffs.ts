import { createHash } from 'node:crypto';

import {
  CollabError,
  decodeCursor,
  encodeCursor,
  isCollabError,
  type AddMessageAttachmentsInput,
  type DeleteMessageInput,
  type HandoffDeliveryStatus,
  type HandoffRecordStatus,
  type HandoffView,
  type MessageDeliveryRecord,
  type MessageDeliveryStatus,
  type MessageDeliveryView,
  type MessageView,
  type Page,
  type PatchMessageInput,
  type PostMessageInput,
  type SendHandoffInput,
  type WithdrawHandoffInput,
} from '@tm8/contract';
import { incomingMessageInjection, utf8Bytes } from '@tm8/prompt';

import { MICROS } from '../../entity-read.js';
import type { DbClaims, Querier } from '../../../db/types.js';
import type { OperationHandler, RequestContext } from '../../../http/types.js';
import {
  claimsFor,
  commandEnvelope,
  limitOf,
  requireParam,
  requireUuidParam,
} from '../../context.js';
import type { FacadeDeps } from '../../deps.js';
import { loadMessageViewsByIds } from '../../handlers/messages.js';

export interface ReservedMessageDelivery {
  readonly deliveryId: string;
  readonly messageId: string;
  readonly targetWorkSessionId: string;
  readonly reservationVersion: number;
  readonly expiresAt: string;
  readonly content: string;
  readonly mode: 'send' | 'paste';
}

export interface MessageDeliveryIntent {
  readonly messageId: string;
  readonly targetWorkSessionId: string;
  readonly content: string;
  readonly mode: 'send' | 'paste';
}

export interface MessageDeliveryReservationIntent extends MessageDeliveryIntent {
  readonly requestId: string;
}

export interface ReservedMessageDeliveryAttempt extends ReservedMessageDelivery {
  readonly requestId: string;
  readonly principal: unknown;
}

export interface MessageDeliveryDispatchOutcome {
  readonly outcome: 'delivered' | 'refused' | 'unknown';
  readonly reason?: string;
}

export interface PreReservedMessageDeliveryAdapter {
  dispatch(attempt: ReservedMessageDeliveryAttempt): Promise<MessageDeliveryDispatchOutcome>;
}

export interface HandoffDispatch {
  readonly handoffId: string;
  readonly requestId: string;
  readonly targetWorkSessionId: string;
  readonly sessionEpoch: string | null;
  readonly envelopeHash: string;
  readonly content: string;
  readonly mode: 'send' | 'paste';
}

export interface HandoffDeliveryAdapter {
  /** Resolves only after the real proc.write attempt or an explicit refusal. */
  writeAttempt(dispatch: HandoffDispatch): Promise<MessageDeliveryDispatchOutcome>;
}

export interface W2MessagesHandoffsServiceOptions {
  /** Server-owned provenance resolver; request bodies and headers are never consulted. */
  readonly resolveAuthoredFromWorkSessionId?: (ctx: RequestContext) => Promise<string | null>;
  /** Server-owned first-attempt PTY epoch; never accepted from request input. */
  readonly resolveTargetWorkSessionEpoch?: (
    targetWorkSessionId: string,
    ctx: RequestContext,
  ) => Promise<string | null>;
  readonly messageDelivery?: {
    /** G11 owns contact authorization, B2, and the existing reserve RPC. */
    readonly reserve: (
      intent: MessageDeliveryReservationIntent,
    ) => Promise<ReservedMessageDelivery | null>;
    readonly adapter: PreReservedMessageDeliveryAdapter;
    readonly principalFor: (reservation: ReservedMessageDelivery) => unknown;
  };
  readonly handoffDelivery?: HandoffDeliveryAdapter;
}

interface BatchRpcResult {
  readonly messageBatchId: string;
  readonly messageIds: string[];
  readonly deliveryIntents?: MessageDeliveryIntent[];
}

interface SessionReplyRoute {
  readonly targetMessageId: string;
  readonly targetWorkSessionId: string;
  readonly messageBatchId: string;
  readonly senderActorId: string;
  readonly senderActorKind: 'member' | 'team_member';
  readonly sourceAnchorId: string;
  readonly sourceAnchorKind: string;
  readonly sourceMessageId: string;
  readonly threadParentMessageId: string | null;
  readonly threadRootMessageId: string;
  readonly body: string;
  readonly addressingKind: 'channel_mention' | 'direct_message' | 'anchored_message';
  readonly contextAnchors: ReadonlyArray<{ id: string; kind: string }>;
  readonly rollingControlMaxBytes: number;
  readonly sessionInputAllowed: boolean;
}

interface ResolvedSessionReply {
  readonly anchorId: string;
  readonly parentMessageId: string;
  readonly addressingKind: SessionReplyRoute['addressingKind'];
}

interface MessageCommandRpcResult {
  readonly messageId: string;
}

interface DeliveryRow {
  id: string;
  message_id: string;
  source_work_session_id: string | null;
  target_work_session_id: string;
  status: string;
  attempt_no: number;
  failure_reason: string | null;
  reserved_at: Date | string;
  claimed_at: Date | string | null;
  settled_at: Date | string | null;
  updated_at: Date | string;
}

interface PrepareHandoffRpcResult {
  readonly handoff: HandoffView;
  readonly dispatch: HandoffDispatch | null;
}

type ClaimHandoffRpcResult =
  | { readonly state: 'claimed' }
  | { readonly state: 'settled'; readonly handoff: HandoffView };

interface HandoffListRow {
  readonly view: HandoffView;
  /**
   * The keyset value, as microsecond TEXT straight from Postgres.
   *
   * THE TELL THIS FIELD USED TO CARRY: it was typed `Date | string` and the
   * query selected `h.created_at` RAW. A `to_char` column is TEXT and can only
   * ever be a string — admitting `Date` is the signature of a raw `timestamptz`
   * wearing the safe name, and it is exactly what let `iso()` be applied to it
   * without a type error. The name looked like the defended pattern in
   * edges-placements and entities-commands-tracking; the treatment was not.
   * That is the shape that survives review, so it is called out here rather
   * than quietly corrected: prefer `cursor_*: string`, required.
   */
  readonly cursor_created_at: string;
  readonly id?: string;
}

interface RequestAccess {
  readonly claims: DbClaims;
  readonly viewerIdentityId: string;
}

interface PendingHandoff {
  readonly fingerprint: string;
  readonly promise: Promise<HandoffView>;
}

const DELIVERY_STATUSES = new Set<MessageDeliveryStatus>([
  'pending', 'dispatching', 'delivered', 'failed_retryable',
  'failed_permanent', 'unknown', 'expired', 'cancelled',
]);
const HANDOFF_DELIVERY_STATUSES = new Set<HandoffDeliveryStatus>([
  'prepared', 'dispatching', 'delivered', 'refused', 'unknown',
]);
const HANDOFF_RECORD_STATUSES = new Set<HandoffRecordStatus>([
  'pending', 'recorded', 'failed', 'withdrawn',
]);

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isoOrNull(value: Date | string | null): string | null {
  return value === null ? null : iso(value);
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizeG04Reason(error: unknown): never {
  if (isCollabError(error)) {
    const details = error.details as Record<string, unknown> | undefined;
    const reason = typeof details?.detail === 'string' ? details.detail : undefined;
    if (reason && ['message_batch_identity_mismatch', 'handoff_forbidden'].includes(reason)) {
      const { detail: _detail, ...rest } = details ?? {};
      throw new CollabError(error.code, error.message, {
        details: { ...rest, reason },
        current: error.current,
      });
    }
  }
  throw error;
}

async function withG04Reasons<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    normalizeG04Reason(error);
  }
}

function uniqueIds(values: readonly string[], field: string, max = 16): string[] {
  const result = [...new Set(values)];
  if (result.length !== values.length || result.length > max) {
    throw new CollabError('invalid_input', `${field} must contain at most ${max} unique ids`);
  }
  return result;
}

function listValues(search: URLSearchParams, name: string): string[] {
  return search.getAll(name).flatMap((value) => value.split(',')).filter(Boolean);
}

function enumFilter<T extends string>(
  search: URLSearchParams,
  name: string,
  allowed: ReadonlySet<T>,
): T[] {
  const values = [...new Set(listValues(search, name))];
  if (values.some((value) => !allowed.has(value as T))) {
    throw new CollabError('invalid_input', `${name} contains an unsupported status`);
  }
  // Canonical order. The SQL matches with `= any(...)`, which is order
  // insensitive, so two spellings of one filter must not fingerprint
  // differently or a keyset cursor would be rejected across an equivalent
  // reordered request.
  return values.sort() as T[];
}

async function accessFor(
  deps: FacadeDeps,
  ctx: RequestContext,
  mutation = false,
): Promise<RequestAccess> {
  const owner = await deps.owner();
  if (ctx.identity.kind === 'anonymous') {
    throw new CollabError('unauthenticated', 'authentication is required');
  }
  const viewerIdentityId = ctx.identity.kind === 'auto-owner'
    ? owner.identityId
    : ctx.identity.identityId;
  if (!viewerIdentityId) {
    throw new CollabError('unauthenticated', 'bearer identity is unresolved');
  }
  const base = claimsFor(owner, ctx, mutation ? commandEnvelope(ctx) : {});
  return {
    viewerIdentityId,
    claims: {
      ...base,
      identityId: viewerIdentityId,
      nodeAdmin: viewerIdentityId === owner.identityId ? owner.isNodeAdmin : false,
    },
  };
}

async function loadOneMessage(
  q: Querier,
  id: string,
  viewerIdentityId: string,
): Promise<MessageView> {
  const message = (await loadMessageViewsByIds(q, [id], viewerIdentityId))[0];
  if (!message) throw new CollabError('not_found', `no readable message: ${id}`);
  return message;
}

function deliveryRecord(row: DeliveryRow): MessageDeliveryRecord {
  if (!DELIVERY_STATUSES.has(row.status as MessageDeliveryStatus)) {
    throw new CollabError('upstream_unavailable', 'stored delivery has an invalid status');
  }
  return {
    deliveryId: row.id,
    messageId: row.message_id,
    sourceWorkSessionId: row.source_work_session_id,
    targetWorkSessionId: row.target_work_session_id,
    status: row.status as MessageDeliveryStatus,
    attemptNo: Number(row.attempt_no),
    failureReason: row.failure_reason,
    reservedAt: iso(row.reserved_at),
    claimedAt: isoOrNull(row.claimed_at),
    settledAt: isoOrNull(row.settled_at),
    updatedAt: iso(row.updated_at),
  };
}

export class W2MessagesHandoffsService {
  private readonly pendingHandoffs = new Map<string, PendingHandoff>();

  constructor(
    private readonly deps: FacadeDeps,
    private readonly options: W2MessagesHandoffsServiceOptions = {},
  ) {}

  readonly post: OperationHandler = async (ctx) => {
    const input = ctx.body as PostMessageInput;
    const { claims, viewerIdentityId } = await accessFor(this.deps, ctx, true);
    const sourceWorkSessionId = this.options.resolveAuthoredFromWorkSessionId
      ? await this.options.resolveAuthoredFromWorkSessionId(ctx)
      : null;
    const requestedAnchorIds = uniqueIds(input.anchorIds, 'anchorIds');
    const mentionIds = uniqueIds(input.mentionIds ?? [], 'mentionIds');
    const attachmentIds = uniqueIds(input.attachmentIds ?? [], 'attachmentIds');
    if (!input.replyToMessageId && requestedAnchorIds.length === 0) {
      throw new CollabError('invalid_input', 'anchorIds must not be empty');
    }
    if (input.replyToMessageId && !sourceWorkSessionId) {
      throw new CollabError('forbidden', 'message reply requires a work-session-bound credential');
    }
    if (Math.max(1, requestedAnchorIds.length) * attachmentIds.length > 64) {
      throw new CollabError('invalid_input', 'anchor × attachment pairs must not exceed 64');
    }

    const stored = await withG04Reasons(() => this.deps.db.tx(claims, async (q) => {
      let anchorIds = requestedAnchorIds;
      let parentMessageId = input.parentMessageId ?? null;
      if (input.replyToMessageId) {
        const resolved = await q.rpc<ResolvedSessionReply>('w2_resolve_session_message_reply', [
          input.replyToMessageId,
          sourceWorkSessionId,
        ]);
        anchorIds = [resolved.anchorId];
        parentMessageId = resolved.parentMessageId;
      }
      const result = await q.rpc<BatchRpcResult>('w2_post_message_batch', [
        anchorIds,
        input.body,
        parentMessageId,
        mentionIds,
        attachmentIds,
        sourceWorkSessionId,
        input.actorId ?? null,
        input.clientMutationId,
      ]);
      const routeResult = await q.rpc<SessionReplyRoute[]>('w2_record_session_message_routes', [
        result.messageIds,
        input.replyToMessageId ? anchorIds[0] : input.conversationAnchorId ?? null,
      ]);
      const routes = Array.isArray(routeResult) ? routeResult : [];
      const messages = await loadMessageViewsByIds(q, result.messageIds, viewerIdentityId);
      if (messages.length !== result.messageIds.length) {
        throw new CollabError('upstream_unavailable', 'stored message batch could not be reloaded');
      }
      // D1b — the parent-message excerpt. Routes carry the thread parent as an
      // ID only; load the bodies here, in the same tx, under the SAME viewer
      // claims (RLS-safe: an unreadable parent is simply absent from the map,
      // so its delivery renders without an excerpt — never an error).
      const parentIds = [
        ...new Set(
          routes
            .map((route) => route.threadParentMessageId)
            .filter((id): id is string => id != null),
        ),
      ];
      const parentViews =
        parentIds.length > 0 ? await loadMessageViewsByIds(q, parentIds, viewerIdentityId) : [];
      const parentsById = new Map(parentViews.map((view) => [view.id, view]));
      return { result, messages, routes, parentsById };
    }));

    // The transaction above has committed. Dispatch may block on a PTY write,
    // so it must never execute while graph row locks are held.
    //
    // NOT AWAITED PAST reserve(): `adapter.dispatch()` now waits for the PTY
    // closed loop's REAL outcome (promptInternal / PromptSettlementWaiter,
    // packages/execution + facade/services/w2/execution.ts) before it settles,
    // which can legitimately take from milliseconds to tens of seconds on a
    // cold spawn. This is the messages.post HTTP response path — it must stay
    // bounded and independent of agent TUI behavior, so only the fast, durable
    // `reserve()` claim is awaited here. `dispatch()` still runs to completion
    // and still calls settle exactly once; this request's response just no
    // longer blocks on watching it do so.
    if (this.options.messageDelivery) {
      for (const route of stored.routes) {
        if (!route.sessionInputAllowed || route.targetWorkSessionId === sourceWorkSessionId) continue;
        const parent = route.threadParentMessageId
          ? stored.parentsById.get(route.threadParentMessageId)
          : undefined;
        const render = (deliveryAttemptId: string) => incomingMessageInjection({
          kind: route.addressingKind,
          messageId: route.targetMessageId,
          messageBatchId: route.messageBatchId,
          deliveryAttemptId,
          deliveryAttemptNo: 1,
          senderActorId: route.senderActorId,
          senderActorKind: route.senderActorKind,
          senderAttribution: 'verified',
          sourceSessionId: sourceWorkSessionId,
          destinationSessionId: route.targetWorkSessionId,
          sourceAnchorId: route.sourceAnchorId,
          sourceAnchorKind: route.sourceAnchorKind,
          sourceMessageId: route.sourceMessageId,
          contextAnchors: route.contextAnchors,
          threadParentMessageId: route.threadParentMessageId,
          threadRootMessageId: route.threadRootMessageId,
          body: route.body,
          ...(parent
            ? {
                parentBody: parent.content.body,
                parentAuthorDisplay: parent.state.author.displayName,
              }
            : {}),
        });
        try {
          const preview = render('00000000-0000-4000-8000-000000000000');
          if (utf8Bytes(preview) > route.rollingControlMaxBytes) continue;
          const reservation = await this.options.messageDelivery.reserve({
            messageId: route.targetMessageId,
            targetWorkSessionId: route.targetWorkSessionId,
            content: preview,
            mode: 'send',
            requestId: ctx.requestId,
          });
          if (!reservation) continue;
          const content = render(reservation.deliveryId);
          void this.options.messageDelivery.adapter
            .dispatch({
              ...reservation,
              content,
              requestId: ctx.requestId,
              principal: this.options.messageDelivery.principalFor(reservation),
            })
            .catch(() => {
              // Same posture as the try/catch this replaces: the durable row
              // remains pending/dispatching for the existing maintenance owner
              // to expire or recover. Stored-first means an adapter outage
              // cannot roll back or disguise the message command.
            });
        } catch {
          // reserve() itself failing is the one case still caught synchronously
          // here; dispatch()'s own failures are caught on its own promise above.
        }
      }
    }

    return {
      messageBatchId: stored.result.messageBatchId,
      messages: stored.messages,
    };
  };

  readonly edit: OperationHandler = async (ctx) => {
    const id = requireUuidParam(ctx, 'id');
    const input = ctx.body as PatchMessageInput;
    // ABSENT AND EMPTY ARE DIFFERENT INPUTS AND MUST STAY DIFFERENT.
    // `w2_edit_message` reads NULL as "the caller said nothing about mentions,
    // leave them alone" and an empty array as "the caller said: none". Writing
    // `input.mentions ?? []` here collapses the first into the second BEFORE
    // the RPC is called, which makes the preserve branch unreachable from the
    // API and silently wipes stored mentions on any edit that did not restate
    // them. The absent case is therefore threaded AROUND `uniqueIds` — which
    // needs an array — rather than through it, and validation still applies to
    // every value the caller actually sent, including an explicit `[]`.
    const mentionIds = input.mentions === undefined
      ? null
      : uniqueIds(input.mentions.map((mention) => mention.entityId), 'mentions');
    const { claims, viewerIdentityId } = await accessFor(this.deps, ctx, true);
    return this.deps.db.tx(claims, async (q) => {
      const result = await q.rpc<MessageCommandRpcResult>('w2_edit_message', [
        id, input.body, mentionIds, input.expectedVersion,
        input.actorId ?? null, input.clientMutationId,
      ]);
      return loadOneMessage(q, result.messageId, viewerIdentityId);
    });
  };

  readonly delete: OperationHandler = async (ctx) => {
    const id = requireUuidParam(ctx, 'id');
    const input = ctx.body as DeleteMessageInput;
    const { claims, viewerIdentityId } = await accessFor(this.deps, ctx, true);
    return this.deps.db.tx(claims, async (q) => {
      const result = await q.rpc<MessageCommandRpcResult>('w2_tombstone_message', [
        id, input.expectedVersion, input.actorId ?? null, input.clientMutationId,
      ]);
      return loadOneMessage(q, result.messageId, viewerIdentityId);
    });
  };

  readonly attachmentsAdd: OperationHandler = async (ctx) => {
    return this.updateAttachments(ctx, 'w2_add_message_attachments');
  };

  readonly attachmentsRemove: OperationHandler = async (ctx) => {
    return this.updateAttachments(ctx, 'w2_remove_message_attachments');
  };

  private async updateAttachments(
    ctx: RequestContext,
    rpcName: 'w2_add_message_attachments' | 'w2_remove_message_attachments',
  ): Promise<MessageView> {
    const id = requireUuidParam(ctx, 'messageId');
    const input = ctx.body as AddMessageAttachmentsInput;
    const fileIds = uniqueIds(input.fileEntityIds, 'fileEntityIds');
    if (fileIds.length === 0) throw new CollabError('invalid_input', 'fileEntityIds must not be empty');
    const { claims, viewerIdentityId } = await accessFor(this.deps, ctx, true);
    return this.deps.db.tx(claims, async (q) => {
      const result = await q.rpc<MessageCommandRpcResult>(rpcName, [
        id, fileIds, input.expectedVersion, null, input.clientMutationId,
      ]);
      return loadOneMessage(q, result.messageId, viewerIdentityId);
    });
  }

  readonly deliveryGet: OperationHandler = async (ctx) => {
    const messageId = requireUuidParam(ctx, 'messageId');
    const { claims, viewerIdentityId } = await accessFor(this.deps, ctx);
    const limit = Math.min(limitOf(ctx.query.get('limit'), 50), 100);
    const fp = fingerprint({ operation: 'messages.delivery.get', messageId });
    const params: unknown[] = [messageId];
    let keyset = '';
    const cursor = ctx.query.get('cursor');
    if (cursor) {
      const { k } = decodeCursor(cursor);
      if (k.length !== 3 || k[0] !== fp) {
        throw new CollabError('invalid_cursor', 'cursor does not match this delivery list');
      }
      params.push(String(k[1]), String(k[2]));
      keyset = `and (reserved_at,delivery_id) > ($2::timestamptz,$3::uuid)`;
    }
    return this.deps.db.tx(claims, async (q) => {
      const message = await loadOneMessage(q, messageId, viewerIdentityId);
      const rows = await q.query<DeliveryRow>(
        `select delivery_id id,message_id,source_work_session_id,target_work_session_id,status,
                attempt_no,failure_reason,reserved_at,claimed_at,settled_at,updated_at
           from public.session_message_deliveries
          where message_id=$1 ${keyset}
          order by reserved_at asc,delivery_id asc limit ${limit}`,
        params,
      );
      return { message, deliveries: rows.map(deliveryRecord) } satisfies MessageDeliveryView;
    });
  };

  readonly handoffSend: OperationHandler = async (ctx) => {
    const targetWorkSessionId = requireUuidParam(ctx, 'workSessionId');
    const input = ctx.body as SendHandoffInput;
    const { claims } = await accessFor(this.deps, ctx, true);
    const sessionEpoch = this.options.resolveTargetWorkSessionEpoch
      ? await this.options.resolveTargetWorkSessionEpoch(targetWorkSessionId, ctx)
      : null;
    const prepared = await withG04Reasons(() => this.deps.db.tx(claims, (q) =>
      q.rpc<PrepareHandoffRpcResult>('w2_prepare_handoff', [
        input.clientMutationId,
        input.sourceEntityId,
        targetWorkSessionId,
        null, // expectedContentVersion-as-submitted: v1 DTO has no such field.
        null,
        sessionEpoch,
      ])));
    if (!prepared.dispatch || !this.options.handoffDelivery) return prepared.handoff;
    return this.dispatchHandoff(claims, prepared.dispatch);
  };

  private dispatchHandoff(claims: DbClaims, dispatch: HandoffDispatch): Promise<HandoffView> {
    const fp = fingerprint(dispatch);
    const existing = this.pendingHandoffs.get(dispatch.handoffId);
    if (existing) {
      if (existing.fingerprint !== fp) {
        return Promise.reject(new CollabError('invalid_input', 'handoff dispatch identity mismatch'));
      }
      return existing.promise;
    }
    const promise = this.runHandoffDispatch(claims, dispatch);
    const pending = { fingerprint: fp, promise };
    this.pendingHandoffs.set(dispatch.handoffId, pending);
    const cleanup = (): void => {
      if (this.pendingHandoffs.get(dispatch.handoffId) === pending) {
        this.pendingHandoffs.delete(dispatch.handoffId);
      }
    };
    void promise.then(cleanup, cleanup);
    return promise;
  }

  private async runHandoffDispatch(
    claims: DbClaims,
    dispatch: HandoffDispatch,
  ): Promise<HandoffView> {
    const claim = await this.deps.db.rpc<ClaimHandoffRpcResult>(
      claims,
      'w2_claim_handoff_dispatch',
      [dispatch.handoffId, dispatch.envelopeHash, dispatch.sessionEpoch],
    );
    if (claim.state === 'settled') return claim.handoff;

    let outcome: MessageDeliveryDispatchOutcome;
    try {
      outcome = await this.options.handoffDelivery!.writeAttempt(dispatch);
    } catch {
      outcome = { outcome: 'unknown', reason: 'write_attempt_failed' };
    }
    return this.deps.db.rpc<HandoffView>(claims, 'w2_settle_handoff', [
      dispatch.handoffId,
      outcome.outcome,
      outcome.reason ?? null,
      dispatch.envelopeHash,
      dispatch.sessionEpoch,
    ]);
  }

  readonly handoffList: OperationHandler = async (ctx) => {
    const targetWorkSessionId = requireUuidParam(ctx, 'workSessionId');
    const { claims } = await accessFor(this.deps, ctx);
    const deliveryStatuses = enumFilter(ctx.query, 'deliveryStatus', HANDOFF_DELIVERY_STATUSES);
    const recordStatuses = enumFilter(ctx.query, 'recordStatus', HANDOFF_RECORD_STATUSES);
    const limit = Math.min(limitOf(ctx.query.get('limit'), 50), 100);
    const fp = fingerprint({
      operation: 'handoffs.list', targetWorkSessionId, deliveryStatuses, recordStatuses,
    });
    const params: unknown[] = [targetWorkSessionId, deliveryStatuses, recordStatuses];
    let keyset = '';
    const cursor = ctx.query.get('cursor');
    if (cursor) {
      const { k } = decodeCursor(cursor);
      if (k.length !== 3 || k[0] !== fp) {
        throw new CollabError('invalid_cursor', 'cursor does not match this handoff list');
      }
      params.push(String(k[1]), String(k[2]));
      keyset = `and (h.created_at,h.handoff_id) > ($4::timestamptz,$5::text)`;
    }
    const rows = await this.deps.db.query<HandoffListRow>(
      claims,
      `select internal.w2_handoff_view_json(h.handoff_id) view,
              ${MICROS('h.created_at')} cursor_created_at,
              h.handoff_id id
         from public.session_handoffs h
        where h.target_work_session_id=$1
          and (cardinality($2::text[])=0 or h.delivery_status=any($2::text[]))
          and (cardinality($3::text[])=0 or h.record_status=any($3::text[]))
          ${keyset}
        order by h.created_at asc,h.handoff_id asc limit ${limit + 1}`,
      params,
    );
    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const last = pageRows.at(-1);
    return {
      items: pageRows.map((row) => row.view),
      nextCursor: hasMore && last?.cursor_created_at && last.id
        // Carried verbatim — never through a JS Date. See HandoffListRow.
        ? encodeCursor([fp, last.cursor_created_at, last.id])
        : null,
    } satisfies Page<HandoffView>;
  };

  readonly handoffWithdraw: OperationHandler = async (ctx) => {
    const handoffId = requireParam(ctx, 'handoffId');
    const input = ctx.body as WithdrawHandoffInput;
    const { claims } = await accessFor(this.deps, ctx, true);
    return withG04Reasons(() => this.deps.db.rpc<HandoffView>(claims, 'w2_withdraw_handoff', [
      handoffId,
      input.expectedRecordVersion,
      input.reason ?? null,
      null,
      input.clientMutationId,
    ]));
  };
}
