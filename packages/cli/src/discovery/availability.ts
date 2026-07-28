/**
 * PER-OPERATION AVAILABILITY — a permanent, first-class field of the CLI's
 * operation projection.
 *
 * This is NOT scaffolding for "the server isn't finished yet". Per-node
 * capability variation is a designed, permanent property of the architecture: a
 * deployed tm8 node may legitimately implement a subset of the catalog forever,
 * and DEV-13 requires it to say so with an honest `501 not_implemented` rather
 * than a 404. This field is how the CLI carries that answer into discovery
 * instead of presenting every catalogued row as though it worked.
 *
 * THE DEFAULT IS `unknown`, AND `unknown` RENDERS AS UNKNOWN. It is never
 * optimistically upgraded to `available`. An honest "I have not learned this
 * yet" is the entire value of the field; a hopeful `available` would make the
 * field worse than not having one, because a caller would trust it.
 *
 * THREE SOURCES, IN THIS PRECEDENCE:
 *
 *   1. `contract`   — offline and node-independent. The two reserved rows are
 *                     unavailable on EVERY node by contract, so no network is
 *                     needed to answer for them. A contract verdict is final:
 *                     no observation can promote a reserved row.
 *   2. `observed`   — an honest 501 IS the per-operation signal, and it is safe
 *                     to trust because a 501 is decided BEFORE validation: it
 *                     reserves no `clientMutationId` and applies nothing.
 *                     ⚠ THE CONVERSE DOES NOT HOLD. This line used to read
 *                     "any other outcome — success or any other refusal —
 *                     proves a handler exists". A SUCCESS does; A REFUSAL DOES
 *                     NOT, because four refusal sites run BEFORE the handler
 *                     lookup at `http/server.ts:163`. Which outcomes count is
 *                     decided by `PROVES_A_HANDLER_RAN` in `./observe.ts`.
 *                     Observation is a by-product of calls the caller already
 *                     made; THIS MODULE NEVER PROBES, and above all never
 *                     probes a mutation.
 *   3. `advertised` — a reserved socket for a future node-advertised capability
 *                     set. The seam exists; nothing implements it. It is
 *                     consulted last and today always answers "nothing".
 *
 * THE IMPLEMENTATION EPOCH IS NOT THE CAPABILITY EPOCH. `/health` answers
 * `{operations, implemented}` — how many routes are mounted and how many
 * handlers are registered on this node. That is a CACHE-INVALIDATION EPOCH
 * ONLY: when it changes, learned observations may be stale and are dropped. It
 * is NEVER a per-operation claim (knowing 70 of 100 handlers exist tells you
 * nothing about WHICH 70), and it is deliberately a distinct type from
 * `capabilityEpoch`. Conflating "is this implemented on this node" with "may
 * this actor do this here now" is precisely the error this design refuses:
 * implementation is a property of the deployment, authorization is a property
 * of the actor, and a change in one must not invalidate the other's cache
 * (harness §8.2 — static help stays valid when only `capabilityEpoch` changes).
 */
import type { OperationName } from '@tm8/contract';

export const AVAILABILITIES = ['available', 'unavailable', 'unknown'] as const;
export type Availability = (typeof AVAILABILITIES)[number];

export const AVAILABILITY_REASONS = [
  'reserved',
  'not_implemented_on_node',
  'observed_ok',
] as const;
export type AvailabilityReason = (typeof AVAILABILITY_REASONS)[number] | null;

export const AVAILABILITY_SOURCES = ['contract', 'observed', 'advertised'] as const;
export type AvailabilitySource = (typeof AVAILABILITY_SOURCES)[number];

export interface AvailabilityVerdict {
  availability: Availability;
  availabilityReason: AvailabilityReason;
  availabilitySource: AvailabilitySource;
}

/**
 * The node's implementation epoch, read from `/health`. A pure cache key.
 *
 * Branded so it cannot be passed where a `capabilityEpoch` is expected, or the
 * reverse. The two are different questions with different lifetimes and the
 * type system is the cheapest place to keep them apart.
 */
export interface ImplementationEpoch {
  readonly __brand: 'tm8.implementationEpoch';
  /** Routes mounted on the node. */
  readonly operations: number;
  /** Semantic handlers registered on the node. */
  readonly implemented: number;
}

export function implementationEpoch(operations: number, implemented: number): ImplementationEpoch {
  return { __brand: 'tm8.implementationEpoch', operations, implemented } as ImplementationEpoch;
}

/** The cache key form. Deliberately prefixed so it can never be read as a capabilityEpoch. */
export function implementationEpochKey(epoch: ImplementationEpoch): string {
  return `impl:${epoch.operations}/${epoch.implemented}`;
}

/**
 * Parse the unenveloped `/health` body. `/health` is not a catalog operation,
 * so this is deliberately defensive: anything that is not two numbers is "no
 * epoch", never a guess.
 */
export function readImplementationEpoch(body: unknown): ImplementationEpoch | null {
  if (body === null || typeof body !== 'object') return null;
  const { operations, implemented } = body as { operations?: unknown; implemented?: unknown };
  if (typeof operations !== 'number' || typeof implemented !== 'number') return null;
  return implementationEpoch(operations, implemented);
}

