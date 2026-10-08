import type { IdentityView } from '../data/seam';

/** Space membership and node authority are separate permissions. */
export function adminAccessFor(identity: IdentityView | null, spaceId: string) {
  const role = identity?.memberships.find((membership) => membership.spaceId === spaceId)?.role;
  return {
    space: role === 'owner' || role === 'admin',
    node: identity?.isNodeAdmin === true || identity?.isOwner === true,
  };
}
