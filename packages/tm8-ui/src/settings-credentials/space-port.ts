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
 */
import type {
  CredentialPolicySource,
  CredentialsSpaceCreateInput,
  CredentialsSpaceDeleteResult,
  CredentialsSpacePolicySetResult,
  CredentialsSpacePolicyView,
  NodeCredentialPolicyEntry,
  NodeCredentialsStatusView,
  SpaceCredentialProviderName,
  SpaceCredentialView,
  SpaceId,
} from '@tm8/contract';
import type { Seam } from '../data/seam';

/** Who is looking — decides which controls are drawn, never what is allowed. */
export interface SpaceCredentialsViewer {
  accountId: string | null;
  /** Owner or admin of THIS space (D11, D5). */
  isSpaceAdmin: boolean;
  isNodeAdmin: boolean;
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

export function spaceCredentialsPortFromSeam(
  seam: Pick<Seam, 'credentials' | 'identity'>,
  spaceId: SpaceId,
  ownerWord: string | null,
): SpaceCredentialsPort {
  return {
    viewer: async () => {
      const identity = await seam.identity();
      const membership = identity.memberships.find((m) => m.spaceId === spaceId);
      return {
        accountId: identity.accountId ?? null,
        isSpaceAdmin: isSpaceAdminRole(membership?.role, ownerWord),
        isNodeAdmin: identity.isNodeAdmin === true,
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
  };
}
