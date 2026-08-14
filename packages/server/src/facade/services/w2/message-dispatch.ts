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

import { incomingMessageInjection, utf8Bytes } from '@tm8/prompt';

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
  adapter: { dispatch(attempt: Record<string, unknown>): Promise<unknown> };
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

const PREVIEW_DELIVERY_ID = '00000000-0000-4000-8000-000000000000';

export async function dispatchSessionMessages(options: DispatchOptions): Promise<void> {
  const { routes, parentsById, requestId, sourceWorkSessionId, senderAttribution, delivery } =
    options;

  for (const route of routes) {
    if (!route.sessionInputAllowed || route.targetWorkSessionId === sourceWorkSessionId) continue;
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
        ...(parent
          ? {
              parentBody: parent.content.body,
              parentAuthorDisplay: parent.state.author.displayName,
            }
          : {}),
      });

    try {
      // Rendered twice on purpose: the size must be checked against the real
      // envelope, but the real envelope needs a delivery id that only exists
      // after reserving — and reserving a message that cannot fit would write a
      // durable reservation for something that will never reach a terminal.
      //
      // `rollingControlMaxBytes` is NOT the wake budget and did not go with it
      // (migration 120). It is the target session's own interaction-profile
      // prompt policy: one envelope's ceiling, not a count of deliveries.
      const preview = render(PREVIEW_DELIVERY_ID);
      if (utf8Bytes(preview) > route.rollingControlMaxBytes) continue;
      const reservation = await delivery.reserve({
        messageId: route.targetMessageId,
        targetWorkSessionId: route.targetWorkSessionId,
        content: preview,
        mode: 'send',
        requestId,
      });
      if (!reservation) continue;
      const content = render(reservation.deliveryId);
      void delivery.adapter
        .dispatch({
          ...reservation,
          content,
          requestId,
          principal: delivery.principalFor(reservation),
        })
        .catch(() => {
          // The durable row remains pending/dispatching for the existing
          // maintenance owner to expire or recover. Stored-first means an
          // adapter outage cannot roll back or disguise the message command.
        });
    } catch {
      // `reserve()` itself failing is the one case caught synchronously here;
      // dispatch()'s own failures are caught on its own promise above.
    }
  }
}