/**
 * What a single completed call taught us. `not_implemented` is the ONLY outcome
 * that proves absence.
 *
 * ⚠ THIS COMMENT USED TO READ "every other outcome proves presence, including a
 * refusal — `forbidden` means a handler ran and said no." THAT IS FALSE and it
 * was the same wrong claim `observe.ts` carried: `forbidden` is emitted by
 * `checkTransport` at `http/server.ts:116`, well before the handler lookup at
 * `:163`. Which outcomes actually prove presence is decided by
 * `PROVES_A_HANDLER_RAN` in `./observe.ts`, against the measured pipeline
 * order — not by this type, and not by a code's name.
 *
 * `handled` therefore means "an outcome that could only have come from a
 * handler", NOT "anything that was not a 501".
 */
export type Observation = 'not_implemented' | 'handled';

/**
 * Source 3, reserved. A node may one day advertise the exact operation set it
 * implements; when it does, that answer slots in here without changing any
 * caller. Nothing populates it today and nothing should be added here without
 * the corresponding Server contract — a client-side guess would be an invented
 * capability claim.
 */
export interface AdvertisedCapabilitySet {
  readonly implemented: ReadonlySet<OperationName>;
  readonly epoch: string;
}

/**
 * The learned availability ledger. Process-scoped: nothing is written to disk,
 * because a stale on-disk claim about a node the caller has since re-pointed at
 * would be worse than `unknown`.
 */
export class AvailabilityLedger {
  private observations = new Map<OperationName, Observation>();
  private epoch: ImplementationEpoch | null = null;
  private advertised: AdvertisedCapabilitySet | null = null;
  /**
   * Bumped on every change. Readers that cache a resolved projection compare
   * this instead of re-resolving 101 rows on each access — and, crucially, a
   * cache keyed on it cannot serve a stale `unknown` after an observation.
   */
  private rev = 0;

  revision(): number {
    return this.rev;
  }

  /** Record what a call the caller ALREADY MADE revealed. Never probes. */
  record(operation: OperationName, observation: Observation): void {
    if (this.observations.get(operation) === observation) return;
    this.observations.set(operation, observation);
    this.rev++;
  }

  /**
   * Apply a `/health` reading. A CHANGED epoch drops every learned observation:
   * the node's handler set moved and what we learned before may be a lie. The
   * epoch itself never becomes a per-operation claim.
   */
  applyEpoch(epoch: ImplementationEpoch | null): void {
    if (epoch === null) return;
    if (this.epoch === null) {
      this.epoch = epoch;
      return;
    }
    if (implementationEpochKey(this.epoch) !== implementationEpochKey(epoch)) {
      this.observations.clear();
      this.epoch = epoch;
      this.rev++;
    }
  }

  currentEpoch(): ImplementationEpoch | null {
    return this.epoch;
  }

  /** Source 3 seam. Present so the precedence is real code, not a comment. */
  setAdvertised(set: AdvertisedCapabilitySet | null): void {
    this.advertised = set;
    this.rev++;
  }

  observed(operation: OperationName): Observation | undefined {
    return this.observations.get(operation);
  }

  advertisedFor(operation: OperationName): Availability | undefined {
    if (this.advertised === null) return undefined;
    return this.advertised.implemented.has(operation) ? 'available' : 'unavailable';
  }

  /** Forget everything learned. Used when the caller re-points at another node. */
  clear(): void {
    this.observations.clear();
    this.epoch = null;
    this.advertised = null;
    this.rev++;
  }
}

/** The process ledger. Commands feed it; discovery reads it. */
export const ledger = new AvailabilityLedger();

/**
 * Source 1 alone — offline, node-independent, and the only source that can
 * produce a verdict with no network at all.
 */
export function contractAvailability(status: 'v1' | 'reserved'): AvailabilityVerdict | null {
  if (status === 'reserved') {
    return {
      availability: 'unavailable',
      availabilityReason: 'reserved',
      availabilitySource: 'contract',
    };
  }
  return null;
}

/**
 * Resolve one operation through the full precedence. The default — and the
 * answer for the overwhelming majority of rows on a node nobody has called yet
 * — is `unknown`, and that is correct rather than unhelpful.
 */
export function resolveAvailability(
  operation: OperationName,
  status: 'v1' | 'reserved',
  from: AvailabilityLedger = ledger,
): AvailabilityVerdict {
  const byContract = contractAvailability(status);
  if (byContract !== null) return byContract;

  const observation = from.observed(operation);
  if (observation === 'not_implemented') {
    return {
      availability: 'unavailable',
      availabilityReason: 'not_implemented_on_node',
      availabilitySource: 'observed',
    };
  }
  if (observation === 'handled') {
    return {
      availability: 'available',
      availabilityReason: 'observed_ok',
      availabilitySource: 'observed',
    };
  }

  const advertised = from.advertisedFor(operation);
  if (advertised !== undefined) {
    return {
      availability: advertised,
      availabilityReason: advertised === 'available' ? 'observed_ok' : 'not_implemented_on_node',
      availabilitySource: 'advertised',
    };
  }

  return { availability: 'unknown', availabilityReason: null, availabilitySource: 'contract' };
}
