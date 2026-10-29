/**
 * The auth kinds on the wire (TM8 Mobile S4, task 01a1867c). A person signs in
 * as `browser`, `cli` or `mobile` — exactly the kinds `HUMAN_AUTH_KINDS`
 * admits — on every sign-in path, and a session read may name `mobile`.
 */
import { describe, expect, it } from 'vitest';

import {
  AuthClaimInputSchema,
  AuthInviteSignupInputSchema,
  AuthLoginInputSchema,
  AuthSessionListingSchema,
  AuthSessionViewSchema,
  HUMAN_AUTH_KINDS,
  isHumanAuthKind,
} from '../src/index.js';

const PERSON = { username: 'alice', password: 'password-123' };
const SIGN_IN = {
  'auth.login': (kind: unknown) => AuthLoginInputSchema.safeParse({ ...PERSON, kind }).success,
  'auth.claim': (kind: unknown) => AuthClaimInputSchema.safeParse({ ...PERSON, kind }).success,
  'auth.invite.signup': (kind: unknown) => AuthInviteSignupInputSchema.safeParse({ ...PERSON, code: 'inv_x', kind }).success,
};

describe('auth kinds on the wire', () => {
  it('every sign-in path takes exactly the human kinds', () => {
    for (const [op, accepts] of Object.entries(SIGN_IN)) {
      const taken = ['browser', 'cli', 'mobile', 'agent', 'agent_runtime', 'link', 'Mobile', ''].filter(accepts);
      expect(taken, op).toEqual([...HUMAN_AUTH_KINDS]);
      expect(taken.every(isHumanAuthKind), op).toBe(true);
    }
  });

  it('a session view and a sessions-list row may be mobile, with the label the phone chose', () => {
    const session = {
      sessionId: '00000000-0000-4000-8000-0000000000c1',
      kind: 'mobile',
      actingAsTeamMemberId: null,
      label: 'TM8 Mobile · iPhone',
      expiresAt: '2027-01-27T12:00:00.000Z',
    };
    expect(AuthSessionViewSchema.safeParse(session).success).toBe(true);
    expect(AuthSessionListingSchema.safeParse({
      sessionId: session.sessionId,
      kind: 'mobile',
      label: session.label,
      expiresAt: session.expiresAt,
      createdAt: '2026-10-29T12:00:00.000Z',
      lastUsedAt: null,
      spaceId: null,
      spaceName: null,
      parentSessionId: null,
      origin: 'login',
      originEntityId: null,
      owner: { identityId: 'id_alice', displayName: 'Alice' },
      current: true,
    }).success).toBe(true);
  });
});
