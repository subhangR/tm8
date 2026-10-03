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
  CredentialConnectionView,
  CredentialProviderName,
  CredentialsDeleteResult,
  CredentialsLoginSessionFinishResult,
  CredentialsLoginSessionStartResult,
  CredentialsServiceKeyDeleteResult,
  CredentialsServiceKeysStatusView,
  CredentialsStatusView,
  ServiceKeyProviderName,
  ServiceKeyView,
  SpaceId,
  SpaceCredentialView,
  Cursor,
  EntityKind,
} from '@tm8/contract';
import type { Seam } from '../data/seam';
import { memberKindRef } from '../settings-space/port';
import { presentationOf } from './provider-presentation';

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

/** Metadata-only adapter for adding a personal connection to a space. */
export interface CredentialsSharePort {
  currentSpaceId: string;
  spaces(): Promise<Array<{ id: string; name: string }>>;
  members(spaceId: string): Promise<Array<{ id: string; name: string }>>;
  addMine(spaceId: string, label: string): Promise<SpaceCredentialView>;
  startPrivateLogin(spaceId: string, provider: 'anthropic' | 'openai', label: string): Promise<CredentialsLoginSessionStartResult>;
  finishLogin(workSessionId: string): Promise<CredentialsLoginSessionFinishResult>;
  share(credentialId: string, memberId: string): Promise<void>;
}

export function credentialsSharePortFromSeam(
  seam: Pick<Seam, 'credentials' | 'spaces' | 'query' | 'identity'>,
  currentSpaceId: SpaceId,
): CredentialsSharePort {
  return {
    currentSpaceId,
    spaces: () => seam.spaces(),
    async members(spaceId) {
      const identity = await seam.identity();
      const self = identity.memberships.find((m) => m.spaceId === spaceId)?.memberId;
      const members: Array<{ id: string; name: string }> = [];
      let cursor: Cursor | undefined;
      do {
        const result = await seam.query({ spaceId, kinds: [memberKindRef() as EntityKind], limit: 100, ...(cursor ? { cursor } : {}) });
        for (const row of result.page.items) {
          const ended = row.state && 'memberStatus' in row.state && row.state.memberStatus;
          if (row.id !== self && !ended) members.push({ id: row.id, name: row.title });
        }
        cursor = result.page.nextCursor ?? undefined;
      } while (cursor);
      return members;
    },
    addMine: (spaceId, label) => seam.credentials.space.addMine(spaceId, 'github', label),
    async startPrivateLogin(spaceId, provider, label) {
      // OAuth refresh tokens must never be copied from the personal home.
      const started = await seam.credentials.startLogin(spaceId, provider, { label });
      const id = started.spaceCredential?.id;
      try {
        if (!id) throw new Error('The server did not name the new space credential.');
        await seam.credentials.space.claim(id);
        await seam.credentials.space.setVisibility(id, 'private');
        return started;
      } catch (error) {
        // The terminal must not be exposed until its pending credential is private.
        if (id) {
          try {
            await seam.credentials.space.remove(id);
          } catch {
            throw new Error(`Could not make the new login private or remove it. Delete the pending credential “${label}” in Space credentials before retrying.`);
          }
        }
        throw error;
      }
    },
    finishLogin: (workSessionId) => seam.credentials.finishLogin(workSessionId),
    async share(credentialId, memberId) {
      // The RPC resolves a member entity id within this credential's space.
      await seam.credentials.space.share(credentialId, memberId);
    },
  };
}

export function credentialsPortFromSeam(
  seam: Pick<Seam, 'credentials'>,
  spaceId: SpaceId,
): CredentialsPort {
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

/**
 * Service keys — keys the SERVER uses for this member (today only TypeSafe,
 * for ✦ Ask Jev). A separate port because they are not agent credentials: no
 * login terminal, no probe, no session to kill, and never given to an agent.
 */
export interface ServiceKeysPort {
  load(): Promise<CredentialsServiceKeysStatusView>;
  /** The key goes out once; the answer carries its last four characters only. */
  save(provider: ServiceKeyProviderName, apiKey: string): Promise<ServiceKeyView>;
  remove(provider: ServiceKeyProviderName): Promise<CredentialsServiceKeyDeleteResult>;
}

export function serviceKeysPortFromSeam(seam: Pick<Seam, 'credentials'>): ServiceKeysPort {
  return {
    load: () => seam.credentials.serviceKeys(),
    save: (provider, apiKey) => seam.credentials.saveServiceKey(provider, apiKey),
    remove: (provider) => seam.credentials.removeServiceKey(provider),
  };
}

// ---------------------------------------------------------------------------
// The honest-degradation vocabulary — FOUR states, never two
// ---------------------------------------------------------------------------

/**
 * What this screen is allowed to SAY about one provider.
 *
 * `unavailable` and `unknown` are different successful claims about what was
 * measured. Unavailable means the binary is absent; unknown means no answer
 * about connection state was established. Collapsing either into disconnected
 * invites a user to start a flow that will fail or repeat one they already did.
 */
export type ConnectionVerdict =
  /** Connected, and there is a vendor-side account name to show. */
  | 'connected-named'
  /** Connected, and the probe supplied no name. Complete, not pending. */
  | 'connected-unnamed'
  /** Measured false — this member genuinely has not connected this provider. */
  | 'disconnected'
  /** Measured absence — this provider's CLI binary is not installed here. */
  | 'unavailable'
  /** NOT MEASURED. A probe/store could not establish a connection answer. */
  | 'unknown';

/**
 * The verdict for one provider entry, given the store's own completeness.
 *
 * ORDER MATTERS. A positive answer stays trusted. After that, an absent binary
 * is the most specific measured result, a stale probe (or absent legacy GitHub
 * store) is unknown, and only the remainder is a measured disconnection.
 *
 * A CONNECTED ANSWER IS STILL TRUSTED under an absent store: the value can only
 * have come from somewhere real, and downgrading a positive to `unknown` would
 * invent a doubt the data does not support.
 */
export function verdictOf(
  entry: Pick<CredentialConnectionView, 'provider' | 'connected' | 'login' | 'status'>,
  gitCredentialStore: 'present' | 'absent',
): ConnectionVerdict {
  if (entry.connected) {
    // NULL is a complete answer: legacy Anthropic rows have it forever, and
    // Cursor's measured status proves authentication without naming an account.
    // Neither positive result is missing data that the renderer should await.
    return entry.login === null ? 'connected-unnamed' : 'connected-named';
  }
  if (entry.status === 'unavailable') return 'unavailable';
  if (entry.status === 'stale') return 'unknown';

  // The rolling-upgrade completeness field predates per-provider measurement.
  // Its one provider-specific fact lives in the presentation table, so this
  // port still contains no second switch/list that can drift from the UI.
  const presentation = presentationOf(entry.provider);
  if (presentation.needsGitCredentialStore && gitCredentialStore === 'absent') {
    return 'unknown';
  }
  return 'disconnected';
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
