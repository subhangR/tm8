import type { CredentialsSpaceListView, SpaceCredentialView } from '@tm8/contract';
import { describe, expect, it } from 'vitest';

import { jevKeyStateOf } from './credentials-link';

const row = (over: Partial<SpaceCredentialView>): SpaceCredentialView => ({
  id: 'c1', spaceId: 's1', provider: 'typesafe', shape: 'api_key', label: 'Jev', isDefault: false, status: 'active',
  createdByAccountId: 'a1', displayLogin: null, keyHint: 'QRST', createdAt: '', updatedAt: '', lastUsedAt: null, lastProbeAt: null,
  ...over,
});
const list = (...credentials: SpaceCredentialView[]): CredentialsSpaceListView => ({ spaceId: 's1', credentials });

describe('jevKeyStateOf — ✦’s key from the space list (my_default → space default → no_key)', () => {
  it('none: the space holds no TypeSafe credential (another provider’s default does not count)', () => {
    expect(jevKeyStateOf(list())).toBe('none');
    expect(jevKeyStateOf(list(row({ provider: 'anthropic', isDefault: true })))).toBe('none');
    expect(jevKeyStateOf(list(row({ status: 'revoked', isDefault: true })))).toBe('none');
  });

  it('yes: an active TypeSafe space default', () => {
    expect(jevKeyStateOf(list(row({ isDefault: true })))).toBe('yes');
  });

  it('unknown: a TypeSafe credential that is not the active default may still be the viewer’s my_default', () => {
    expect(jevKeyStateOf(list(row({ visibility: 'private' })))).toBe('unknown');
    expect(jevKeyStateOf(list(row({ isDefault: true, status: 'stale' })))).toBe('unknown');
  });
});
