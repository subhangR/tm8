import type { SpendCharge, SpendProcessor } from '../../src/core-types.js';

/** Deliberately lives only in test/: no payment implementation is shipped. */
export class TestSpendProcessor implements SpendProcessor {
  readonly kind = 'test';
  configured = true;
  readonly calls: Parameters<SpendProcessor['charge']>[0][] = [];
  readonly lookups: string[] = [];
  readonly outcomes = new Map<string, SpendCharge>();
  next: SpendCharge | null = null;
  throwCharge = false;
  throwLookup = false;

  async charge(input: Parameters<SpendProcessor['charge']>[0]): Promise<SpendCharge> {
    this.calls.push(input);
    const previous = this.outcomes.get(input.idempotencyKey);
    if (previous) return previous;
    if (this.throwCharge) throw new Error('test processor unavailable');
    const outcome = this.next ?? { state: 'done', processorRef: `test-charge-${this.calls.length}`,
      amountMinor: input.amountMinor, currency: input.currency };
    this.outcomes.set(input.idempotencyKey, outcome);
    return outcome;
  }

  async lookup(operationId: string): Promise<SpendCharge | { state: 'not_found' }> {
    this.lookups.push(operationId);
    if (this.throwLookup) throw new Error('test processor lookup unavailable');
    return this.outcomes.get(operationId) ?? { state: 'not_found' };
  }
}
