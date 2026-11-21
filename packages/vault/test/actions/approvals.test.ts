import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { sweepExpiredApprovals } from '../../src/actions/handlers.js';
import { intentHash } from '../../src/intent/hash.js';
import { stepUpIntentHash } from '../../src/intent/step-up.js';
import { vaultStepUpBoundParams } from '@tm8/contract';
import { RecordingAlertSink, agentOf, fakeStepUpProof, newApproval, otherCaller, scopeOf, testCaller } from '../support/kit.js';
import { NEW_ORIGIN, ORIGIN, approve, events, fillInput, harness, invoke, login, share } from './fixtures.js';

async function originApproval(broker: ReturnType<typeof harness>['broker'], itemId: string) {
  return invoke(broker, 'vault.origins.requestAdd', { itemId }, { clientMutationId: randomUUID(),
    origin: NEW_ORIGIN, mode: 'one_use', purpose: 'Test alternate login' });
}

describe('agent approval handlers', () => {
  it('reuses pending requests as time advances and raises one approval notification', async () => {
    const { broker } = harness();
    const item = await login(broker);
    const first = await originApproval(broker, item.id);
    broker.clock.advanceSeconds(60);
    const second = await originApproval(broker, item.id);
    expect(second.data).toEqual(first.data);
    expect(first.data.boundParams).toMatchObject({ kind: 'new_origin', expiresAt: first.data.expiresAt,
      itemId: item.id, origin: NEW_ORIGIN, requesterMemberId: testCaller.memberId });
    expect(first.data.intentHash).toBe(intentHash('new_origin', first.data.boundParams));
    expect((await events(broker)).map((event) => event.action)).toEqual(['approval.requested']);
    expect((broker.components.alerts as RecordingAlertSink).kinds()).toEqual(['approval_requested']);
  });

  it('simultaneous origin requests reuse one pending approval in the reference store', async () => {
    const { broker } = harness();
    const item = await login(broker);
    const requests = await Promise.all(Array.from({ length: 8 }, () => originApproval(broker, item.id)));
    expect(new Set(requests.map((result) => result.data.id)).size).toBe(1);
    expect((broker.components.alerts as RecordingAlertSink).kinds()).toEqual(['approval_requested']);
    expect(await broker.store.transaction(scopeOf(testCaller), (tx) => tx.approvals.countPending(item.id))).toBe(1);
  });

  it('approves with a handler-verified step-up bound to the exact decide call', async () => {
    const { broker } = harness();
    const item = await login(broker);
    const { data: pending } = await originApproval(broker, item.id);
    const params = { approvalId: pending.id };
    const input = { clientMutationId: randomUUID(), decision: 'approve' as const, approvalIntentHash: pending.intentHash,
      standing: false, stepUp: fakeStepUpProof() };
    const { data } = await invoke(broker, 'vault.approvals.decide', params, input);
    expect(data.state).toBe('approved');
    expect(broker.auth.bindings).toHaveLength(1);
    expect(broker.auth.bindings[0]).toMatchObject({ action: 'vault.approvals.decide', proof: input.stepUp,
      intentHash: stepUpIntentHash('vault.approvals.decide', vaultStepUpBoundParams(params, input)) });
  });

  it('denial needs only the owner session and never invokes step-up', async () => {
    const { broker } = harness();
    const item = await login(broker);
    const { data: pending } = await originApproval(broker, item.id);
    broker.auth.mode = 'invalid';
    const { data } = await invoke(broker, 'vault.approvals.decide', { approvalId: pending.id }, {
      clientMutationId: randomUUID(), decision: 'deny', approvalIntentHash: pending.intentHash });
    expect(data.state).toBe('denied');
    expect(broker.auth.bindings).toEqual([]);
  });

  it.each(['required', 'invalid'] as const)('failed approval step-up leaves the approval pending: %s', async (mode) => {
    const { broker } = harness();
    const item = await login(broker);
    const { data: pending } = await originApproval(broker, item.id);
    broker.auth.mode = mode;
    await expect(approve(broker, pending.id)).rejects.toMatchObject({ reason: mode === 'required' ? 'step_up_required' : 'step_up_invalid' });
    expect((await invoke(broker, 'vault.approvals.get', { approvalId: pending.id }, {})).data.state).toBe('pending');
  });

  it('refuses a stale or corrupt approval hash before approving', async () => {
    const { broker } = harness();
    const item = await login(broker);
    const { data: pending } = await originApproval(broker, item.id);
    await expect(invoke(broker, 'vault.approvals.decide', { approvalId: pending.id }, { clientMutationId: randomUUID(),
      decision: 'approve', approvalIntentHash: 'a'.repeat(64), stepUp: fakeStepUpProof() }))
      .rejects.toMatchObject({ reason: 'approval_hash_mismatch' });
    expect(broker.auth.bindings).toEqual([]);
  });

  it('refuses an expiry that differs from the exact expiry in the signed approval parameters', async () => {
    const { broker } = harness();
    const item = await login(broker);
    const expiresAt = broker.clock.iso(10 * 60_000);
    const bound = { kind: 'new_origin', itemId: item.id, origin: NEW_ORIGIN,
      requesterMemberId: testCaller.memberId, expiresAt: broker.clock.iso(5 * 60_000) };
    const corrupt = await broker.store.transaction(scopeOf(testCaller), (tx) => tx.approvals.create(newApproval(item.id, testCaller,
      broker.clock, { kind: 'new_origin', boundParams: bound, expiresAt })));
    await expect(approve(broker, corrupt.id)).rejects.toMatchObject({ reason: 'approval_hash_mismatch' });
    expect(broker.auth.bindings).toEqual([]);
  });

  it('refuses decided and expired approvals with approval_not_pending', async () => {
    const { broker } = harness();
    const item = await login(broker);
    const { data: pending } = await originApproval(broker, item.id);
    await approve(broker, pending.id);
    await expect(approve(broker, pending.id)).rejects.toMatchObject({ reason: 'approval_not_pending' });
    const expiry = broker.clock.iso(1000);
    const bound = { kind: 'new_origin', itemId: item.id, origin: NEW_ORIGIN, requesterMemberId: testCaller.memberId, expiresAt: expiry };
    const expired = await broker.store.transaction(scopeOf(testCaller), (tx) => tx.approvals.create(newApproval(item.id, testCaller,
      broker.clock, { kind: 'new_origin', boundParams: bound, expiresAt: expiry })));
    broker.clock.advanceSeconds(2);
    await expect(approve(broker, expired.id)).rejects.toMatchObject({ reason: 'approval_not_pending' });
  });

  it('allows standing only for approved new_origin, adds it atomically and leaves a standing decision record', async () => {
    const { broker, fill } = harness();
    const item = await login(broker);
    const { data: pending } = await originApproval(broker, item.id);
    const { data } = await approve(broker, pending.id, true);
    expect(data).toMatchObject({ state: 'approved', oneUse: false });
    const updated = await broker.store.transaction(scopeOf(testCaller), (tx) => tx.items.get(item.id));
    expect(updated!.origins).toEqual([NEW_ORIGIN, ORIGIN].sort());
    expect((await invoke(broker, 'vault.fill', { itemId: item.id }, fillInput({ origin: NEW_ORIGIN }))).data.state).toBe('done');
    expect(fill).toHaveBeenCalledTimes(1);
    broker.clock.advanceSeconds(16 * 60);
    expect(await sweepExpiredApprovals(broker.store)).toBe(0);
    expect((await invoke(broker, 'vault.approvals.get', { approvalId: pending.id }, {})).data.state).toBe('approved');
  });

  it('rejects standing for use approvals and for denials', async () => {
    const { broker } = harness();
    const item = await login(broker);
    const use = await broker.store.transaction(scopeOf(testCaller), (tx) => tx.approvals.create(newApproval(item.id, testCaller, broker.clock,
      { boundParams: { kind: 'use', itemId: item.id, requesterMemberId: testCaller.memberId, expiresAt: broker.clock.iso(15 * 60_000) } })));
    await expect(approve(broker, use.id, true)).rejects.toMatchObject({ code: 'invalid_input' });
    const { data: pending } = await originApproval(broker, item.id);
    await expect(invoke(broker, 'vault.approvals.decide', { approvalId: pending.id }, { clientMutationId: randomUUID(),
      decision: 'deny', standing: true, approvalIntentHash: pending.intentHash })).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('lists metadata only to the owner or requester and refuses owner decisions by an agent or grantee', async () => {
    const { broker } = harness();
    const item = await login(broker);
    await share(broker, item.id, otherCaller);
    const { data: pending } = await originApproval(broker, item.id);
    expect((await invoke(broker, 'vault.approvals.list', {}, {})).data.approvals.map((row) => row.id)).toContain(pending.id);
    expect((await invoke(broker, 'vault.approvals.list', {}, {}, { caller: otherCaller })).data.approvals).toEqual([]);
    await expect(invoke(broker, 'vault.approvals.get', { approvalId: pending.id }, {}, { caller: otherCaller }))
      .rejects.toMatchObject({ code: 'not_found' });
    await expect(invoke(broker, 'vault.approvals.decide', { approvalId: pending.id }, {
      clientMutationId: randomUUID(), decision: 'deny', approvalIntentHash: pending.intentHash }, { caller: agentOf(testCaller) }))
      .rejects.toMatchObject({ reason: 'vault_session_required' });
    expect(JSON.stringify(pending)).not.toContain('test-only password');
  });

  it('expires pending and unused one-use approvals exactly once, with one system audit event each', async () => {
    const { broker } = harness();
    const item = await login(broker);
    const { data: first } = await originApproval(broker, item.id);
    await approve(broker, first.id);
    const second = await broker.store.transaction(scopeOf(testCaller), (tx) => tx.approvals.create(newApproval(item.id, testCaller, broker.clock)));
    broker.clock.advanceSeconds(16 * 60);
    expect((await invoke(broker, 'vault.approvals.list', {}, { state: 'expired' })).data.approvals).toHaveLength(2);
    expect(await sweepExpiredApprovals(broker.store)).toBe(2);
    expect(await sweepExpiredApprovals(broker.store)).toBe(0);
    const expiredEvents = (await events(broker)).filter((event) => event.action === 'approval.expired');
    expect(expiredEvents.map((event) => event.params.approvalId).sort()).toEqual([first.id, second.id].sort());
    expect(expiredEvents.every((event) => event.actor.kind === 'system')).toBe(true);
  });

  it('rolls expiry and standing-origin changes back when their audit cannot append', async () => {
    const { broker } = harness();
    const item = await login(broker);
    const { data: pending } = await originApproval(broker, item.id);
    broker.store.faults.auditAppend = true;
    await expect(approve(broker, pending.id, true)).rejects.toMatchObject({ reason: 'audit_unavailable' });
    const unchanged = await broker.store.transaction(scopeOf(testCaller), (tx) => tx.items.get(item.id));
    expect(unchanged!.origins).toEqual([ORIGIN]);
    broker.clock.advanceSeconds(16 * 60);
    await expect(sweepExpiredApprovals(broker.store)).rejects.toMatchObject({ name: 'AuditUnavailableError' });
    broker.store.faults.auditAppend = false;
    expect(await sweepExpiredApprovals(broker.store)).toBe(1);
  });

  it('caps discovery at 1000 item approvals and refuses without creating another one', async () => {
    const { broker } = harness();
    const item = await login(broker);
    await broker.store.transaction(scopeOf(testCaller), async (tx) => {
      for (let index = 0; index < 1000; index++) {
        await tx.approvals.create(newApproval(item.id, testCaller, broker.clock, { boundParams: { itemId: item.id, index } }));
      }
    });
    await expect(originApproval(broker, item.id)).rejects.toMatchObject({ code: 'rate_limited' });
    expect(await broker.store.transaction(scopeOf(testCaller), (tx) => tx.approvals.countPending(item.id))).toBe(1000);
    expect(await events(broker)).toEqual([]);
  });
});
