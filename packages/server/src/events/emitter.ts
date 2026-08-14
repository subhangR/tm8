/**
 * The contract tripwire, envelope construction for presence, and fan-out.
 *
 * ## There is exactly one emitter, and it is the database
 *
 * Durable events are NOT created here. They are captured by the trigger in
 * db/migrations/003 inside the mutating transaction, and this process only ever
 * PROJECTS that log (see mapper.ts) and forwards the result. This file used to
 * expose a `publish(spaceId, body)` that minted a seq and synthesized a durable
 * event; that method is gone on purpose. Two emitters would mean two orderings,
 * duplicate deliveries for one mutation, and a `seq` that is no longer a dedupe
 * key — and the second emitter would be the one that silently wins whenever a
 * handler forgot to call it. The only durable entry point left is
 * `publishDurable`, which takes an ALREADY-SEQUENCED event off the log.
 *
 * The ephemeral presence/typing channel is different and still builds its own
 * envelope here: those events have no database row to be projected from
 * (DEV-4), and their seq is channel-local by contract.
 *
 * ## The tripwire
 *
 * Every event is validated against `WorkspaceEventSchema` before it leaves the
 * process, unconditionally — not behind a dev flag. The contract schemas are
 * `.strict()`, so this fires the moment a projection invents an off-contract
 * event or an extra field: it throws here, in the server's own stack, instead
 * of reaching a client that will silently ignore a variant it does not know.
 * `assertWorkspaceEvent` is exported precisely so the mapper shares it — the
 * `events.poll` path never touches the publisher, and a tripwire that only
 * guards the socket would leave the poll response unchecked.
 */
import {
  WORKSPACE_EVENT_SCHEMA_VERSION,
  WorkspaceEventSchema,
  type DurableWorkspaceEvent,
  type PresenceWorkspaceEvent,
  type SpaceId,
  type WorkspaceEvent,
  type WorkspaceEventEnvelope,
} from '@tm8/contract';

import type { SeqSource } from './seq.js';
import { SubscriptionRegistry, fanOutDurable, fanOutPresence } from './subscriptions.js';
import type { EventSink } from './ws-connection.js';

/** `Omit` that distributes over a union instead of collapsing it to its common keys. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type EnvelopeKey = keyof WorkspaceEventEnvelope;

/** A presence/typing event minus the envelope. These never carry a mutation id. */
export type PresenceEventBody = DistributiveOmit<PresenceWorkspaceEvent, EnvelopeKey>;

export interface PublishResult {
  event: WorkspaceEvent;
  /** How many sinks the event was written to. Zero is normal and not an error. */
  delivered: number;
}

/** Thrown when a constructed event fails the contract schema. See file header. */
export class OffContractEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OffContractEventError';
  }
}

/** Cap on reported issues — enough to fix the bug, not enough to bury it. */
const MAX_REPORTED_ISSUES = 8;

interface LeafIssue {
  path: string;
  message: string;
}

// `Array.isArray` on an `unknown` narrows to `any[]`, which would smuggle
// `any` back in; these two keep the walk in `unknown` the whole way down.
function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

function asArray(v: unknown): unknown[] | null {
  return Array.isArray(v) ? (v as unknown[]) : null;
}

/** True if this arm of the union was rejected on its `type` discriminant. */
function rejectedOnDiscriminant(issues: unknown): boolean {
  const list = asArray(issues);
  if (list === null) return false;
  return list.some((raw) => {
    const path = asArray(asRecord(raw)?.['path']);
    return path !== null && path.length === 1 && path[0] === 'type';
  });
}

/**
 * Flatten a zod union error into something a human can act on.
 *
 * `WorkspaceEventSchema` is an 8-arm union of `.strict()` objects, so a raw
 * `safeParse` failure dumps every arm's complaints — ~4KB of noise in which
 * seven arms are simply "you are not this variant". We drop the arms that were
 * rejected on their `type` discriminant and report only the arm the caller
 * actually meant.
 */
function summarizeIssues(issues: unknown, out: LeafIssue[] = [], depth = 0): LeafIssue[] {
  const list = asArray(issues);
  if (list === null || depth > 4) return out;
  for (const raw of list) {
    if (out.length >= MAX_REPORTED_ISSUES) return out;
    const issue = asRecord(raw);
    if (issue === null) continue;

    const unionErrors = asArray(issue['unionErrors']);
    if (issue['code'] === 'invalid_union' && unionErrors !== null) {
      for (const branch of unionErrors) {
        const branchIssues = asRecord(branch)?.['issues'];
        if (rejectedOnDiscriminant(branchIssues)) continue;
        summarizeIssues(branchIssues, out, depth + 1);
      }
      continue;
    }

    const path = asArray(issue['path']);
    const label = path !== null && path.length > 0 ? path.join('.') : '<root>';
    out.push({ path: label, message: String(issue['message'] ?? 'invalid') });
  }
  return out;
}

