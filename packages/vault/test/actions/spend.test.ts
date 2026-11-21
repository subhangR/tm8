import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { disabledSpendProcessor, markUnknownOperations } from '../../src/actions/handlers.js';
import { newApproval, otherCaller, scopeOf, testCaller } from '../support/kit.js';
import { approve, card, enableTestSpend, events, harness, invoke, share, spendInput } from './fixtures.js';

async function enabledHarness() {
  const h = harness();
  enableTestSpend(h.broker);
  const item = await card(h.broker);
  return { ...h, item };
}

async function approvedSpend(broker: ReturnType<typeof harness>['broker'], itemId: string) {
  const { data } = await invoke(broker, 'vault.spend.request', { itemId }, spendInput());
  await approve(broker, data.id);
  return data;
}

describe('spend disabled in v1; flow tested only with TestSpendProcessor', () => {
  it.each(['off', 'dev', 'pre_review', 'production'] as const)('every real config refuses both spend operations with no reservation or charge: %s', async (mode) => {
    const { broker, processor } = harness({ config: { mode } });
    const item = await card(broker);
    const approvalId = randomUUID();
    const operationId = randomUUID();
    await expect(invoke(broker, 'vault.spend.request', { itemId: item.id }, spendInput())).rejects.toMatchObject({ reason: 'spend_disabled' });
    await expect(invoke(broker, 'vault.spend.execute', { approvalId }, { operationId })).rejects.toMatchObject({ reason: 'spend_disabled' });
    expect(processor.calls).toEqual([]);
    expect(processor.lookups).toEqual([]);
    expect(await broker.store.transaction(scopeOf(testCaller), (tx) => tx.operations.get(operationId))).toBeNull();
    expect((await events(broker)).map((event) => event.action)).toEqual(['spend.refused', 'spend.refused']);
  });

  it('the disabled processor independently closes the gate even with a test-only enabled flag', async () => {
    const { broker } = harness({ components: { spend: disabledSpendProcessor } });
    enableTestSpend(broker);
    const item = await card(broker);
    await expect(invoke(broker, 'vault.spend.request', { itemId: item.id }, spendInput())).rejects.toMatchObject({ reason: 'spend_disabled' });
    await expect(invoke(broker, 'vault.spend.execute', { approvalId: randomUUID() }, { operationId: randomUUID() })).rejects.toMatchObject({ reason: 'spend_disabled' });
    expect(await disabledSpendProcessor.charge({ idempotencyKey: randomUUID(), merchant: 'Test merchant', amountMinor: 1, currency: 'USD' }))
      .toEqual({ state: 'declined' });
    expect(await disabledSpendProcessor.lookup(randomUUID())).toEqual({ state: 'not_found' });
  });

  it('test 11: never charges without approval, binds exact amount/currency/merchant, and replays without a second charge', async () => {
    const { broker, processor, item } = await enabledHarness();
    const { data: pending } = await invoke(broker, 'vault.spend.request', { itemId: item.id }, spendInput());
    expect(pending.boundParams).toMatchObject({ kind: 'spend', itemId: item.id, amountMinor: 1234,
      currency: 'USD', merchant: 'Example merchant', requesterMemberId: testCaller.memberId, expiresAt: pending.expiresAt });
    const before = { operationId: randomUUID() };
    expect((await invoke(broker, 'vault.spend.execute', { approvalId: pending.id }, before)).data)
      .toMatchObject({ state: 'refused', code: 'approval_not_approved' });
    expect(processor.calls).toEqual([]);
    await approve(broker, pending.id);
    // The approval-required refusal remains final for its operation id.
    expect((await invoke(broker, 'vault.spend.execute', { approvalId: pending.id }, before)).data.state).toBe('refused');
    const input = { operationId: randomUUID() };
    const signal = new AbortController().signal;
    const first = await invoke(broker, 'vault.spend.execute', { approvalId: pending.id }, input, { signal });
    expect(first.data).toMatchObject({ state: 'done', amountMinor: 1234, currency: 'USD', merchant: 'Example merchant' });
    expect((await invoke(broker, 'vault.spend.execute', { approvalId: pending.id }, input)).data).toEqual(first.data);
    expect(processor.calls).toHaveLength(1);
    expect(processor.calls[0]).toMatchObject({ idempotencyKey: input.operationId, amountMinor: 1234, currency: 'USD', signal });
    expect((await invoke(broker, 'vault.spend.execute', { approvalId: pending.id }, { operationId: randomUUID() })).data)
      .toMatchObject({ state: 'refused', code: 'approval_consumed' });
    expect(processor.calls).toHaveLength(1);
    const spent = await broker.store.transaction(scopeOf(testCaller), (tx) => tx.spend.getByApproval(pending.id));
    expect(spent!.executedAt).not.toBeNull();
    expect((await invoke(broker, 'vault.approvals.get', { approvalId: pending.id }, {})).data.state).toBe('consumed');
  });

  it('declines an over-amount spend record before consuming or charging', async () => {
    const { broker, processor, item } = await enabledHarness();
    const detail = { merchant: 'Example merchant', amountMinor: 1234, currency: 'USD', itemSummary: 'Test item', instrumentTier: 'tier1' as const };
    const expiresAt = broker.clock.iso(15 * 60_000);
    const bound = { ...detail, evidenceHash: null, kind: 'spend', itemId: item.id,
      requesterMemberId: testCaller.memberId, expiresAt };
    const approval = await broker.store.transaction(scopeOf(testCaller), async (tx) => {
      const created = await tx.approvals.create(newApproval(item.id, testCaller, broker.clock,
        { kind: 'spend', boundParams: bound, spend: detail, expiresAt }));
      await tx.spend.create({ approvalId: created.id, itemId: item.id, ...detail, amountMinor: 1235, evidence: null });
      return created;
    });
    await approve(broker, approval.id);
    const refused = await invoke(broker, 'vault.spend.execute', { approvalId: approval.id }, { operationId: randomUUID() });
    expect(refused.data).toMatchObject({ state: 'refused', code: 'amount_mismatch' });
    expect(processor.calls).toEqual([]);
    expect((await invoke(broker, 'vault.approvals.get', { approvalId: approval.id }, {})).data.state).toBe('approved');
  });

  it('rejects a missing approval and operation-id reuse for another approval', async () => {
    const { broker, processor, item } = await enabledHarness();
    await expect(invoke(broker, 'vault.spend.execute', { approvalId: randomUUID() }, { operationId: randomUUID() }))
      .rejects.toMatchObject({ code: 'not_found' });
    const first = await approvedSpend(broker, item.id);
    const input = { operationId: randomUUID() };
    await invoke(broker, 'vault.spend.execute', { approvalId: first.id }, input);
    const second = await approvedSpend(broker, item.id);
    await expect(invoke(broker, 'vault.spend.execute', { approvalId: second.id }, input)).rejects.toMatchObject({ reason: 'operation_id_reused' });
    expect(processor.calls).toHaveLength(1);
  });

  it('refuses an unconfigured processor without consuming the approval', async () => {
    const { broker, processor, item } = await enabledHarness();
    const approval = await approvedSpend(broker, item.id);
    processor.configured = false;
    expect((await invoke(broker, 'vault.spend.execute', { approvalId: approval.id }, { operationId: randomUUID() })).data)
      .toMatchObject({ state: 'refused', code: 'processor_not_configured' });
    expect(processor.calls).toEqual([]);
    expect((await invoke(broker, 'vault.approvals.get', { approvalId: approval.id }, {})).data.state).toBe('approved');
  });

  it('a requester-only execution cannot be taken over by the owner', async () => {
    const { broker, processor, item } = await enabledHarness();
    await share(broker, item.id, otherCaller);
    const { data: pending } = await invoke(broker, 'vault.spend.request', { itemId: item.id }, spendInput(), { caller: otherCaller });
    await approve(broker, pending.id);
    await expect(invoke(broker, 'vault.spend.execute', { approvalId: pending.id }, { operationId: randomUUID() }))
      .rejects.toMatchObject({ code: 'not_found' });
    expect((await invoke(broker, 'vault.spend.execute', { approvalId: pending.id }, { operationId: randomUUID() }, { caller: otherCaller })).data.state).toBe('done');
    expect(processor.calls).toHaveLength(1);
  });

  it('reconciles an unknown charge by lookup before allowing any new execution for its approval', async () => {
    const { broker, processor, item } = await enabledHarness();
    const approval = await approvedSpend(broker, item.id);
    processor.next = { state: 'unknown' };
    const input = { operationId: randomUUID() };
    expect((await invoke(broker, 'vault.spend.execute', { approvalId: approval.id }, input)).data.state).toBe('unknown');
    await expect(invoke(broker, 'vault.spend.execute', { approvalId: approval.id }, { operationId: randomUUID() }))
      .rejects.toMatchObject({ reason: 'operation_in_progress' });
    expect(processor.calls).toHaveLength(1);
    expect(processor.lookups).toEqual([input.operationId]);
    processor.outcomes.set(input.operationId, { state: 'done', amountMinor: 1234, currency: 'USD', processorRef: 'test-reconciled' });
    expect((await invoke(broker, 'vault.spend.execute', { approvalId: approval.id }, input)).data)
      .toMatchObject({ state: 'done', processorRef: 'test-reconciled' });
    expect(processor.calls).toHaveLength(1);
    expect((await events(broker)).at(-1)).toMatchObject({ action: 'spend.reconciled', params: { state: 'done' } });
    const spent = await broker.store.transaction(scopeOf(testCaller), (tx) => tx.spend.getByApproval(approval.id));
    expect(spent!.executedAt).not.toBeNull();
  });

  it('lookup not_found resolves unknown as refused without charging again or reopening the approval', async () => {
    const { broker, processor, item } = await enabledHarness();
    const approval = await approvedSpend(broker, item.id);
    processor.throwCharge = true;
    const input = { operationId: randomUUID() };
    expect((await invoke(broker, 'vault.spend.execute', { approvalId: approval.id }, input)).data.state).toBe('unknown');
    expect((await invoke(broker, 'vault.spend.execute', { approvalId: approval.id }, input)).data)
      .toMatchObject({ state: 'refused', code: 'processor_declined' });
    expect(processor.calls).toHaveLength(1);
    expect((await invoke(broker, 'vault.approvals.get', { approvalId: approval.id }, {})).data.state).toBe('consumed');
  });

  it('recovers a completed charge whose completion transaction failed, with no second charge', async () => {
    const { broker, processor, item } = await enabledHarness();
    const approval = await approvedSpend(broker, item.id);
    const charge = processor.charge.bind(processor);
    processor.charge = async (input) => {
      const outcome = await charge(input);
      broker.store.faults.auditAppend = true;
      return outcome;
    };
    const input = { operationId: randomUUID() };
    await expect(invoke(broker, 'vault.spend.execute', { approvalId: approval.id }, input)).rejects.toMatchObject({ reason: 'audit_unavailable' });
    const reserved = await broker.store.transaction(scopeOf(testCaller), (tx) => tx.operations.get(input.operationId));
    expect(reserved!.state).toBe('in_progress');
    broker.store.faults.auditAppend = false;
    broker.audit.state = 'ok';
    expect(await markUnknownOperations(broker.store)).toHaveLength(1);
    expect((await invoke(broker, 'vault.spend.execute', { approvalId: approval.id }, input)).data.state).toBe('done');
    expect(processor.calls).toHaveLength(1);
    expect(processor.lookups).toEqual([input.operationId]);
  });

  it('records processor declines, and lazy expiry cannot authorize a charge', async () => {
    const { broker, processor, item } = await enabledHarness();
    const approval = await approvedSpend(broker, item.id);
    processor.next = { state: 'declined' };
    const input = { operationId: randomUUID() };
    const first = await invoke(broker, 'vault.spend.execute', { approvalId: approval.id }, input);
    expect(first.data).toMatchObject({ state: 'refused', code: 'processor_declined' });
    expect((await invoke(broker, 'vault.spend.execute', { approvalId: approval.id }, input)).data).toEqual(first.data);
    const expires = await approvedSpend(broker, item.id);
    broker.clock.advanceSeconds(16 * 60);
    expect((await invoke(broker, 'vault.spend.execute', { approvalId: expires.id }, { operationId: randomUUID() })).data)
      .toMatchObject({ state: 'refused', code: 'approval_not_approved' });
    expect(processor.calls).toHaveLength(1);
  });

  it('source guard: all shipped processor objects are disabled and no class implements a payment processor', () => {
    const root = fileURLToPath(new URL('../../src/', import.meta.url));
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
      ? files(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : []);
    const forbidden: string[] = [];
    let disabled = 0;
    for (const file of files(root)) {
      const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (ts.isObjectLiteralExpression(node)) {
          const names = new Set(node.properties.flatMap((property) => property.name ? [property.name.getText(source).replace(/['"]/g, '')] : []));
          const properties = new Map(node.properties.filter(ts.isPropertyAssignment).map((property) => [property.name.getText(source).replace(/['"]/g, ''), property.initializer]));
          if (names.has('charge') && names.has('lookup')) {
            const kind = properties.get('kind');
            if (kind && ts.isStringLiteral(kind) && kind.text === 'disabled') disabled++;
            else forbidden.push(file.replace(root, ''));
          }
        }
        if (ts.isClassDeclaration(node)) {
          const names = new Set(node.members.flatMap((member) => member.name ? [member.name.getText(source).replace(/['"]/g, '')] : []));
          if (names.has('charge') && names.has('lookup')) forbidden.push(file.replace(root, ''));
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(forbidden).toEqual([]);
    expect(disabled).toBeGreaterThan(0);
  });
});
