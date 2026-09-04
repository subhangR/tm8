/**
 * THE CREDENTIALS PORT — this module's only knowledge that a seam exists.
 *
 * Same rule, same reason as `settings-space/port.ts`: components below take
 * data and callbacks and cannot tell a fixture from a real node, so the one
 * adapter lives here and the host wires it. Nothing in `settings-credentials/`
 * imports a seam implementation.
 *
 * THE FOUR OPERATIONS BEHIND THIS ARE HUMAN-ONLY (R2), enforced server-side on
 * `ctx.identity.authKind` with a `browser|cli` allowlist. A browser session is
 * on the allowed side, which is the only reason this screen can exist. Nothing
 * here weakens, wraps or routes around that guard — including for `status`,
 * whose human-only-ness is deliberate and not an oversight to be helpfully
 * corrected later.
 */
import type {
  CredentialProviderName,
  CredentialsDeleteResult,
  CredentialsLoginSessionFinishResult,
  CredentialsLoginSessionStartResult,
  CredentialsStatusView,
  SpaceId,
} from '@tm8/contract';
import type { Seam } from '../data/seam';

/** The narrow surface the credentials components consume. */
export interface CredentialsPort {
  /** The merged view AND its own completeness report (`gitCredentialStore`). */
  load(): Promise<CredentialsStatusView>;
  /** Disconnect. May answer `revoked: true` WITH failures — that is normal. */
  disconnect(provider: CredentialProviderName): Promise<CredentialsDeleteResult>;
  /** Opens the login PTY; the answer names the work_session to host. */
  startLogin(provider: CredentialProviderName): Promise<CredentialsLoginSessionStartResult>;
  /** Harvests the result. `connected` and `stored` are separate answers. */
  finishLogin(workSessionId: string): Promise<CredentialsLoginSessionFinishResult>;
}

export function credentialsPortFromSeam(seam: Seam, spaceId: SpaceId): CredentialsPort {
  return {
    load: () => seam.credentials.status(),
    disconnect: (provider) => seam.credentials.disconnect(provider),
    // The spaceId is bound HERE rather than asked of the component: the login
    // terminal is a work_session and must be born somewhere, but which space
    // that is is a fact about the host, not a choice the screen offers.
    startLogin: (provider) => seam.credentials.startLogin(spaceId, provider),
    finishLogin: (workSessionId) => seam.credentials.finishLogin(workSessionId),
  };
}

// ---------------------------------------------------------------------------
// The honest-degradation vocabulary — THREE states, never two
// ---------------------------------------------------------------------------

/**
 * What this screen is allowed to SAY about one provider.
 *
 * `unknown` exists because collapsing it into `disconnected` is the single
 * most likely defect on this surface and the one that looks completely fine:
 * a user told "Not connected" will go and connect something that may already
 * be connected. It is a separate word so a test can require the difference.
 */
export type ConnectionVerdict =
  /** Connected, and there is a vendor-side account name to show. */
  | 'connected-named'
  /** Connected, and there NEVER will be a name. Not pending, not missing. */
  | 'connected-unnamed'
  /** Measured false — this member genuinely has not connected this provider. */
  | 'disconnected'
  /** NOT MEASURED. The store this answer would come from does not exist here. */
  | 'unknown';

/**
 * The verdict for one provider entry, given the store's own completeness.
 *
 * ORDER MATTERS. `unknown` is tested FIRST, because the shape of the bug this
 * prevents is a `connected: false` that was never measured: when
 * `gitCredentialStore` is `absent`, the github entry's `connected` is false
 * for want of a table to read, not because anyone looked. Reading `connected`
 * before checking the store is how "Not connected" gets printed under a fact
 * nobody established.
 *
 * A CONNECTED ANSWER IS STILL TRUSTED under an absent store: the value can only
 * have come from somewhere real, and downgrading a positive to `unknown` would
 * invent a doubt the data does not support.
 */
export function verdictOf(
  entry: { provider: CredentialProviderName; connected: boolean; login: string | null },
  gitCredentialStore: 'present' | 'absent',
): ConnectionVerdict {
  if (entry.provider === 'github' && gitCredentialStore === 'absent' && !entry.connected) {
    return 'unknown';
  }
  if (!entry.connected) return 'disconnected';
  // Connected with no login is a legal shape: rows minted under the original
  // R4 verb (`claude setup-token`, `user:inference` only) never learned a
  // name. Post-amendment `claude auth login` grants `user:profile`, so new
  // anthropic rows carry an email — but this verdict stays, so the screen can
  // omit the field for old rows instead of drawing an empty one, a spinner,
  // or "unknown user".
  return entry.login === null ? 'connected-unnamed' : 'connected-named';
}

/**
 * How a disconnect actually went. `revoked: true` alongside a non-empty
 * `failures` is the NORMAL outcome (R3), not a contradiction: the credential
 * can be revoked while a session it opened refuses to die. It gets its own
 * word so the screen can neither hide the failures behind a tick nor imply
 * with a red that the revoke did not happen.
 */
export type DisconnectVerdict = 'clean' | 'partial' | 'failed';

export function disconnectVerdictOf(result: CredentialsDeleteResult): DisconnectVerdict {
  if (!result.revoked) return 'failed';
  return result.failures.length > 0 ? 'partial' : 'clean';
}
