/**
 * Bridges B0a contract (design §2.1, §3.4, §3.7): the content arm, the input
 * schemas the doors parse, the catalog rows and the ActorSummary change.
 */
import { describe, expect, it } from 'vitest';
import {
  AuthSessionListingSchema,
  BridgeParticipantUpdateInputSchema,
  ActorSummarySchema, BridgeCreateInputSchema, BridgeEntitySchema, BridgeFactsSchema, BridgeHandleClaimInputSchema,
  BridgeListenInputSchema, BridgeUpdateInputSchema, CORE_KIND_INFO, CoreEntityKindSchema, CreatableEntityKindSchema,
  EntityStateSchema, OPERATIONS,
} from '../src/index.js';
import { FIXTURE_BRIDGE_FACTS } from './fixtures/bridge.js';

const id = '01a189da-0000-7000-8000-00000000000a';

describe('the bridge kind', () => {
  it('is a core kind in Talk, created only with `bridge create`', () => {
    expect(CoreEntityKindSchema.safeParse('bridge').success).toBe(true);
    expect(CORE_KIND_INFO.bridge).toMatchObject({ group: 'talk', createWith: ['bridge create'] });
    expect(CreatableEntityKindSchema.safeParse('bridge').success).toBe(false);
  });

  it('the state arm is the derived facts, strict', () => {
    expect(BridgeFactsSchema.safeParse(FIXTURE_BRIDGE_FACTS).success).toBe(true);
    expect(BridgeEntitySchema.safeParse({ kind: 'bridge', ...FIXTURE_BRIDGE_FACTS }).success).toBe(true);
    expect(EntityStateSchema.safeParse({ kind: 'bridge', ...FIXTURE_BRIDGE_FACTS }).success).toBe(true);
    expect(BridgeEntitySchema.safeParse({ kind: 'bridge', ...FIXTURE_BRIDGE_FACTS, stateRef: 'x' }).success).toBe(false);
  });
});

describe('ActorSummary (§3.7)', () => {
  it('a guest is authored by the bridge, with the participant on via', () => {
    expect(ActorSummarySchema.safeParse({
      id, kind: 'bridge', displayName: 'Infra (WhatsApp)', isAgent: false,
      via: { bridgeId: id, participant: { displayName: 'Rahul' } },
    }).success).toBe(true);
  });
  it('a linked participant is the member, via the bridge; a session via stays valid', () => {
    expect(ActorSummarySchema.safeParse({ id, kind: 'member', displayName: 'Rahul', isAgent: false, via: { bridgeId: id } }).success).toBe(true);
    expect(ActorSummarySchema.safeParse({ id, kind: 'team_member', displayName: 'Infra', isAgent: true, via: { sessionId: id } }).success).toBe(true);
  });
});

describe('input schemas', () => {
  const create = {
    clientMutationId: 'm', connectionId: id, targetId: id,
    conversation: { externalId: '1203@g.us', kind: 'group', title: 'Infra' },
  };
  it('create takes a partial policy and refuses unknown fields', () => {
    expect(BridgeCreateInputSchema.safeParse({ ...create, policy: { trigger: 'every' } }).success).toBe(true);
    expect(BridgeCreateInputSchema.safeParse({ ...create, policy: { trigger: 'always' } }).success).toBe(false);
    expect(BridgeCreateInputSchema.safeParse({ ...create, secret: 'x' }).success).toBe(false);
  });
  it('purpose and style are one line; quiet hours are distinct HH:MM', () => {
    expect(BridgeCreateInputSchema.safeParse({ ...create, purpose: 'two\nlines' }).success).toBe(false);
    expect(BridgeCreateInputSchema.safeParse({ ...create, quietHours: { start: '22:00', end: '08:00' } }).success).toBe(true);
    expect(BridgeCreateInputSchema.safeParse({ ...create, quietHours: { start: '22:00', end: '22:00' } }).success).toBe(false);
    expect(BridgeCreateInputSchema.safeParse({ ...create, quietHours: { start: '25:00', end: '08:00' } }).success).toBe(false);
  });
  it('update names at least one field and carries the version guard', () => {
    expect(BridgeUpdateInputSchema.safeParse({ clientMutationId: 'm', expectedVersion: 2, patch: {} }).success).toBe(false);
    expect(BridgeUpdateInputSchema.safeParse({ clientMutationId: 'm', expectedVersion: 2, patch: { workerWake: 'thread' } }).success).toBe(true);
  });
  it('a handle title is at most four words; listen takes the three levels', () => {
    expect(BridgeHandleClaimInputSchema.safeParse({ title: 'deploy watcher' }).success).toBe(true);
    expect(BridgeHandleClaimInputSchema.safeParse({ title: 'one two three four five' }).success).toBe(false);
    expect(BridgeListenInputSchema.safeParse({ wake: 'all' }).success).toBe(true);
    expect(BridgeListenInputSchema.safeParse({ wake: 'loud' }).success).toBe(false);
  });
});

