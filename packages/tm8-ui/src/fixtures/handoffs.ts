import type { ActorSummary, EntityId, HandoffView, ShareProjectionEnvelope } from '@tm8/contract';
import { ada, forge } from './actors';
import {
  FIXTURE_SPACE_ID,
  commitFoundation,
  docLayoutSpec,
  fileScreenshot,
  prTransplant,
  sessionLive,
  sessionStale,
  taskGuideLines,
  taskUuidTitle,
} from './entities';

/**
 * Share-into-session handoff fixtures — the RULING-F row-8 drop grammar's
 * data side (LLD §8, §10.6 "Handoffs" axis).
 *
 * WHY THIS FILE EXISTS: the session panel's SHARED CONTEXT section renders
 * `deliveryStatus × recordStatus` as TWO FACETS, never one badge (LLD L7).
 * A one-badge collapse is only detectable if the dataset actually carries
 * every legal pair, so this file enumerates the COMPLETE legal matrix rather
 * than a representative sample. `unknown` is present precisely because it is
 * the facet that must never be styled as success.
 *
 * The send/withdraw COMMANDS are a §10.7 deferred seam amendment — these are
 * read-side fixtures only; the drop targets and the withdraw control render
 * disabled-with-reason until the dual re-consensus stamps those ops.
 *
 * Legality is not by convention — HandoffViewSchema enforces it (schemas.ts):
 *   · delivery ∈ {prepared, dispatching} ⇒ record MUST be 'pending'
 *     (a handoff still in flight cannot have a terminal record verdict);
 *   · record === 'withdrawn' ⟺ withdrawnAt AND withdrawnBy both non-null;
 *   · envelope.bodyBytes MUST equal the UTF-8 byte length of envelope.body.
 * The matrix below is therefore 14 pairs, not 5 × 4 = 20.
 *
 * Determinism per A0 convention: no Date.now(), no Math.random() — ids and
 * timestamps are counters off FIXTURE_NOW's day.
 */

const T = {
  older: '2026-07-20T09:00:00.000Z',
  old: '2026-07-27T18:30:00.000Z',
  morning: '2026-07-28T09:15:00.000Z',
  recent: '2026-07-28T11:58:20.000Z',
};

/**
 * TextEncoder rather than Buffer: this module is bundled for the browser and
 * `Buffer` is node-only. The schema's byte check is exact, so the count must
 * be computed the same way the server counts it (UTF-8 bytes, not chars).
 */
const utf8Bytes = (s: string): number => new TextEncoder().encode(s).length;

function envelope(
  source: { id: EntityId; kind: string; title: string; version: number },
  body: string,
  over: Partial<Pick<ShareProjectionEnvelope, 'truncated' | 'omittedFields'>> = {},
): ShareProjectionEnvelope {
  return {
    entityId: source.id,
    kind: source.kind as ShareProjectionEnvelope['kind'],
    title: source.title,
    contentVersion: source.version,
    sourceSpaceId: FIXTURE_SPACE_ID,
    body,
    bodyBytes: utf8Bytes(body),
    truncated: false,
    omittedFields: [],
    ...over,
  };
}

interface HandoffOver {
  id: string;
  source: { id: EntityId; kind: string; title: string; version: number };
  target?: EntityId;
  delivery: HandoffView['deliveryStatus'];
  record: HandoffView['recordStatus'];
  body?: string;
  sourceMissing?: boolean;
  withdrawnBy?: ActorSummary;
  withdrawReason?: string;
  envelopeOver?: Partial<Pick<ShareProjectionEnvelope, 'truncated' | 'omittedFields'>>;
  createdAt?: string;
  updatedAt?: string;
}

