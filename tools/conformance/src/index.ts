// @tm8/conformance — W1 foundation/generation gate plus separately-invoked
// live semantic suites. The default package test is intentionally independent
// of W2 server semantics; see README.md and `bun run test:live`.

export const DEFAULT_BASE_URL =
  process.env.TM8_CONFORMANCE_BASE_URL ?? "http://localhost:4610";

export * from './foundations/conformance-cases.js';
export * from './foundations/generator.js';
export * from './foundations/kind-dispositions.js';
export * from './foundations/migration-inventory.js';
export * from './foundations/schema-dispositions.js';
