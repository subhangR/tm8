/**
 * THE SPACE-CREDENTIALS PORT — Settings → Space credentials and Settings →
 * Node credentials (SC-5). The same rule as `port.ts`: the components take
 * this narrow surface and never import a seam, so a fixture and a real node
 * are indistinguishable to them.
 *
 * EVERY WRITE BEHIND THIS IS HUMAN-ONLY (I2), at the facade and again in SQL.
 * Management rights (D11: the creator or a space admin) and the policy writers
 * (space admin, node admin) are the SERVER's to enforce. The viewer standing
 * read here only decides which controls to draw; a refusal the server still
 * answers is rendered as a refusal, never swallowed.
 *
 * No method here takes or returns a secret except the two that SEND one
 * (`create`, `rekey`), and their answers are metadata only (I5).
 *
 * A SPACE LOGIN (SC-4) rides the member login ops with a `spaceCredential`
 * target. There is no separate close: an EXPIRED terminal still holding a
 * credential is reclaimed server-side by starting again onto that credential
 * (`{ credentialId }`), which kills the PTY before stamping it failed (N1).
 * Nothing here closes a login by finishing it as a success or by deleting.
 */
import type {
  CredentialPolicySource,
  CredentialsLoginSessionFinishResult,
  CredentialsLoginSessionStartInput,
  CredentialsLoginSessionStartResult,
  CredentialsSpaceCreateInput,
  CredentialsSpaceDeleteResult,
  CredentialsSpaceMyDefaultResult,
  CredentialsSpaceSetVisibilityResult,
  CredentialsSpaceUsageView,
  SpaceCredentialVisibilityName,
  CredentialsSpacePolicySetResult,
  CredentialsSpacePolicyView,
  NodeCredentialPolicyEntry,
  NodeCredentialsStatusView,
  SpaceCredentialProviderName,
  SpaceCredentialView,
  EntityId,
  SpaceId,
} from '@tm8/contract';
import type { Seam } from '../data/seam';

/** The two vendors a login terminal runs (206); GitHub is token-only. */
export type SpaceLoginProvider = 'anthropic' | 'openai';

/** `{ label }`: a new pending credential (any member). `{ credentialId }`: log in again (creator or admin). */
export type SpaceLoginTarget = NonNullable<CredentialsLoginSessionStartInput['spaceCredential']>;

/** Who is looking — decides which controls are drawn, never what is allowed. */
export interface SpaceCredentialsViewer {
  accountId: string | null;
  /** Owner or admin of THIS space (D11, D5). */
  isSpaceAdmin: boolean;
  isNodeAdmin: boolean;
  /**
   * Doc 13 §6b: more than one person uses this server (node mode `multi`),
   * so the private-switch carries the shared-server warning. Unknown counts
   * as shared: the warning is safe to show and dangerous to hide.
   */
  sharedServer: boolean;
}

export interface SpaceCredentialsPort {
  viewer(): Promise<SpaceCredentialsViewer>;
  list(): Promise<SpaceCredentialView[]>;
  create(input: Omit<CredentialsSpaceCreateInput, 'clientMutationId'>): Promise<SpaceCredentialView>;
  rekey(credentialId: string, secret: string): Promise<SpaceCredentialView>;
  rename(credentialId: string, label: string): Promise<SpaceCredentialView>;
  setDefault(credentialId: string): Promise<SpaceCredentialView>;
  remove(credentialId: string): Promise<CredentialsSpaceDeleteResult>;
  policy(): Promise<CredentialsSpacePolicyView>;
  setPolicy(
    provider: SpaceCredentialProviderName,
    allowedSources: CredentialPolicySource[] | null,
  ): Promise<CredentialsSpacePolicySetResult>;
  nodeStatus(): Promise<NodeCredentialsStatusView>;
  setNodePolicy(provider: SpaceCredentialProviderName, allowNode: boolean | null): Promise<NodeCredentialPolicyEntry>;
  startLogin(provider: SpaceLoginProvider, target: SpaceLoginTarget): Promise<CredentialsLoginSessionStartResult>;
  finishLogin(workSessionId: string): Promise<CredentialsLoginSessionFinishResult>;
  // W10b/W10d (doc 13 §7). Human-only at the server; refusals render its reason.
  setVisibility(credentialId: string, visibility: SpaceCredentialVisibilityName): Promise<CredentialsSpaceSetVisibilityResult>;
  spaceDefaultConsent(credentialId: string, allowed: boolean): Promise<SpaceCredentialView>;
  claim(credentialId: string): Promise<SpaceCredentialView>;
  setMyDefault(credentialId: string): Promise<CredentialsSpaceMyDefaultResult>;
  clearMyDefault(provider: SpaceCredentialProviderName): Promise<CredentialsSpaceMyDefaultResult>;
  usage(credentialId: string): Promise<CredentialsSpaceUsageView>;
  /** "Add to this space as private" for my own server-level GitHub token — no secret leaves the client. */
  addMine(provider: 'github', label: string): Promise<SpaceCredentialView>;
}