function handoff(over: HandoffOver): HandoffView {
  const withdrawn = over.record === 'withdrawn';
  return {
    handoffId: over.id,
    sourceEntityId: over.source.id,
    targetWorkSessionId: over.target ?? sessionLive.id,
    deliveryStatus: over.delivery,
    recordStatus: over.record,
    sourceSnapshot: envelope(over.source, over.body ?? `Shared context for ${over.source.title}.`, over.envelopeOver),
    envelopeHash: `sha256:${over.id}`,
    sourceMissing: over.sourceMissing ?? false,
    recordVersion: 1,
    withdrawnBy: withdrawn ? (over.withdrawnBy ?? ada) : null,
    withdrawnAt: withdrawn ? T.recent : null,
    withdrawReason: withdrawn ? (over.withdrawReason ?? 'Shared the wrong revision.') : null,
    createdAt: over.createdAt ?? T.morning,
    updatedAt: over.updatedAt ?? T.recent,
  };
}

// ---------------------------------------------------------------------------
// THE COMPLETE LEGAL MATRIX — 14 pairs.
//
// Facet meanings the UI must keep separate:
//   deliveryStatus = did the bytes reach the session's PTY?
//   recordStatus   = did the durable record of the share land?
// They fail independently. "delivered × failed" (the agent saw it, the record
// did not land) and "unknown × recorded" (we wrote it down but cannot prove
// the agent got it) are both real, and collapsing either into one badge
// destroys the distinction the user needs to decide whether to re-share.
// ---------------------------------------------------------------------------

/** In flight, record necessarily pending — the schema forbids anything else. */
export const handoffPreparedPending = handoff({
  id: 'ho-prepared-pending',
  source: taskUuidTitle,
  delivery: 'prepared',
  record: 'pending',
  body: 'Reproduce and fix the crash captured by incident 4f8c2a9e.',
});

export const handoffDispatchingPending = handoff({
  id: 'ho-dispatching-pending',
  source: taskGuideLines,
  delivery: 'dispatching',
  record: 'pending',
});

/** Bytes landed; the record has not caught up yet. Not a success state. */
export const handoffDeliveredPending = handoff({
  id: 'ho-delivered-pending',
  source: docLayoutSpec,
  delivery: 'delivered',
  record: 'pending',
});

/** THE fully-good row: both facets positive. The only one that reads as done. */
export const handoffDeliveredRecorded = handoff({
  id: 'ho-delivered-recorded',
  source: docLayoutSpec,
  delivery: 'delivered',
  record: 'recorded',
  body: '# Layout spec\n\nC_min = max(320, V·320 + max(0, V−1)·8).',
  createdAt: T.old,
});

/** Agent saw it; the durable record did not land. Half-success, honestly split. */
export const handoffDeliveredFailed = handoff({
  id: 'ho-delivered-failed',
  source: prTransplant,
  delivery: 'delivered',
  record: 'failed',
});

export const handoffDeliveredWithdrawn = handoff({
  id: 'ho-delivered-withdrawn',
  source: commitFoundation,
  delivery: 'delivered',
  record: 'withdrawn',
  withdrawnBy: ada,
  withdrawReason: 'Shared the wrong commit.',
});

/** The session refused the payload (policy, size, or shape). */
export const handoffRefusedPending = handoff({
  id: 'ho-refused-pending',
  source: fileScreenshot,
  delivery: 'refused',
  record: 'pending',
});

export const handoffRefusedRecorded = handoff({
  id: 'ho-refused-recorded',
  source: fileScreenshot,
  delivery: 'refused',
  record: 'recorded',
  body: 'gate-screen-side-by-side.png (4.8 MB) — refused: over the share size budget.',
});

export const handoffRefusedFailed = handoff({
  id: 'ho-refused-failed',
  source: fileScreenshot,
  delivery: 'refused',
  record: 'failed',
});

export const handoffRefusedWithdrawn = handoff({
  id: 'ho-refused-withdrawn',
  source: fileScreenshot,
  delivery: 'refused',
  record: 'withdrawn',
  withdrawnBy: forge,
  withdrawReason: 'Refused by the session; withdrawing the attempt.',
});

/**
 * THE HONESTY FLAGSHIP: delivery is UNKNOWN. We cannot prove the agent
 * received this. It must never render with the success treatment, and its
 * record facet must stay independently readable — `unknown × recorded` means
 * "we wrote it down, we cannot prove it arrived", which is exactly the state
 * a collapsed single badge would lie about.
 */
