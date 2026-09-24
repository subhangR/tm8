/**
 * The one way a credential containment stops an AGENT session: the SC-3 space
 * credential delete, the member Disconnect and SC-6's member removal all call
 * this port, and `SpawnService.containCredentialSession` implements it.
 */
import type { CredentialContainmentCause, CredentialContainmentResult } from '@tm8/execution';

export type { CredentialContainmentCause, CredentialContainmentResult };

/**
 * Kill an AGENT session because a credential was taken away, and record its
 * ending — `SpawnService.containCredentialSession`, which holds the claims the
 * session was spawned with and writes through the same stop path `terminate`
 * does. A bare `terminate` from `CredentialTerminalPort` kills the PTY and
 * writes nothing, which left every contained agent row reading `running`.
 * Login terminals keep `CredentialTerminalPort`: their liveness is
 * `credential_sessions.finished_at`, never `work_sessions.status`.
 */
export interface AgentSessionContainmentPort {
  containCredentialSession(
    sessionId: string,
    cause: CredentialContainmentCause,
  ): Promise<CredentialContainmentResult>;
}

/**
 * The `failures` reason for one contained agent session, or null when it was
 * contained cleanly: a kill that failed (the row keeps its status), or a kill
 * whose ending could not be written (the row still reads live).
 */
export function containmentFailureOf(result: CredentialContainmentResult): string | null {
  if (result.outcome === 'error') return 'the PTY host could not kill this agent session';
  if (result.outcome === 'killed' && !result.recorded) {
    return `the session was killed, but its ending could not be recorded (${result.reason ?? 'unknown'})`;
  }
  return null;
}
