/**
 * Envelope construction and publication.
 *
 * Callers hand in the BODY of an event — the discriminated-union arm, e.g.
 * `{ type: 'entity.upsert', entity }` — and this file supplies the AM-2 §3
 * envelope (`spaceId`, `seq`, `occurredAt`, `schemaVersion`). Handlers never
 * build an envelope themselves, for the same reason they never mint a seq:
 * one place to get it right, one place to change it when the schema version
 * bumps.
 *
 * Every constructed event is validated against `WorkspaceEventSchema` before
 * it leaves the process, unconditionally — not behind a dev flag. The contract
 * schemas are `.strict()`, so this is the tripwire that fires the moment a W2
 * handler invents an off-contract event or an extra field: it throws here, in
 * the server's own stack, instead of reaching a client that will silently
 * ignore a variant it does not know. The cost is one zod parse per event; the
 * alternative is a class of bug that only shows up as missing UI.
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

/** `Omit` that distributes over a union instead of collapsing it to its common keys. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type EnvelopeKey = keyof WorkspaceEventEnvelope;

/**
 * A durable event minus the envelope. `clientMutationId` is omitted too — it
 * arrives via `publish` options because it belongs to the originating command
 * (DEV-9), not to the event body.
 */
export type DurableEventBody = DistributiveOmit<DurableWorkspaceEvent, EnvelopeKey | 'clientMutationId'>;

/** A presence/typing event minus the envelope. These never carry a mutation id. */
export type PresenceEventBody = DistributiveOmit<PresenceWorkspaceEvent, EnvelopeKey>;

export interface PublishOptions {
  /** Echo of the originating command's id, for optimistic reconciliation (DEV-9). */
  clientMutationId?: string;
}

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

export class WorkspaceEventPublisher {
  private readonly seq: SeqSource;
  private readonly registry: SubscriptionRegistry;

  constructor(seq: SeqSource, registry: SubscriptionRegistry) {
    this.seq = seq;
    this.registry = registry;
  }

  /**
   * Publish a durable event to the space's subscribers.
   *
   * Async because `SeqSource.next` is async at W2 (it reads the counter row in
   * the mutation's transaction). The skeleton's in-memory source resolves
   * immediately.
   */
  async publish(spaceId: SpaceId, body: DurableEventBody, opts: PublishOptions = {}): Promise<PublishResult> {
    const event = this.build(spaceId, await this.seq.next(spaceId), body, opts.clientMutationId);
    return { event, delivered: fanOutDurable(this.registry, spaceId, JSON.stringify(event)) };
  }

  /**
   * Publish an ephemeral presence/typing event to the presence channel only.
   *
   * DEV-4: this never touches the durable stream. Its `seq` is CHANNEL-LOCAL —
   * the contract says so explicitly (contract.ts §5) — and a client must not
   * use it as a durable cursor or feed it to `events.poll?since=`. It exists
   * purely so a client can order presence updates among themselves.
   *
   * TODO(W2): the channel-local seq currently shares the durable `SeqSource`,
   * which burns durable sequence numbers on ephemeral events. Harmless while
   * the durable log does not exist (gaps are explicitly allowed by AM-2 §3),
   * but the presence channel needs its own counter before the Postgres seq
   * lands, or the two will disagree about what `next()` means.
   */
  async publishPresence(spaceId: SpaceId, body: PresenceEventBody): Promise<PublishResult> {
    const event = this.build(spaceId, await this.seq.next(spaceId), body, undefined);
    return { event, delivered: fanOutPresence(this.registry, spaceId, JSON.stringify(event)) };
  }

  private build(
    spaceId: SpaceId,
    seq: number,
    body: DurableEventBody | PresenceEventBody,
    clientMutationId: string | undefined,
  ): WorkspaceEvent {
    const envelope: WorkspaceEventEnvelope = {
      spaceId,
      seq,
      occurredAt: new Date().toISOString(),
      schemaVersion: WORKSPACE_EVENT_SCHEMA_VERSION,
    };
    // Typed `unknown` deliberately: the assembled object is only a
    // WorkspaceEvent once the schema says it is, and `parse` is what says so.
    const candidate: unknown = {
      ...body,
      ...envelope,
      ...(clientMutationId === undefined ? {} : { clientMutationId }),
    };

    const parsed = WorkspaceEventSchema.safeParse(candidate);
    if (!parsed.success) {
      const detail = summarizeIssues(parsed.error.issues)
        .map((i) => `${i.path}: ${i.message}`)
        .join('; ');
      throw new OffContractEventError(
        `refusing to emit '${body.type}' on space ${spaceId}: not a WorkspaceEvent — ${detail || 'no matching variant'}`,
      );
    }
    return parsed.data;
  }
}
