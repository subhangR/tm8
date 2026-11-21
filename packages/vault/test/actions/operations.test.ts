import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { markUnknownOperations } from '../../src/actions/handlers.js';
import { hashIntent } from '../../src/actions/common.js';
import { actorOf, type OperationKind } from '../../src/core-types.js';
import { KmsUnavailableError } from '../../src/crypto/kms.js';
import { SPACE_B, makeCaller, otherCaller, scopeOf, testCaller } from '../support/kit.js';
import { NEW_ORIGIN, ORIGIN, apiInput, apiKey, approve, events, fillInput, harness, invoke, login } from './fixtures.js';

describe('idempotent action lifecycle', () => {
  it('writes started before running the driver and never holds a transaction over it', async () => {
    const { broker, fill } = harness();
    const item = await login(broker);
    const input = fillInput();
    fill.mockImplementationOnce(async ({ intent }) => {
      const operation = await broker.store.transaction(scopeOf(testCaller), (tx) => tx.operations.get(input.operationId));
      expect(operation!.state).toBe('in_progress');
      expect((await events(broker)).map((event) => event.action)).toEqual(['fill.started']);
      return { ok: true, finalOrigin: intent.origin, submitted: false, screenshot: null };
    });
    await invoke(broker, 'vault.fill', { itemId: item.id }, input);
    expect((await invoke(broker, 'vault.operations.get', { operationId: input.operationId }, {})).data)
      .toMatchObject({ kind: 'fill', state: 'done', result: { state: 'done' } });
  });

  it('concurrent identical calls report operation_in_progress and run only once', async () => {
    const { broker, fill } = harness();
    const item = await login(broker);
    const input = fillInput();
    let entered!: () => void;
    const running = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void;
    const resume = new Promise<void>((resolve) => { release = resolve; });
    fill.mockImplementationOnce(async () => {
      entered();
      await resume;
      return { ok: true, finalOrigin: ORIGIN, submitted: false, screenshot: null };
    });
    const first = invoke(broker, 'vault.fill', { itemId: item.id }, input);
    await running;
    try {
      await expect(invoke(broker, 'vault.fill', { itemId: item.id }, input)).rejects.toMatchObject({ reason: 'operation_in_progress' });
      expect((await invoke(broker, 'vault.operations.get', { operationId: input.operationId }, {})).data).toMatchObject({ state: 'in_progress', result: null });
    } finally { release(); }
    const firstResult = await first;
    expect((await invoke(broker, 'vault.fill', { itemId: item.id }, input)).data).toEqual(firstResult.data);
    expect(fill).toHaveBeenCalledTimes(1);
    expect((await events(broker)).map((event) => event.action)).toEqual(['fill.started', 'fill.done']);
  });

  it('reuses neither an operation id for a changed intent nor for another action kind', async () => {
    const { broker, fill, execute } = harness();
    const item = await login(broker);
    const key = await apiKey(broker);
    const input = fillInput();
    await invoke(broker, 'vault.fill', { itemId: item.id }, input);
    await expect(invoke(broker, 'vault.fill', { itemId: item.id }, { ...input, submit: true }))
      .rejects.toMatchObject({ reason: 'operation_id_reused' });
    await expect(invoke(broker, 'vault.callApi', { itemId: key.id }, apiInput({ operationId: input.operationId })))
      .rejects.toMatchObject({ reason: 'operation_id_reused' });
    expect(fill).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it('persists refusal outcomes and returns them on replay', async () => {
    const { broker, fill } = harness();
    const item = await login(broker);
    fill.mockResolvedValue({ ok: false, code: 'fields_not_found', observedOrigin: ORIGIN, screenshot: null });
    const input = fillInput();
    const result = await invoke(broker, 'vault.fill', { itemId: item.id }, input);
    expect((await invoke(broker, 'vault.fill', { itemId: item.id }, input)).data).toEqual(result.data);
    expect(fill).toHaveBeenCalledTimes(1);
  });

  it.each(['fill', 'callApi'] as const)('KMS failure after reservation returns the same persisted refusal on replay: %s', async (action) => {
    const { broker, fill, execute } = harness();
    const item = action === 'fill' ? await login(broker) : await apiKey(broker);
    const unwrap = vi.spyOn(broker.components.kms, 'unwrap').mockRejectedValue(new KmsUnavailableError('test KMS unavailable'));
    const operationId = randomUUID();
    const request = () => action === 'fill'
      ? invoke(broker, 'vault.fill', { itemId: item.id }, fillInput({ operationId }))
      : invoke(broker, 'vault.callApi', { itemId: item.id }, apiInput({ operationId }));
    const first = await request();
    expect(first.data).toMatchObject({ state: 'refused', code: action === 'fill' ? 'browser_unavailable' : 'upstream_unreachable' });
    expect((await request()).data).toEqual(first.data);
    expect(unwrap).toHaveBeenCalledTimes(1);
    expect(fill).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect((await events(broker)).map((event) => event.action)).toEqual(action === 'fill'
      ? ['fill.started', 'fill.refused'] : ['api.started', 'api.refused']);
  });

  it('exactly one concurrent fill consumes an approved one-use origin', async () => {
    const { broker, fill } = harness();
    const item = await login(broker);
    const { data: pending } = await invoke(broker, 'vault.fill', { itemId: item.id }, fillInput({ origin: NEW_ORIGIN }));
    if (pending.state !== 'approval_required') throw new Error('expected approval');
    await approve(broker, pending.approvalId);
    const outcomes = await Promise.all([
      invoke(broker, 'vault.fill', { itemId: item.id }, fillInput({ origin: NEW_ORIGIN })),
      invoke(broker, 'vault.fill', { itemId: item.id }, fillInput({ origin: NEW_ORIGIN })),
    ]);
    expect(outcomes.map((outcome) => outcome.data.state).sort()).toEqual(['approval_required', 'done']);
    expect(fill).toHaveBeenCalledTimes(1);
  });

  it('does not expose another requester or space through operations.get or action replay', async () => {
    const { broker } = harness();
    const item = await login(broker);
    const input = fillInput();
    await invoke(broker, 'vault.fill', { itemId: item.id }, input);
    await expect(invoke(broker, 'vault.operations.get', { operationId: input.operationId }, {}, { caller: otherCaller }))
      .rejects.toMatchObject({ code: 'not_found' });
    const sameMemberOtherSpace = makeCaller({ spaceId: SPACE_B });
    await expect(invoke(broker, 'vault.operations.get', { operationId: input.operationId }, {}, { caller: sameMemberOtherSpace }))
      .rejects.toMatchObject({ code: 'not_found' });
    await expect(invoke(broker, 'vault.fill', { itemId: item.id }, input, { caller: sameMemberOtherSpace }))
      .rejects.toMatchObject({ code: 'not_found' });
  });

  it('startup marks each action kind unknown once and audits it in the same transaction', async () => {
    const { broker, fill, execute } = harness();
    const item = await login(broker);
    const input = fillInput();
    const fillHash = hashIntent({ action: 'fill', itemId: item.id, origin: input.origin,
      startUrl: null, submit: input.submit, purpose: input.purpose });
    await broker.store.transaction(scopeOf(testCaller), async (tx) => {
      for (const kind of ['fill', 'call_api', 'spend'] as OperationKind[]) {
        await tx.operations.reserve({ kind, itemId: item.id, operationId: kind === 'fill' ? input.operationId : randomUUID(),
          intentHash: kind === 'fill' ? fillHash : 'a'.repeat(64), actor: actorOf(testCaller), approvalId: kind === 'spend' ? randomUUID() : null });
      }
    });
    expect(await markUnknownOperations(broker.store)).toHaveLength(3);
    expect(await markUnknownOperations(broker.store)).toEqual([]);
    expect((await events(broker)).map((event) => event.action).sort()).toEqual(['api.unknown', 'fill.unknown', 'spend.unknown']);
    const result = await invoke(broker, 'vault.fill', { itemId: item.id }, input);
    expect(result.data).toEqual({ state: 'unknown', operationId: input.operationId, itemId: item.id });
    expect((await invoke(broker, 'vault.operations.get', { operationId: input.operationId }, {})).data)
      .toMatchObject({ state: 'unknown', result: result.data });
    expect(fill).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it('unknown marking rolls back when any unknown event cannot be appended', async () => {
    const { broker } = harness();
    const item = await login(broker);
    const operationId = randomUUID();
    await broker.store.transaction(scopeOf(testCaller), (tx) => tx.operations.reserve({ kind: 'fill', itemId: item.id, operationId,
      intentHash: 'a'.repeat(64), actor: actorOf(testCaller), approvalId: null }));
    broker.store.faults.auditAppend = true;
    await expect(markUnknownOperations(broker.store)).rejects.toMatchObject({ name: 'AuditUnavailableError' });
    expect((await broker.store.transaction(scopeOf(testCaller), (tx) => tx.operations.get(operationId)))!.state).toBe('in_progress');
    broker.store.faults.auditAppend = false;
    expect(await markUnknownOperations(broker.store)).toHaveLength(1);
  });

  it('a failed completion append leaves the original reservation for startup recovery', async () => {
    const { broker, fill } = harness();
    const item = await login(broker);
    const input = fillInput();
    fill.mockImplementationOnce(async () => {
      broker.store.faults.auditAppend = true;
      return { ok: true, finalOrigin: ORIGIN, submitted: false, screenshot: null };
    });
    await expect(invoke(broker, 'vault.fill', { itemId: item.id }, input)).rejects.toMatchObject({ reason: 'audit_unavailable' });
    expect(fill.mock.calls[0]![0].material.password.disposed).toBe(true);
    expect((await broker.store.transaction(scopeOf(testCaller), (tx) => tx.operations.get(input.operationId)))!.state).toBe('in_progress');
    broker.store.faults.auditAppend = false;
    broker.audit.state = 'ok';
    await markUnknownOperations(broker.store);
    expect((await invoke(broker, 'vault.fill', { itemId: item.id }, input)).data.state).toBe('unknown');
    expect(fill).toHaveBeenCalledTimes(1);
  });
});