/**
 * The space-admin words. The server's `internal.is_space_admin` is the
 * authority; this mirrors it for drawing only. `ownerWord` is the registry's
 * owner role (`ownerRoleRef()`), passed in so this file stays free of the
 * settings-space registry.
 */
export function isSpaceAdminRole(role: string | null | undefined, ownerWord: string | null): boolean {
  if (!role) return false;
  return role === 'admin' || role === 'owner' || (ownerWord !== null && role === ownerWord);
}

/**
 * Is this a shared server? `mode` is `auth.claim.status`'s node mode; only a
 * measured `single` is single-user. Null (not yet known, or unreadable) is
 * shared, so the §6b warning is never hidden on a guess.
 */
export function isSharedServer(mode: 'single' | 'multi' | null | undefined): boolean {
  return mode !== 'single';
}

export function spaceCredentialsPortFromSeam(
  seam: Pick<Seam, 'credentials' | 'identity'>,
  spaceId: SpaceId,
  ownerWord: string | null,
  nodeMode: () => Promise<'single' | 'multi' | null> = async () => null,
): SpaceCredentialsPort {
  return {
    viewer: async () => {
      const [identity, mode] = await Promise.all([seam.identity(), nodeMode().catch(() => null)]);
      const membership = identity.memberships.find((m) => m.spaceId === spaceId);
      return {
        accountId: identity.accountId ?? null,
        isSpaceAdmin: isSpaceAdminRole(membership?.role, ownerWord),
        isNodeAdmin: identity.isNodeAdmin === true,
        sharedServer: isSharedServer(mode),
      };
    },
    list: async () => (await seam.credentials.space.list(spaceId)).credentials,
    create: (input) => seam.credentials.space.create(spaceId, input),
    rekey: (credentialId, secret) => seam.credentials.space.rekey(credentialId, secret),
    rename: (credentialId, label) => seam.credentials.space.rename(credentialId, label),
    setDefault: (credentialId) => seam.credentials.space.setDefault(credentialId),
    remove: (credentialId) => seam.credentials.space.remove(credentialId),
    policy: () => seam.credentials.space.policy(spaceId),
    setPolicy: (provider, allowedSources) => seam.credentials.space.setPolicy(spaceId, provider, allowedSources),
    nodeStatus: () => seam.credentials.node.status(),
    setNodePolicy: (provider, allowNode) => seam.credentials.node.setPolicy(provider, allowNode),
    startLogin: (provider, target) => seam.credentials.startLogin(spaceId, provider, target),
    finishLogin: (workSessionId) => seam.credentials.finishLogin(workSessionId as EntityId),
    setVisibility: (credentialId, visibility) => seam.credentials.space.setVisibility(credentialId, visibility),
    spaceDefaultConsent: (credentialId, allowed) => seam.credentials.space.spaceDefaultConsent(credentialId, allowed),
    claim: (credentialId) => seam.credentials.space.claim(credentialId),
    setMyDefault: (credentialId) => seam.credentials.space.setMyDefault(credentialId),
    clearMyDefault: (provider) => seam.credentials.space.clearMyDefault(spaceId, provider),
    usage: (credentialId) => seam.credentials.space.usage(credentialId),
    addMine: (provider, label) => seam.credentials.space.addMine(spaceId, provider, label),
  };
}
