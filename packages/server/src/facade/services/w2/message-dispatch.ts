/**
 * Getting a stored message onto a live agent's terminal.
 *
 * EXTRACTED VERBATIM from the `messages.post` handler (messages-handoffs.ts),
 * because it stopped having exactly one caller. The forge watcher (103) posts
 * nudges from a background job, and a background job that writes messages but
 * cannot deliver them produces durable rows no agent ever sees — which is worse
 * than not posting, because the graph then says the agent was told.
 *
 * WHY EXTRACTION RATHER THAN A SECOND COPY. Two delivery loops drift, and the
 * one nobody looks at is the one that rots: the copy in a background job would
 * quietly stop matching the request path's rendering, budget check or
 * settlement contract, and the symptom would be "nudges sometimes don't
 * arrive". The behaviour here is byte-identical to what the request path did
 * before; this file moved it, it did not change it.
 *
 * THE ORDERING CONSTRAINTS THAT MUST SURVIVE ANY EDIT, both inherited:
 *
 *   * NEVER CALL THIS INSIDE THE TRANSACTION. Dispatch can block on a PTY
 *     write, and holding graph row locks across it is how one slow terminal
 *     stalls the database for everyone.
 *   * ONLY `reserve()` IS AWAITED. `adapter.dispatch()` waits for the PTY
 *     closed loop's real outcome, which on a cold spawn legitimately takes tens
 *     of seconds. The caller's own latency must not be hostage to agent TUI
 *     behaviour, so dispatch runs to completion on its own promise and settles
 *     exactly once; failures leave the durable row pending for the existing
 *     maintenance owner. Stored-first means an adapter outage cannot roll back
 *     or disguise the message command.
 */

import {
  BudgetExceededError,
  incomingMessageInjection,
  utf8Bytes,
  type SessionInputAttachment,
} from '@tm8/prompt';

/**
 * Only the two fields the parent-excerpt render reads. Structural rather than
 * importing MessageView, which would make this module depend on the handler it
 * was extracted from — a cycle, and the wrong direction of dependency.
 */
interface ParentMessageExcerpt {
  readonly content: { readonly body: string };
  readonly state: { readonly author: { readonly displayName: string } };
}

/** The subset of a session route this loop needs. Structural, so both callers fit. */
export interface DispatchableRoute {
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
  /**
   * The stored manifest on THIS delivered message copy. The route RPC owns it:
   * every producer therefore supplies the field, including background jobs.
   */
  readonly attachments: readonly SessionInputAttachment[];
  readonly addressingKind: 'channel_mention' | 'direct_message' | 'anchored_message';
  readonly contextAnchors: ReadonlyArray<{ id: string; kind: string }>;
  readonly rollingControlMaxBytes: number;
  readonly sessionInputAllowed: boolean;
}

export interface MessageDeliveryPort {
  reserve(intent: {
    messageId: string;
    targetWorkSessionId: string;
    content: string;
    mode: 'send' | 'paste';
    requestId: string;
  }): Promise<({ deliveryId: string } & Record<string, unknown>) | null | undefined>;
  adapter: {
    dispatch(attempt: Record<string, unknown>): Promise<unknown>;
    /** Claim and settle an attempt without a terminal write. */
    reject(attempt: Record<string, unknown>): Promise<unknown>;
  };
  principalFor(reservation: Record<string, unknown>): unknown;
}

export interface DispatchOptions {
  readonly routes: readonly DispatchableRoute[];
  readonly parentsById: ReadonlyMap<string, ParentMessageExcerpt>;
  readonly requestId: string;
  /**
   * The AUTHORING session, null exactly when attribution is `recorded_only`.
   * Also the self-delivery guard: a session must not be handed its own message.
   */
  readonly sourceWorkSessionId: string | null;
  readonly senderAttribution: 'verified' | 'recorded_only';
  readonly delivery: MessageDeliveryPort;
}

/**
 * WHAT ONE ROUTE'S COPY ACTUALLY DID, per target, for the caller to report.
 *
 * This type exists because the loop below used to return `void`, and a `void`
 * loop cannot distinguish "handed to the terminal" from "threw before writing a
 * single row" — so `messages.post` answered 200 for both, and a human who
 * steered a running worker had no way to learn that nothing was steered.
 * `execution.dispatch` has always reported this fact (`delivery: 'undelivered'`
 * — execution-handlers.ts), because `sendDispatchRequest` returns a boolean
 * instead of swallowing. The two paths now agree.
 *
 * `accepted` is deliberately NOT `delivered`. Only `reserve()` is awaited here
 * (see the header), so what this loop can honestly assert at return time is
 * that a durable reservation exists and the PTY write is in flight — the real
 * terminal outcome settles later, on the delivery row, and is read from there.
 * Claiming `delivered` would replace one lie with a smaller one.
 */
