/**
 * THE LAUNCHING PAGE'S HOST (task 01a182d2) — what the page can ask of the
 * surface it is drawn in: its two verbs, Edit and retry and Dismiss, and the
 * re-attach a page needs when it finds a launch this window holds no record of.
 *
 * CONTRACT: a React context. Provided by the surface that can do these —
 * Work's `LaunchPageHostProvider`, which holds the launch port the retry popup
 * needs and the runtime a Dismiss closes a tab in. Read by the page
 * (`panels/bodies/SessionLaunching.tsx`) and Work's launch tab body, both drawn
 * levels below anything that could pass these as props. No provider ⇒ null ⇒
 * the page draws no buttons rather than buttons that cannot act.
 *
 * Keyed by the launch's record id (its clientMutationId), the one name the
 * page, the store and the hand-off share.
 */
import { createContext, useContext } from 'react';
import type { EntityId, ExecutionSpawnInput } from '@tm8/contract';
import type { LaunchStarted } from '../new-session/launch-started';
import type { LaunchFailure } from './store';

export interface LaunchPageHost {
  /** Re-open the launch popup on the subject, with the launch's notes as its draft. */
  editAndRetry(launchId: string): void;
  /** Forget the launch and close its tab. A session that started keeps running. */
  dismiss(launchId: string): void;
  /** The person picked, among the sessions a timed-out check found, the one this launch started. */
  choose(launchId: string, sessionId: EntityId): void;
  /**
   * Re-attach to a launch this window holds no record of (a reload, another
   * window) from what its tab stored. Fire and forget: the host owns any replay.
   */
  resume(launch: LaunchStarted, input: ExecutionSpawnInput | null, startedAt: number, failure: LaunchFailure | null): void;
}

export const LaunchPageHostContext = createContext<LaunchPageHost | null>(null);

export function useLaunchPageHost(): LaunchPageHost | null {
  return useContext(LaunchPageHostContext);
}
