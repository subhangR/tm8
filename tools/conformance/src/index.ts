// @tm8/conformance — contract conformance suite. Runs against ANY base URL
// (TM8_CONFORMANCE_BASE_URL, default http://localhost:4610).
// Seeded from the UI build's mock-facade contract tests (R21), extended with:
// error-taxonomy assertions, keyset-cursor behavior (DEV-5), idempotent replay
// (DEV-9), {data, requestId} envelope (DEV-6), capability gating + 501 honesty.
// Placeholder — populated during W0; must run RED against a stub server for G0.

export const DEFAULT_BASE_URL =
  process.env.TM8_CONFORMANCE_BASE_URL ?? "http://localhost:4610";