export type DeliveryDispositionStatus =
  /** Reserved and handed to the adapter; the durable row now owns the outcome. */
  | 'accepted'
  /** Deliberately not attempted: this session may not be injected, or authored it. */
  | 'skipped'
  /** Refused before or during reservation, with a reason and no live copy. */
  | 'undelivered';

export interface DeliveryDisposition {
  readonly targetMessageId: string;
  readonly targetWorkSessionId: string;
  readonly status: DeliveryDispositionStatus;
  /** Present on `skipped` and `undelivered`; a stable slug, never raw error text. */
  readonly reason?: string;
  /** Present on `accepted`, so a caller can follow the row to its settlement. */
  readonly deliveryId?: string;
}

const PREVIEW_DELIVERY_ID = '00000000-0000-4000-8000-000000000000';
const ENVELOPE_BUDGET_EXCEEDED = 'delivery_envelope_budget_exceeded';
const ENVELOPE_RENDER_FAILED = 'delivery_envelope_render_failed';
/** The target's interaction profile forbids `tm8.session-input`. */
const INJECTION_NOT_ALLOWED = 'session_input_not_allowed';
/** A session is never handed back its own message. */
const SELF_DELIVERY = 'self_delivery';
/** `reserve()` threw. The message is stored; no copy exists. */
const RESERVE_REFUSED = 'delivery_reserve_refused';
/** SQL wrote a terminal refusal at reservation time and returned nothing to send. */
const REFUSED_AT_RESERVATION = 'refused_at_reservation';

function logDispatchFailure(
  route: Pick<DispatchableRoute, 'targetMessageId' | 'targetWorkSessionId'>,
  stage: string,
  error: unknown,
): void {
  const candidate = error as { name?: unknown; message?: unknown };
  console.error(JSON.stringify({
    component: 'w2-message-dispatch',
    level: 'error',
    event: stage,
    messageId: route.targetMessageId,
    targetWorkSessionId: route.targetWorkSessionId,
    errorType: typeof candidate?.name === 'string' ? candidate.name : typeof error,
    errorMessage: typeof candidate?.message === 'string' ? candidate.message : String(error),
  }));
}

