/**
 * Bridges {@link PtyHostOptions.onPromptSettled} — a single per-instance callback
 * keyed by `deliveryId` — to a per-delivery awaitable, for a delivery-saga caller
 * constructed AFTER the `PtyHostService` it reports into.
 *
 * WHY THIS EXISTS: `PtyHostService` takes `onPromptSettled` only at construction
 * (same constraint `onSessionStatus` already has, for the same reason — see
 * `PtyHostService`'s own docs), but a real composition root builds the delivery
 * saga (which needs to AWAIT a specific delivery's outcome) strictly after the
 * host it is wired into. This class is the closure that lets construction order
 * be host-first without the saga ever touching `PtyHostService` internals.
 *
 * NOT keyed by sessionId: `deliveryId` is already the durable saga's own
 * correlation id (minted once at reserve time), so it is unique across the
 * whole saga's lifetime — no risk of collision the way a bare sessionId would
 * have under concurrent deliveries to the same session.
 *
 * ORDERING IS LOAD-BEARING. Register the wait BEFORE admitting the delivery:
 *
 *   const outcomePromise = waiter.awaitOutcome(deliveryId);
 *   const admitted = await pty.deliverPrompt(sessionId, content, mode, deliveryId);
 *   if (!admitted) { waiter.cancel(deliveryId); return refused; }
 *   const result = await outcomePromise;
 *
 * NEVER the other order. `writePromptToEntry`'s closed loop can — in the
 * pure-control-chars edge case where every intermediate wait resolves
 * synchronously — settle and call `resolve` before `deliverPrompt`'s own
 * `Promise<boolean>` has even settled. Registering the wait first means a
 * same-tick `resolve` still finds its pending entry; registering it after would
 * make that outcome vanish and hang the caller forever.
 */

export interface PromptSettlementResult {
  outcome: 'delivered' | 'unknown';
  reason?: string;
}

export class PromptSettlementWaiter {
  private readonly pending = new Map<string, (result: PromptSettlementResult) => void>();

  /**
   * Pass this AS `PtyHostOptions.onPromptSettled` when constructing the host —
   * it is bound (an arrow-function class field), so it can be handed around
   * without a wrapper closure or a stale `this`.
   */
  readonly resolve = (
    _sessionId: string,
    deliveryId: string,
    outcome: 'delivered' | 'unknown',
    reason?: string,
  ): void => {
    const resolvePending = this.pending.get(deliveryId);
    // No one is waiting (never registered, already resolved, or cancelled) —
    // not an error; a delivery admitted without this waiter in the loop at all
    // reports here exactly the same way and nobody is listening for it.
    if (!resolvePending) return;
    this.pending.delete(deliveryId);
    resolvePending({ outcome, reason });
  };

  /**
   * Register a wait for `deliveryId`'s eventual outcome. Call BEFORE admitting
   * the delivery through `deliverPrompt` — see the class docs for why.
   *
   * No timeout here, deliberately: every `pendingPrompts` deletion path in
   * `PtyHostService` (kill, natural process exit, shutdownAll) already reports
   * 'unknown' for anything still queued at that moment, so a delivery that was
   * genuinely admitted is always eventually resolved by `resolve` above. A
   * delivery that was NEVER admitted (a bound rejection) will not be — the
   * caller must `cancel` it instead of leaking a pending entry forever.
   */
  awaitOutcome(deliveryId: string): Promise<PromptSettlementResult> {
    return new Promise((resolvePromise) => {
      this.pending.set(deliveryId, resolvePromise);
    });
  }

  /**
   * Abandon a registered wait that will never resolve on its own — the ONLY
   * case is `deliverPrompt` rejecting admission, since `writePromptToEntry`
   * (and therefore `resolve`) never runs for a delivery that was never queued.
   * Safe to call after the wait has already resolved (a no-op then).
   */
  cancel(deliveryId: string): void {
    this.pending.delete(deliveryId);
  }
}