export const handoffUnknownPending = handoff({
  id: 'ho-unknown-pending',
  source: taskUuidTitle,
  delivery: 'unknown',
  record: 'pending',
  target: sessionStale.id,
});

export const handoffUnknownRecorded = handoff({
  id: 'ho-unknown-recorded',
  source: taskGuideLines,
  delivery: 'unknown',
  record: 'recorded',
  target: sessionStale.id,
});

export const handoffUnknownFailed = handoff({
  id: 'ho-unknown-failed',
  source: taskGuideLines,
  delivery: 'unknown',
  record: 'failed',
  target: sessionStale.id,
});

export const handoffUnknownWithdrawn = handoff({
  id: 'ho-unknown-withdrawn',
  source: taskGuideLines,
  delivery: 'unknown',
  record: 'withdrawn',
  target: sessionStale.id,
  withdrawnBy: ada,
  withdrawReason: 'Session went stale before we could confirm.',
});

/**
 * sourceMissing: the shared entity has since been deleted. The snapshot is
 * all that survives — the row must render explicitly as source-missing and
 * must NOT offer navigation to a corpse it cannot resolve (LLD §8).
 */
export const handoffSourceMissing = handoff({
  id: 'ho-source-missing',
  source: { id: 'task-tombstone', kind: 'task', title: 'Spike: CRDT for doc bodies', version: 2 },
  delivery: 'delivered',
  record: 'recorded',
  sourceMissing: true,
  body: 'Spike: CRDT for doc bodies — snapshot taken before the entity was deleted.',
});

/**
 * Worst-case envelope: truncated at the 32KB body budget with named omitted
 * fields. The row must say what was left out rather than implying the agent
 * received the whole entity.
 */
export const handoffTruncatedEnvelope = handoff({
  id: 'ho-truncated',
  source: docLayoutSpec,
  delivery: 'delivered',
  record: 'recorded',
  body: 'x'.repeat(600),
  envelopeOver: { truncated: true, omittedFields: ['acceptanceCriteria', 'attachments'] },
});

/** Every legal pair, in matrix order, plus the two shape edge cases. */
export const fixtureHandoffs: HandoffView[] = [
  handoffPreparedPending,
  handoffDispatchingPending,
  handoffDeliveredPending,
  handoffDeliveredRecorded,
  handoffDeliveredFailed,
  handoffDeliveredWithdrawn,
  handoffRefusedPending,
  handoffRefusedRecorded,
  handoffRefusedFailed,
  handoffRefusedWithdrawn,
  handoffUnknownPending,
  handoffUnknownRecorded,
  handoffUnknownFailed,
  handoffUnknownWithdrawn,
  handoffSourceMissing,
  handoffTruncatedEnvelope,
];

/** Grouped the way the seam serves them: `handoffs(workSessionId)`. */
export const fixtureHandoffsBySession: Record<EntityId, HandoffView[]> = {
  [sessionLive.id]: fixtureHandoffs.filter((h) => h.targetWorkSessionId === sessionLive.id),
  [sessionStale.id]: fixtureHandoffs.filter((h) => h.targetWorkSessionId === sessionStale.id),
};

/**
 * NO REASON STRINGS LIVE HERE.
 *
 * This file used to export `handoffSendUnavailableReason` and
 * `handoffWithdrawUnavailableReason` — two authored sentences that duplicated
 * `REASONS.handoffSendDeferred` / `REASONS.handoffWithdrawDeferred` in the
 * action registry. Same leading clause, divergent tails: the pair would have
 * read as consistent today and drifted silently the first time either was
 * reworded.
 *
 * The registry owns deferral copy, because the registry owns the ACTION whose
 * availability the sentence explains. Consumers read it the same way every
 * other disabled affordance does:
 *
 *   resolveAction('share-into-session').availability(ctx).reason
 *   resolveAction('withdraw-handoff').availability(ctx).reason
 *
 * Found by sweeping the CLASS after fixing a reported instance elsewhere —
 * a peer ran the same sweep on their own lane the same hour and found one
 * they had written themselves. The instance is never the class.
 */