export async function dispatchSessionMessages(
  options: DispatchOptions,
): Promise<DeliveryDisposition[]> {
  const {
    routes,
    parentsById,
    requestId,
    sourceWorkSessionId,
    senderAttribution,
    delivery,
  } = options;

  const dispositions: DeliveryDisposition[] = [];
  const record = (
    route: Pick<DispatchableRoute, 'targetMessageId' | 'targetWorkSessionId'>,
    status: DeliveryDispositionStatus,
    extra?: { reason?: string; deliveryId?: string },
  ): void => {
    dispositions.push({
      targetMessageId: route.targetMessageId,
      targetWorkSessionId: route.targetWorkSessionId,
      status,
      ...(extra?.reason ? { reason: extra.reason } : {}),
      ...(extra?.deliveryId ? { deliveryId: extra.deliveryId } : {}),
    });
  };

  for (const route of routes) {
    // Both of these are correct silences, not failures — but they are still
    // REPORTED, because "the route existed and nothing was sent" is exactly the
    // fact a caller was previously unable to see.
    if (!route.sessionInputAllowed) {
      record(route, 'skipped', { reason: INJECTION_NOT_ALLOWED });
      continue;
    }
    if (route.targetWorkSessionId === sourceWorkSessionId) {
      record(route, 'skipped', { reason: SELF_DELIVERY });
      continue;
    }
    const parent = route.threadParentMessageId
      ? parentsById.get(route.threadParentMessageId)
      : undefined;
    const render = (deliveryAttemptId: string): string =>
      incomingMessageInjection({
        kind: route.addressingKind,
        messageId: route.targetMessageId,
        messageBatchId: route.messageBatchId,
        deliveryAttemptId,
        deliveryAttemptNo: 1,
        senderActorId: route.senderActorId,
        senderActorKind: route.senderActorKind,
        senderAttribution,
        sourceSessionId: sourceWorkSessionId,
        destinationSessionId: route.targetWorkSessionId,
        sourceAnchorId: route.sourceAnchorId,
        sourceAnchorKind: route.sourceAnchorKind,
        sourceMessageId: route.sourceMessageId,
        contextAnchors: route.contextAnchors,
        threadParentMessageId: route.threadParentMessageId,
        threadRootMessageId: route.threadRootMessageId,
        body: route.body,
        attachments: route.attachments,
        ...(parent
          ? {
              parentBody: parent.content.body,
              parentAuthorDisplay: parent.state.author.displayName,
            }
          : {}),
      });

    const rejectBeforeWrite = async (reason: string): Promise<void> => {
      // `reserve` stores identity/state, not these bytes. A bounded diagnostic
      // string avoids re-running the render that just failed and gives the
      // returned reservation a valid non-empty content field.
      const reservation = await delivery.reserve({
        messageId: route.targetMessageId,
        targetWorkSessionId: route.targetWorkSessionId,
        content: reason,
        mode: 'send',
        requestId,
      });
      // Null means SQL already wrote a terminal reservation-time refusal (for
      // example `session_not_live`). There is nothing left to settle.
      if (!reservation) return;
      await delivery.adapter.reject({
        ...reservation,
        requestId,
        principal: delivery.principalFor(reservation),
        reason,
      });
    };

    try {
      // Rendered twice on purpose: the size must be checked against the real
      // envelope, but the real envelope needs a delivery id that only exists
      // after reserving — and reserving a message that cannot fit would write a
      // durable reservation for something that will never reach a terminal.
      //
      // `rollingControlMaxBytes` is NOT the wake budget and did not go with it
      // (migration 120). It is the target session's own interaction-profile
      // prompt policy: one envelope's ceiling, not a count of deliveries.
      let preview: string;
      try {
        preview = render(PREVIEW_DELIVERY_ID);
      } catch (error) {
        const reason = error instanceof BudgetExceededError
          ? ENVELOPE_BUDGET_EXCEEDED
          : ENVELOPE_RENDER_FAILED;
        await rejectBeforeWrite(reason);
        if (!(error instanceof BudgetExceededError)) {
          logDispatchFailure(route, 'delivery envelope render failed', error);
        }
        record(route, 'undelivered', { reason });
        continue;
      }
      if (utf8Bytes(preview) > route.rollingControlMaxBytes) {
        await rejectBeforeWrite(ENVELOPE_BUDGET_EXCEEDED);
        record(route, 'undelivered', { reason: ENVELOPE_BUDGET_EXCEEDED });
        continue;
      }
      const reservation = await delivery.reserve({
        messageId: route.targetMessageId,
        targetWorkSessionId: route.targetWorkSessionId,
        content: preview,
        mode: 'send',
        requestId,
      });
      if (!reservation) {
        record(route, 'undelivered', { reason: REFUSED_AT_RESERVATION });
        continue;
      }
      const content = render(reservation.deliveryId);
      void delivery.adapter
        .dispatch({
          ...reservation,
          content,
          requestId,
          principal: delivery.principalFor(reservation),
        })
        .catch((error) => {
          // The durable row remains pending/dispatching for the existing
          // maintenance owner to expire or recover. Stored-first means an
          // adapter outage cannot roll back or disguise the message command.
          logDispatchFailure(route, 'delivery dispatch failed', error);
        });
      // `accepted`, not `delivered`: the reservation is durable and the write is
      // in flight. The terminal outcome settles on the row, and the row id is
      // handed back so a caller can follow it there.
      record(route, 'accepted', { deliveryId: reservation.deliveryId });
    } catch (error) {
      // `reserve()` itself failing is the one case caught synchronously here;
      // dispatch()'s own failures are caught on its own promise above.
      //
      // THIS CATCH IS WHY THE BUG WAS INVISIBLE. It used to log and move on, so
      // a throw from `reserve()` — for years, every Teammate message with no
      // authoring session (migration 168) — left a stored message, a recorded
      // route, ZERO delivery rows, and a 200. The log line was the only trace,
      // and nothing in the response path read it. The disposition below is that
      // same fact, returned to the caller instead of only printed.
      logDispatchFailure(route, 'delivery reserve or rejection failed', error);
      record(route, 'undelivered', { reason: RESERVE_REFUSED });
    }
  }
  return dispositions;
}
