import { describe, it } from 'vitest';
import { describeStoreConformance } from '../support/store-conformance.js';
import { PG_ENABLED, PG_REASON, pgHarness } from './pg-harness.js';

if (PG_ENABLED) describeStoreConformance('pg', pgHarness);
else describe('VaultStore conformance: pg', () => {
  it('requires a scratch Postgres (all hooks enabled when configured)', (ctx) => ctx.skip(PG_REASON));
});
