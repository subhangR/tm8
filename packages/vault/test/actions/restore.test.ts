/**
 * Test 17 and failure case 13 (MSG 12, MSG 14): a database restore must not
 * bring back a revoked grant or a consumed approval. Only the deletion ledger
 * survives a restore, so both are written to it before their transaction
 * commits, and start-up replays them before the broker serves.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createBrokerCoreHandlers } from '../../src/broker/handlers/index.js';
import { SYSTEM_ACTOR } from '../../src/core-types.js';
import { replayDeletionLedger } from '../../src/store/deletion-ledger.js';
import { MemoryDeletionLedger, otherCaller, scopeOf, testCaller, type TestBroker } from '../support/kit.js';
import { NEW_ORIGIN, approve, events, fillInput, harness, invoke, login, share } from './fixtures.js';

const core = createBrokerCoreHandlers();

async function revoke(broker: TestBroker, grantId: string) {
  return core['vault.grants.revoke'](await broker.context('vault.grants.revoke'), { params: { grantId }, input: { clientMutationId: randomUUID() } });
}

const replay = (broker: TestBroker): Promise<number> => replayDeletionLedger(broker.store, broker.components.deletionLedger);
const actions = async (broker: TestBroker, action: string) => (await events(broker)).filter((event) => event.action === action);
const approvalState = async (broker: TestBroker, approvalId: string) =>
  (await invoke(broker, 'vault.approvals.get', { approvalId }, {})).data.state;

describe('a restore revives no revoked grant and no consumed approval (test 17)', () => {
  it('revokes again a grant the restore brought back, before the grantee can fill', async () => {
    const { broker, fill } = harness();
    const item = await login(broker);
    const grant = await share(broker, item.id, otherCaller);
    const backup = broker.store.testing.snapshot();
    expect((await revoke(broker, grant.id)).data.revokedAt).not.toBeNull();

    await broker.store.testing.restore(backup);
    const revived = await broker.store.transaction(scopeOf(testCaller), (tx) => tx.grants.get(grant.id));
    expect(revived!.revokedAt).toBeNull();

    expect(await replay(broker)).toBe(1);
    const replayed = await broker.store.transaction(scopeOf(testCaller), (tx) => tx.grants.get(grant.id));
    expect(replayed).toMatchObject({ revokedBy: SYSTEM_ACTOR });
    expect(replayed!.revokedAt).not.toBeNull();
    await expect(invoke(broker, 'vault.fill', { itemId: item.id }, fillInput(), { caller: otherCaller })).rejects.toMatchObject({ code: 'not_found' });
    expect(fill).not.toHaveBeenCalled();
    expect((await actions(broker, 'grant.revoke_replayed')).map((event) => event.params)).toEqual([{ grantId: grant.id }]);
    expect(await replay(broker)).toBe(0);
  });

  it('consumes again a one-use approval the restore brought back, so the next use asks again', async () => {
    const { broker, fill } = harness();
    const item = await login(broker);
    const { data: requested } = await invoke(broker, 'vault.fill', { itemId: item.id }, fillInput({ origin: NEW_ORIGIN }));
    if (requested.state !== 'approval_required') throw new Error('expected approval');
    await approve(broker, requested.approvalId);
    const backup = broker.store.testing.snapshot();
    const use = fillInput({ origin: NEW_ORIGIN });
    expect((await invoke(broker, 'vault.fill', { itemId: item.id }, use)).data.state).toBe('done');
    expect(fill).toHaveBeenCalledTimes(1);

    await broker.store.testing.restore(backup);
    expect(await approvalState(broker, requested.approvalId)).toBe('approved');

    expect(await replay(broker)).toBe(1);
    expect(await approvalState(broker, requested.approvalId)).toBe('consumed');
    const { data: again } = await invoke(broker, 'vault.fill', { itemId: item.id }, fillInput({ origin: NEW_ORIGIN }));
    expect(again.state).toBe('approval_required');
    if (again.state === 'approval_required') expect(again.approvalId).not.toBe(requested.approvalId);
    expect(fill).toHaveBeenCalledTimes(1);
    expect((await actions(broker, 'approval.consume_replayed')).map((event) => event.params))
      .toEqual([{ approvalId: requested.approvalId, operationId: use.operationId }]);
    expect(await replay(broker)).toBe(0);
  });

  it('expires an approval the restore brought back pending, so nobody can approve and use it again', async () => {
    const { broker, fill } = harness();
    const item = await login(broker);
    const { data: requested } = await invoke(broker, 'vault.fill', { itemId: item.id }, fillInput({ origin: NEW_ORIGIN }));
    if (requested.state !== 'approval_required') throw new Error('expected approval');
    const backup = broker.store.testing.snapshot();
    await approve(broker, requested.approvalId);
    expect((await invoke(broker, 'vault.fill', { itemId: item.id }, fillInput({ origin: NEW_ORIGIN }))).data.state).toBe('done');

    await broker.store.testing.restore(backup);
    expect(await approvalState(broker, requested.approvalId)).toBe('pending');
    expect(await replay(broker)).toBe(1);
    expect(await approvalState(broker, requested.approvalId)).toBe('expired');
    expect(fill).toHaveBeenCalledTimes(1);
  });

  it('writes the consumption to the ledger before the reserving transaction commits, and runs nothing without it', async () => {
    const { broker, fill } = harness();
    const item = await login(broker);
    const { data: requested } = await invoke(broker, 'vault.fill', { itemId: item.id }, fillInput({ origin: NEW_ORIGIN }));
    if (requested.state !== 'approval_required') throw new Error('expected approval');
    await approve(broker, requested.approvalId);
    const ledger = broker.components.deletionLedger as MemoryDeletionLedger;
    ledger.failAppend = true;
    const auditedBefore = (await events(broker)).length;
    // The dispatcher answers an internal fault fail-closed; the same fill succeeds below once the ledger works.
    await expect(invoke(broker, 'vault.fill', { itemId: item.id }, fillInput({ origin: NEW_ORIGIN }))).rejects.toThrow('vault_unavailable');
    expect(fill).not.toHaveBeenCalled();
    expect(await approvalState(broker, requested.approvalId)).toBe('approved');
    expect((await events(broker)).length).toBe(auditedBefore);

    // The failed append rolled the consumption back with the reservation, so it was written before the commit.
    // Once the ledger works, the same approval is used once and the line names exactly that use.
    ledger.failAppend = false;
    const use = fillInput({ origin: NEW_ORIGIN });
    expect((await invoke(broker, 'vault.fill', { itemId: item.id }, use)).data.state).toBe('done');
    expect(fill).toHaveBeenCalledTimes(1);
    const stored = await broker.store.transaction(scopeOf(testCaller), (tx) => tx.approvals.get(requested.approvalId));
    expect(stored).toMatchObject({ state: 'consumed', consumedByOperationId: use.operationId });
    expect(await ledger.revocations()).toEqual([{ kind: 'approval_consumed', approvalId: requested.approvalId, itemId: item.id,
      spaceId: item.spaceId, ownerMemberId: item.ownerMemberId, operationId: use.operationId, consumedAt: stored!.consumedAt }]);
  });

  it('revokes even when the ledger cannot append, and reports the failure after the revocation committed', async () => {
    const { broker } = harness();
    const item = await login(broker);
    const grant = await share(broker, item.id, otherCaller);
    const ledger = broker.components.deletionLedger as MemoryDeletionLedger;
    ledger.failAppend = true;
    await expect(revoke(broker, grant.id)).rejects.toThrow('deletion ledger: append failed (test)');
    const stored = await broker.store.transaction(scopeOf(testCaller), (tx) => tx.grants.get(grant.id));
    expect(stored!.revokedAt).not.toBeNull();
    expect(await actions(broker, 'grant.revoked')).toHaveLength(1);
    // Retrying once the ledger works records the revocation without revoking twice.
    ledger.failAppend = false;
    expect((await revoke(broker, grant.id)).data.revokedAt).toBe(stored!.revokedAt);
    expect(await ledger.revocations()).toEqual([expect.objectContaining({ kind: 'grant_revoked', grantId: grant.id, revokedAt: stored!.revokedAt })]);
    expect(await actions(broker, 'grant.revoked')).toHaveLength(1);
  });
});
