/**
 * `launch.suggest` — THE one registration of Jev's launch-sheet advice
 * (design 01a0cb80 §5.1).
 *
 * PLACEHOLDER, landed by lane F so the frozen catalog row can ship `v1`: the
 * conformance boundary requires every registerable v1 HTTP operation to be
 * mounted, and the contract must not change again after F. It refuses
 * honestly with the catalog's `not_implemented` (501) — never empty or fake
 * groups — and its body is validated for real already, through
 * `INPUT_SCHEMAS['launch.suggest']`.
 */
import type { FacadeDeps } from '../facade/deps.js';
import type { HandlerRegistry } from '../facade/registry.js';
import { notImplemented } from '../http/errors.js';

export function registerJevHandlers(registry: HandlerRegistry, _deps: FacadeDeps): void {
  // Lane B (task 01a0cca9-7560-7bad-b842-1a0ec0a096df) replaces this body with the real handler.
  registry.register('launch.suggest', async () => {
    throw notImplemented('launch.suggest');
  });
}
