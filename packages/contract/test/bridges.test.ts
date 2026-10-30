/**
 * Bridges B0a contract (design §2.1, §3.4, §3.7): the content arm, the input
 * schemas the doors parse, the catalog rows and the ActorSummary change.
 */
import { describe, expect, it } from 'vitest';
import {
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
  it('carries the twelve rows B1 needs', () => {
    expect(bridges.map(op => op.name)).toEqual([
      'bridges.list', 'bridges.get', 'bridges.create', 'bridges.update', 'bridges.retarget', 'bridges.pause',
      'bridges.resume', 'bridges.remove', 'bridges.handles.list', 'bridges.handles.claim', 'bridges.log.read', 'bridges.listen',
      'bridges.work.start', // B1b-6 (v2 §4.3)
    ]);
  });
  it('create, retarget and remove are human-only; the session doors are not', () => {
    expect(bridges.filter(op => op.humanOnly).map(op => op.name)).toEqual(['bridges.create', 'bridges.retarget', 'bridges.remove']);
  });
});