/**
 * THE tripwire. Parses `candidate` as a `WorkspaceEvent` or throws
 * `OffContractEventError` with an actionable message.
 *
 * Shared by the publisher (socket path) and the mapper (`events.poll` path) so
 * that both are guarded by the same check. `describe` is used only to name the
 * offender in the error — it never affects whether the parse succeeds.
 */
export function assertWorkspaceEvent(candidate: unknown, describe: string): WorkspaceEvent {
  const parsed = WorkspaceEventSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  const detail = summarizeIssues(parsed.error.issues)
    .map((i) => `${i.path}: ${i.message}`)
    .join('; ');
  throw new OffContractEventError(
    `refusing to emit ${describe}: not a WorkspaceEvent — ${detail || 'no matching variant'}`,
  );
}

export class WorkspaceEventPublisher {
  /**
   * The PRESENCE channel's counter (S8). Named for what it is: durable seqs come
   * off the database log and are never minted here, so this source is only ever
   * asked for a channel-local presence number.
   */
  private readonly presenceSeq: SeqSource;
  private readonly registry: SubscriptionRegistry;

  constructor(presenceSeq: SeqSource, registry: SubscriptionRegistry) {
    this.presenceSeq = presenceSeq;
    this.registry = registry;
  }

  /**
   * Forward an already-sequenced durable event from the log to the space's
   * subscribers.
   *
   * Takes a whole `DurableWorkspaceEvent`, not a body-plus-options, because by
   * the time an event reaches this method its `seq`, `occurredAt` and
   * `clientMutationId` are FACTS from the `workspace_events` row — there is
   * nothing left for the server to decide. The event is re-validated anyway:
   * cheap, and it means a mapper bug cannot reach a client through this door
   * either.
   */
  publishDurable(event: DurableWorkspaceEvent): PublishResult {
    const validated = assertWorkspaceEvent(event, `'${event.type}' on space ${event.spaceId} (seq ${event.seq})`);
    return { event: validated, delivered: fanOutDurable(this.registry, event.spaceId, JSON.stringify(validated)) };
  }

  /**
   * Deliver an already-sequenced durable event to ONE sink.
   *
   * ## Why live delivery cannot use `publishDurable`
   *
   * `workspace_events` carries TWO interleaved feeds, split by
   * `recipient_member_id` (003:277): NULL is the Space feed every member sees,
   * non-NULL is one member's personal notification feed. The RLS policy
   * enforces exactly that (008:156-161 — a member reads Space events plus the
   * events addressed to them).
   *
   * So a live publisher that read the log under ONE subscriber's claims and
   * then fanned the result out to every subscriber of the Space would deliver
   * that subscriber's private notifications to everyone else. The read would be
   * correctly authorized and the leak would happen after it, in the fan-out —
   * a shared routine returning caller-influenced data to callers it was not
   * authorized for.
   *
   * The pump therefore polls per-connection under each connection's own claims
   * and delivers through THIS method. `publishDurable` remains correct for a
   * genuinely Space-wide event the server already holds, and is what the
   * cross-group publisher hookup uses; it is simply not sound over a log read.
   */
  publishDurableTo(sink: EventSink, event: DurableWorkspaceEvent): PublishResult {
    const validated = assertWorkspaceEvent(event, `'${event.type}' on space ${event.spaceId} (seq ${event.seq})`);
    if (!sink.isOpen) return { event: validated, delivered: 0 };
    try {
      sink.send(JSON.stringify(validated));
      return { event: validated, delivered: 1 };
    } catch {
      // The connection's own close path evicts it.
      return { event: validated, delivered: 0 };
    }
  }

  /**
   * Publish an ephemeral presence/typing event to the presence channel only.
   *
   * DEV-4: this never touches the durable stream. Its `seq` is CHANNEL-LOCAL —
   * the contract says so explicitly (contract.ts §5) — and a client must not
   * use it as a durable cursor or feed it to `events.poll?since=`. It exists
   * purely so a client can order presence updates among themselves. Since S8
   * that number comes from a counter that the durable log does not share, so
   * the two can no longer disagree about it.
   */
  async publishPresence(spaceId: SpaceId, body: PresenceEventBody): Promise<PublishResult> {
    const seq = await this.presenceSeq.next(spaceId);
    const envelope: WorkspaceEventEnvelope = {
      spaceId,
      seq,
      occurredAt: new Date().toISOString(),
      schemaVersion: WORKSPACE_EVENT_SCHEMA_VERSION,
    };
    // Typed `unknown` deliberately: the assembled object is only a
    // WorkspaceEvent once the schema says it is, and the parse is what says so.
    const candidate: unknown = { ...body, ...envelope };
    const event = assertWorkspaceEvent(candidate, `'${body.type}' on space ${spaceId}`);
    return { event, delivered: fanOutPresence(this.registry, spaceId, JSON.stringify(event)) };
  }
}
