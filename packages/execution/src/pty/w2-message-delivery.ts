/**
 * The execution-side half of W2's stored-first message delivery protocol.
 *
 * This module deliberately knows nothing about HTTP identities, members,
 * teammates, database connections, or the message command budget. A caller
 * must present a Server-minted principal that the injected `authorize` guard
 * binds to an already-reserved delivery. The durable `claim` handshake then
 * happens before the one actual PTY write attempt, and `settle` records the
 * result afterwards. No database lock is held by this adapter.
 */

export interface W2DeliveryBinding {
  readonly deliveryId: string;
  readonly requestId: string;
  readonly messageId: string;
  readonly targetWorkSessionId: string;
  readonly reservationVersion: number;
  readonly expiresAt: string;
}

export interface W2DeliveryAttempt extends W2DeliveryBinding {
  /** Opaque Server-owned authority. Structural actor/member objects are invalid. */
  readonly principal: unknown;
  readonly content: string;
  readonly mode: 'send' | 'paste';
}

export type W2DeliveryOutcome =
  | { readonly outcome: 'delivered'; readonly reason?: string }
  | { readonly outcome: 'refused'; readonly reason: string }
  | { readonly outcome: 'unknown'; readonly reason: string };

export type W2DeliveryClaim =
  | { readonly state: 'claimed' }
  | { readonly state: 'settled'; readonly result: W2DeliveryOutcome };

export interface W2PtyWriteAttempt extends W2DeliveryBinding {
  readonly content: string;
  readonly mode: 'send' | 'paste';
}

export interface W2MessageDeliveryAdapterOptions {
  /** G11 supplies the closed `isSystemDeliveryPrincipalFor` guard here. */
  readonly authorize: (principal: unknown, binding: W2DeliveryBinding) => boolean;
  /** Atomically changes the stored attempt from pending to dispatching. */
  readonly claim: (binding: W2DeliveryBinding) => Promise<W2DeliveryClaim>;
  /** Resolves only after the actual `proc.write` attempt (or an explicit refusal). */
  readonly writeAttempt: (attempt: W2PtyWriteAttempt) => Promise<W2DeliveryOutcome>;
  /** Durably records the write outcome. */
  readonly settle: (binding: W2DeliveryBinding, outcome: W2DeliveryOutcome) => Promise<void>;
}

interface PendingAttempt {
  readonly fingerprint: string;
  readonly promise: Promise<W2DeliveryOutcome>;
}

function requireOpaque(value: string, name: string): void {
  if (value.length === 0 || value.trim() !== value) {
    throw new TypeError(`${name} must be a non-empty opaque id`);
  }
}

function bindingOf(attempt: W2DeliveryAttempt): W2DeliveryBinding {
  requireOpaque(attempt.deliveryId, 'deliveryId');
  requireOpaque(attempt.requestId, 'requestId');
  requireOpaque(attempt.messageId, 'messageId');
  requireOpaque(attempt.targetWorkSessionId, 'targetWorkSessionId');
  if (!Number.isSafeInteger(attempt.reservationVersion) || attempt.reservationVersion < 0) {
    throw new TypeError('reservationVersion must be a non-negative safe integer');
  }
  if (!Number.isFinite(Date.parse(attempt.expiresAt))) {
    throw new TypeError('expiresAt must be an ISO timestamp');
  }
  if (typeof attempt.content !== 'string' || (attempt.mode !== 'send' && attempt.mode !== 'paste')) {
    throw new TypeError('delivery content and mode are invalid');
  }
  return Object.freeze({
    deliveryId: attempt.deliveryId,
    requestId: attempt.requestId,
    messageId: attempt.messageId,
    targetWorkSessionId: attempt.targetWorkSessionId,
    reservationVersion: attempt.reservationVersion,
    expiresAt: attempt.expiresAt,
  });
}

function fingerprint(attempt: W2DeliveryAttempt): string {
  return JSON.stringify([
    attempt.deliveryId,
    attempt.requestId,
    attempt.messageId,
    attempt.targetWorkSessionId,
    attempt.reservationVersion,
    attempt.expiresAt,
    attempt.content,
    attempt.mode,
  ]);
}

function normalizeOutcome(value: W2DeliveryOutcome): W2DeliveryOutcome {
  if (value.outcome === 'delivered') {
    return value.reason === undefined
      ? { outcome: 'delivered' }
      : { outcome: 'delivered', reason: value.reason };
  }
  if (
    (value.outcome === 'refused' || value.outcome === 'unknown') &&
    typeof value.reason === 'string' &&
    value.reason.length > 0
  ) {
    return { outcome: value.outcome, reason: value.reason };
  }
  throw new TypeError('invalid PTY delivery outcome');
}

/**
 * Pending-unique execution adapter for pre-reserved message deliveries.
 *
 * In-process duplicate calls join one promise. A later replay is still safe:
 * its durable claim must return the already-settled result instead of granting
 * another write. Changed stable inputs under one delivery id are rejected.
 */
export class W2MessageDeliveryAdapter {
  private readonly pending = new Map<string, PendingAttempt>();

  constructor(private readonly options: W2MessageDeliveryAdapterOptions) {}

  dispatch(attempt: W2DeliveryAttempt): Promise<W2DeliveryOutcome> {
    const binding = bindingOf(attempt);
    if (!this.options.authorize(attempt.principal, binding)) {
      return Promise.reject(new TypeError('a valid system delivery principal is required'));
    }

    const stableFingerprint = fingerprint(attempt);
    const existing = this.pending.get(binding.deliveryId);
    if (existing) {
      if (existing.fingerprint !== stableFingerprint) {
        return Promise.reject(new Error('delivery identity mismatch'));
      }
      return existing.promise;
    }

    const promise = this.run(binding, attempt);
    const pending = { fingerprint: stableFingerprint, promise };
    this.pending.set(binding.deliveryId, pending);
    const cleanup = (): void => {
      if (this.pending.get(binding.deliveryId) === pending) {
        this.pending.delete(binding.deliveryId);
      }
    };
    void promise.then(cleanup, cleanup);
    return promise;
  }

  private async run(
    binding: W2DeliveryBinding,
    attempt: W2DeliveryAttempt,
  ): Promise<W2DeliveryOutcome> {
    const claim = await this.options.claim(binding);
    if (claim.state === 'settled') return normalizeOutcome(claim.result);

    let outcome: W2DeliveryOutcome;
    try {
      outcome = normalizeOutcome(await this.options.writeAttempt({
        ...binding,
        content: attempt.content,
        mode: attempt.mode,
      }));
    } catch {
      // Once a proc.write call may have happened, retrying would risk duplicate
      // input. Record uncertainty and require a new delivery id for reattempt.
      outcome = { outcome: 'unknown', reason: 'write_attempt_failed' };
    }
    await this.options.settle(binding, outcome);
    return outcome;
  }
}