describe('catalog (§3.4)', () => {
  const bridges = OPERATIONS.filter(op => op.name.startsWith('bridges.'));
  it('carries the twelve rows B1 needs, B3\'s three link rows, and the People tab\'s two (Bridges P, 420)', () => {
    expect(bridges.map(op => op.name)).toEqual([
      'bridges.list', 'bridges.get', 'bridges.create', 'bridges.update', 'bridges.retarget', 'bridges.pause',
      'bridges.resume', 'bridges.remove', 'bridges.participants.list', 'bridges.participants.update',
      'bridges.handles.list', 'bridges.handles.claim', 'bridges.log.read', 'bridges.listen',
      'bridges.work.start', // B1b-6 (v2 §4.3)
      // Bridges R (416): /remember proposals, listed and decided in tm8 (D29, D61-D63).
      'bridges.memories.proposals.list', 'bridges.memories.proposals.resolve',
      'bridges.links.begin', 'bridges.links.list', 'bridges.links.revoke',
    ]);
  });
  it('create, retarget, remove, the participant write, the link begin and revoke, and the memory proposal decision are human-only; the session doors are not', () => {
    expect(bridges.filter(op => op.humanOnly).map(op => op.name)).toEqual([
      'bridges.create', 'bridges.retarget', 'bridges.remove', 'bridges.participants.update',
      'bridges.memories.proposals.resolve', 'bridges.links.begin', 'bridges.links.revoke',
    ]);
  });
});

describe('auth session listing kinds (395/398 fix-forward)', () => {
  const row = (kind: string) => ({
    sessionId: '01a18b41-0000-7000-8000-000000000001', kind,
    createdAt: '2026-10-30T07:00:00.000Z', lastUsedAt: null, expiresAt: '2026-11-06T07:00:00.000Z',
    label: 'whatsapp-runtime', spaceId: null, spaceName: null, parentSessionId: null,
    origin: 'login', originEntityId: null, owner: { identityId: 'owner', displayName: null }, current: false,
  });
  it('a bridge_runtime listing row validates, beside the existing kinds', () => {
    for (const kind of ['browser', 'cli', 'agent', 'agent_runtime', 'bridge_runtime']) {
      const parsed = AuthSessionListingSchema.safeParse(row(kind));
      expect(parsed.success, kind).toBe(true);
    }
    expect(AuthSessionListingSchema.safeParse(row('rogue')).success).toBe(false);
  });
});


describe('link inputs (B3, 417)', () => {
  it('begin takes a known provider; an invite pins a bridge id and an external id; the code shape is TM8-', async () => {
    const { BridgeLinkBeginInputSchema, BridgeInviteParticipantSchema, BRIDGE_LINK_CODE_PATTERN } = await import('../src/bridges.js');
    expect(BridgeLinkBeginInputSchema.safeParse({ provider: 'whatsapp' }).success).toBe(true);
    expect(BridgeLinkBeginInputSchema.safeParse({ provider: 'fax' }).success).toBe(false);
    expect(BridgeInviteParticipantSchema.safeParse({ bridgeId: '11111111-1111-7111-8111-111111111111', externalId: '9190@s.whatsapp.net' }).success).toBe(true);
    expect(BridgeInviteParticipantSchema.safeParse({ bridgeId: 'x', externalId: '' }).success).toBe(false);
    expect(BRIDGE_LINK_CODE_PATTERN.test('TM8-4F7KQ2')).toBe(true);
    expect(BRIDGE_LINK_CODE_PATTERN.test('4F7K')).toBe(false);
  });
});


describe('BridgeParticipantUpdateInputSchema (D52)', () => {
  const base = { clientMutationId: 'm-1' };
  it('takes a mute, an assertion and a revocation (memberId null)', () => {
    for (const patch of [{ muted: true }, { memberId: '01a18b41-e900-79ed-8eb2-52a11dbf4292' }, { memberId: null }]) {
      expect(BridgeParticipantUpdateInputSchema.safeParse({ ...base, patch }).success, JSON.stringify(patch)).toBe(true);
    }
  });
  it('refuses an empty patch and an unknown field', () => {
    expect(BridgeParticipantUpdateInputSchema.safeParse({ ...base, patch: {} }).success).toBe(false);
    expect(BridgeParticipantUpdateInputSchema.safeParse({ ...base, patch: { trust: 'linked' } }).success).toBe(false);
  });
});
