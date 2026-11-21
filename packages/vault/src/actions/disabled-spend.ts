import type { SpendProcessor } from '../core-types.js';

/** The only processor implementation shipped by v1. No payment transport exists. */
export const disabledSpendProcessor: SpendProcessor = Object.freeze({
  kind: 'disabled',
  configured: false,
  charge: async () => ({ state: 'declined' as const }),
  lookup: async () => ({ state: 'not_found' as const }),
});
