import { describe, expect, it } from 'vitest';
import type { IdentityView } from '../data/seam';
import { adminAccessFor } from './admin-access';

const identity = (patch: Partial<IdentityView> = {}): IdentityView => ({
  identityId: 'identity', accountId: 'account', username: 'alex', displayName: 'Alex',
  avatar: null, email: null, globalId: null, isNodeAdmin: false, isOwner: false,
  status: 'active', actingAs: null, memberships: [], ...patch,
});

describe('admin navigation authority', () => {
  it('offers neither admin page until identity resolves', () => {
    expect(adminAccessFor(null, 'space')).toEqual({ space: false, node: false });
  });
  it.each(['admin', 'owner'])('offers Space admin to a space %s only', (role) => {
    const viewer = identity({ memberships: [{ spaceId: 'space', memberId: 'm', role }] });
    expect(adminAccessFor(viewer, 'space')).toEqual({ space: true, node: false });
    expect(adminAccessFor(viewer, 'other-space')).toEqual({ space: false, node: false });
  });
  it.each([{ isNodeAdmin: true }, { isOwner: true }])('offers Node admin independently of space standing: %j', (authority) => {
    expect(adminAccessFor(identity(authority), 'space')).toEqual({ space: false, node: true });
  });
  it('does not promote an ordinary space member', () => {
    expect(adminAccessFor(identity({ memberships: [{ spaceId: 'space', memberId: 'm', role: 'member' }] }), 'space'))
      .toEqual({ space: false, node: false });
  });
});
