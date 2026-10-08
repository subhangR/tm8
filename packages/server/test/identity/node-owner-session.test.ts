import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/db/types.js';
import { resolveLoopbackOwner } from '../../src/identity/loopback.js';
import type { ResolvedAuthSession } from '../../src/identity/pg-auth.js';
import { identityFromSession } from '../../src/http/identity-resolver.js';

function session(
  overrides: Partial<ResolvedAuthSession> = {},
): ResolvedAuthSession {
  return {
    sessionId: 'session',
    accountId: 'account',
    identityId: 'identity',
    username: 'owner',
    displayName: null,
    isNodeAdmin: false,
    isOwner: false,
    kind: 'browser',
    actingAsTeamMemberId: null,
    workSessionId: null,
    runtimeMemberId: null,
    runtimeThreadRootId: null,
    runtimeChatId: null,
    spaceId: null,
    expiresAt: '2030-01-01T00:00:00.000Z',
    label: null,
    ...overrides,
  };
}

describe('node authority from a verified session', () => {
  it.each([
    [false, false, false],
    [true, false, true],
    [false, true, true],
    [true, true, true],
  ])(
    'admin=%s owner=%s yields node authority=%s',
    (isNodeAdmin, isOwner, expected) => {
      expect(
        identityFromSession(
          session({ isNodeAdmin, isOwner }),
          'token',
          'agents',
        ).nodeAdmin,
      ).toBe(expected);
    },
  );

  it.each(['agents', 'enforce'] as const)(
    'a space-pinned owner retains no node authority in %s mode',
    (mode) => {
      const identity = identityFromSession(
        session({ isOwner: true, spaceId: 'space' }),
        'token',
        mode,
      );
      expect(identity.nodeAdmin).toBe(false);
      expect(identity.sessionSpaceId).toBe('space');
    },
  );
});

describe('loopback owner authority', () => {
  it.each([
    {
      accountId: 'account',
      identityId: 'identity',
      isNodeAdmin: false,
      isOwner: true,
    },
    {
      id: 'account',
      identity_id: 'identity',
      is_node_admin: false,
      is_owner: true,
    },
  ])(
    'normalizes owner-only node authority from either RPC casing',
    async (row) => {
      const rpc = vi.fn().mockResolvedValue(row);
      const owner = await resolveLoopbackOwner({ rpc } as unknown as Db);
      expect(owner).toMatchObject({
        identityId: 'identity',
        isNodeAdmin: true,
        isOwner: true,
      });
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(rpc).toHaveBeenCalledWith({}, 'resolve_node_owner', []);
    },
  );
});
