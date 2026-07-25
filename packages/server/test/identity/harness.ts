/**
 * Shared fixture for the identity suite.
 *
 * Deterministic by construction: a hand-driven clock and sequential ids, plus a
 * fast password hasher — real scrypt is ~100ms a call and the suite makes many,
 * so the hashing algorithm gets its own dedicated test instead of taxing every
 * other one.
 */

import {
  IdentityServiceImpl,
  InMemoryIdentityRepository,
  ManualClock,
  SequentialIds,
  type IdentityService,
  type MemberRecord,
  type PasswordHasher,
  type TeamMemberRecord,
} from '../../src/identity/index.js';

/** Not a security primitive — a stand-in so tests run in milliseconds. */
export class FakeHasher implements PasswordHasher {
  readonly algorithm = 'scrypt' as const;
  calls = 0;
  async hash(password: string): Promise<string> {
    this.calls += 1;
    return `fake$${password}`;
  }
  async verify(password: string, stored: string): Promise<boolean> {
    this.calls += 1;
    return stored === `fake$${password}`;
  }
}

export const SPACE_A = 'space-aaaa';
export const SPACE_B = 'space-bbbb';

export interface Harness {
  service: IdentityService;
  repo: InMemoryIdentityRepository;
  clock: ManualClock;
  hasher: FakeHasher;
  /** Give an identity a member row in a space (production: space create / invite redeem). */
  join(identityId: string, spaceId: string, opts?: Partial<MemberRecord>): MemberRecord;
  /** Give a member an agent persona. */
  persona(ownerMemberId: string, spaceId: string, opts?: Partial<TeamMemberRecord>): TeamMemberRecord;
}

export function makeHarness(): Harness {
  const repo = new InMemoryIdentityRepository();
  const clock = new ManualClock('2026-01-01T00:00:00.000Z');
  const hasher = new FakeHasher();
  const service = new IdentityServiceImpl({
    repository: repo,
    clock,
    ids: new SequentialIds(),
    hasher,
  });

  let seq = 0;

  return {
    service,
    repo,
    clock,
    hasher,
    join(identityId, spaceId, opts = {}) {
      seq += 1;
      const member: MemberRecord = {
        id: `member-${seq}`,
        spaceId,
        identityId,
        role: 'owner',
        displayName: `member ${seq}`,
        avatar: null,
        joinedAt: clock.now(),
        ...opts,
      };
      repo.addMember(member);
      return member;
    },
    persona(ownerMemberId, spaceId, opts = {}) {
      seq += 1;
      const teamMember: TeamMemberRecord = {
        id: `tm-${seq}`,
        spaceId,
        ownerMemberId,
        displayName: `persona ${seq}`,
        avatar: null,
        ...opts,
      };
      repo.addTeamMember(teamMember);
      return teamMember;
    },
  };
}

/** Assert a promise rejects with a specific contract error code. */
export async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    const actual = (error as { code?: string }).code;
    if (actual !== code) {
      throw new Error(`expected error code ${code}, got ${actual} (${String(error)})`);
    }
    return;
  }
  throw new Error(`expected rejection with code ${code}, but it resolved`);
}
