/**
 * HOW A SPAWN FAILED, IN THE HAND-OFF'S TERMS (task 01a182d2).
 *
 * CONTRACT: pure. `isLaunchTimeout(error)` — did the TRANSPORT give up (the
 * launch may have reached the node and started) rather than the node refuse?
 * `launchFailureOf(error)` — the node's own words and code, for the page.
 * Called by the hand-off (`views/useLaunchHandoff.ts`); the launch popup's
 * in-card path (hosts without the seam) answers the same question and should
 * import this rather than keep its own test.
 */
import type { LaunchFailure } from './store';

/**
 * `upstream_unavailable` is the http client's code for every way the node did
 * not answer — a deadline, an unreachable node, a non-JSON body — and the
 * message test catches a wrapper that kept only the sentence.
 */
export function isLaunchTimeout(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null | undefined;
  return e?.code === 'upstream_unavailable' || /did not answer within/.test(String(e?.message ?? ''));
}

export function launchFailureOf(error: unknown): LaunchFailure {
  const e = error as { code?: unknown; message?: unknown } | null | undefined;
  const message = String(e?.message ?? error ?? '').trim();
  return {
    message: message || 'The node refused this launch and gave no reason.',
    code: typeof e?.code === 'string' ? e.code : null,
    uncertain: false,
  };
}
