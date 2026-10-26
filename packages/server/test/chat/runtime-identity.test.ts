import { describe, expect, it } from 'vitest';
import { claimsFor } from '../../src/facade/context.js';
import { identityFromSession } from '../../src/http/identity-resolver.js';
import { supportClaims } from '../../src/http/support-claims.js';
import type { RequestContext } from '../../src/http/types.js';
import type { FacadeDeps } from '../../src/facade/deps.js';
import type { ResolvedAuthSession } from '../../src/identity/pg-auth.js';

const session: ResolvedAuthSession = {
  sessionId: '00000000-0000-4000-8000-000000000001',
  accountId: 'account', identityId: 'member', username: 'member', displayName: null,
  isNodeAdmin: false, isOwner: false, kind: 'agent_runtime',
  actingAsTeamMemberId: 'teammate', workSessionId: null, runtimeMemberId: 'member',
  runtimeThreadRootId: null, runtimeChatId: 'chat', runtimeEpoch: 7, runtimeNativeGeneration: 3,
  spaceId: 'space', expiresAt: '2026-10-11T00:00:00.000Z', label: null,
};
const owner = { identityId: 'owner', accountId: 'owner-account', username: 'owner', isNodeAdmin: true, isOwner: true };

describe('chat runtime authorization reference', () => {
  it('passes the verified token row through catalog and support transports', async () => {
    const identity = identityFromSession(session, 'opaque-bearer', 'agents');
    expect(identity.runtimeEpoch).toBe(7);
    expect(identity.runtimeNativeGeneration).toBe(3);
    const context = { identity, requestId: 'request', body: { authSessionId: 'forged', runtimeEpoch: 100 } } as RequestContext;
    const catalog = claimsFor(owner, context);
    expect(catalog.authSessionId).toBe(session.sessionId);
    expect(catalog.authKind).toBe('agent_runtime');
    expect(catalog.sessionSpaceId).toBe('space');
    const support = await supportClaims({ owner: async () => owner } as FacadeDeps, identity, 'support');
    expect(support.authSessionId).toBe(session.sessionId);
    expect(support.authKind).toBe('agent_runtime');
    expect(support.nodeAdmin).toBe(false);
  });

  it('does not invent a bearer row for an auto-owner request', () => {
    const context = { identity: { kind: 'auto-owner', authKind: 'browser', sessionId: 'forged' }, requestId: 'request' } as RequestContext;
    expect(claimsFor(owner, context).authSessionId).toBeUndefined();
  });
});
