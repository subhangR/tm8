/**
 * HOW A SPAWN FAILED, IN THE LAUNCH'S TERMS (task 01a182d2) — the one
 * predicate and the one set of sentences for a launch the node did not answer.
 *
 * CONTRACT: pure. `isLaunchTimeout(error)` — did the TRANSPORT give up (the
 * launch may have reached the node and started) rather than the node refuse?
 * `launchFailureOf(error)` — the node's own words and code, for the page.
 * `LAUNCH_TIMEOUT_WORDS` — what a surface says while it finds out.
 * Called by the hand-off (`views/useLaunchHandoff.ts`) and by the launch
 * popup's in-card path (hosts without the seam): both import these, so the
 * two never describe the same moment differently.
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

export const LAUNCH_TIMEOUT_WORDS = {
  checking: 'The node didn’t answer in time — the launch may have started. Checking…',
  cannotCheck: 'The node didn’t answer in time — the launch may have started. This surface can’t check, so look at the task’s sessions before launching again.',
  started: (title: string) => `It started: “${title}” is working on this task. Nothing more to launch.`,
  /** Sessions started on the subject since the press — this launch's, or a teammate's: the person picks. */
  foundSince: 'The node didn’t answer in time. These sessions started on this task since — open the one this launch started, or retry.',
  none: 'No session started on this task. Launch again to retry.',
  checkFailed: 'The node didn’t answer in time, and checking for the session failed too — look at the task’s sessions before launching again.',
} as const;
