import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AUDIT_GENESIS_HASH, verifyAuditRun } from '../../src/audit/chain.js';
import { buildCanarySet } from '../../src/canary/index.js';
import { EgressRefusal } from '../../src/types.js';
import { RecordingAlertSink, scopeOf, testCaller } from '../support/kit.js';
import { ORIGIN, apiInput, apiKey, approve, card, enableTestSpend, events, fillInput, harness, invoke, login, spendInput } from './fixtures.js';

describe('audit failure gate (acceptance 18)', () => {
  for (const failure of ['gate', 'append', 'broken_chain'] as const) {
    it.each(['fill', 'callApi', 'spend.execute'] as const)(`${failure}: %s refuses before reserve with zero external calls`, async (action) => {
      const { broker, fill, execute, processor } = harness();
      enableTestSpend(broker);
      const loginItem = await login(broker);
      const key = await apiKey(broker);
      const instrument = await card(broker);
      const { data: approval } = await invoke(broker, 'vault.spend.request', { itemId: instrument.id }, spendInput());
      await approve(broker, approval.id);
      if (failure === 'gate') broker.audit.state = 'unavailable';
      if (failure === 'append') broker.store.faults.auditAppend = true;
      if (failure === 'broken_chain') {
        // The shared fake has a settable state. Feed it the real memory-chain verifier result.
        await broker.store.testing.tamperAuditEvent(1, { action: 'item.deleted' });
        const run = verifyAuditRun({ seq: 0, hash: AUDIT_GENESIS_HASH }, await events(broker));
        expect(run.ok).toBe(false);
        broker.audit.state = run.ok ? 'ok' : 'unavailable';
      }
      const operationId = randomUUID();
      const work = action === 'fill' ? invoke(broker, 'vault.fill', { itemId: loginItem.id }, fillInput({ operationId }))
        : action === 'callApi' ? invoke(broker, 'vault.callApi', { itemId: key.id }, apiInput({ operationId }))
          : invoke(broker, 'vault.spend.execute', { approvalId: approval.id }, { operationId });
      await expect(work).rejects.toMatchObject({ reason: 'audit_unavailable' });
      expect(fill).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      expect(processor.calls).toEqual([]);
      expect(processor.lookups).toEqual([]);
      expect(await broker.store.transaction(scopeOf(testCaller), (tx) => tx.operations.get(operationId))).toBeNull();
      const currentApproval = await broker.store.transaction(scopeOf(testCaller), (tx) => tx.approvals.get(approval.id));
      expect(currentApproval!.state).toBe('approved');
      if (failure === 'append') expect(broker.audit.appendFailures).toBe(1);
    });
  }

  it('audit failure takes precedence over the real disabled-spend gate', async () => {
    const { broker, processor } = harness();
    broker.audit.state = 'unavailable';
    await expect(invoke(broker, 'vault.spend.execute', { approvalId: randomUUID() }, { operationId: randomUUID() }))
      .rejects.toMatchObject({ reason: 'audit_unavailable' });
    expect(processor.calls).toEqual([]);
    expect(await events(broker)).toEqual([]);
  });
});

describe('canaries in action input', () => {
  const planted = ['test', 'only', 'action', 'canary'].join('-');
  it.each(['origin', 'startUrl', 'purpose'] as const)('refuses a canary in the fill %s and records only fixed metadata', async (field) => {
    const { broker, fill } = harness({ components: { canaries: buildCanarySet([planted]) } });
    const item = await login(broker);
    const value = field === 'purpose' ? planted : `${ORIGIN}/${planted}`;
    await expect(invoke(broker, 'vault.fill', { itemId: item.id }, fillInput({ [field]: value })))
      .rejects.toMatchObject({ reason: 'value_request_refused' });
    expect(fill).not.toHaveBeenCalled();
    expect((await events(broker)).at(-1)).toMatchObject({ action: 'canary.detected', params: { source: 'action_input' } });
    expect((broker.components.alerts as RecordingAlertSink).kinds()).toEqual(['canary_detected']);
    expect(JSON.stringify(await events(broker))).not.toContain(planted);
  });

  it.each(['body', 'headers', 'encoded'] as const)('refuses a canary in API %s before the executor sees any material', async (field) => {
    const { broker, execute } = harness({ components: { canaries: buildCanarySet([planted]) } });
    const item = await apiKey(broker);
    const input = apiInput();
    input.request = { ...input.request, ...(field === 'headers' ? { headers: { 'x-test-note': planted } }
      : { body: { kind: 'json', value: { nested: [field === 'encoded' ? Buffer.from(planted).toString('base64') : planted] } } }) };
    await expect(invoke(broker, 'vault.callApi', { itemId: item.id }, input)).rejects.toMatchObject({ reason: 'value_request_refused' });
    expect(execute).not.toHaveBeenCalled();
    expect((broker.components.alerts as RecordingAlertSink).kinds()).toEqual(['canary_detected']);
    expect(JSON.stringify(await events(broker))).not.toContain(planted);
  });

  it('refuses canaries in origin requests and in test-enabled spend metadata', async () => {
    const { broker, processor } = harness({ components: { canaries: buildCanarySet([planted]) } });
    enableTestSpend(broker);
    const item = await login(broker);
    const instrument = await card(broker);
    await expect(invoke(broker, 'vault.origins.requestAdd', { itemId: item.id }, { clientMutationId: randomUUID(),
      origin: ORIGIN, mode: 'one_use', purpose: planted })).rejects.toMatchObject({ reason: 'value_request_refused' });
    await expect(invoke(broker, 'vault.spend.request', { itemId: instrument.id }, spendInput({ merchant: planted })))
      .rejects.toMatchObject({ reason: 'value_request_refused' });
    expect(processor.calls).toEqual([]);
    expect((await events(broker)).every((event) => event.action === 'canary.detected')).toBe(true);
  });

  it('maps the executor canary refusal to both api.refused and canary.detected with both alerts', async () => {
    const { broker, execute } = harness();
    const item = await apiKey(broker);
    execute.mockRejectedValueOnce(new EgressRefusal('canary_in_request'));
    const { data } = await invoke(broker, 'vault.callApi', { itemId: item.id }, apiInput());
    expect(data).toMatchObject({ state: 'refused', code: 'canary_in_request' });
    expect((await events(broker)).map((event) => event.action)).toEqual(['api.started', 'api.refused', 'canary.detected']);
    expect((broker.components.alerts as RecordingAlertSink).kinds()).toEqual(['egress_refused', 'canary_detected']);
  });
});
