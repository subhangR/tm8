import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createEgressExecutor, type ConnectorRegistry, type EgressTransport } from '../../src/egress/index.js';
import { buildCanarySet } from '../../src/canary/index.js';
import { EgressRefusal, type ApiRequestSpec, type EgressExecutor } from '../../src/types.js';
import { RecordingAlertSink, otherCaller, scopeOf, testCaller } from '../support/kit.js';
import { HOST, apiInput, apiKey, approve, events, harness, invoke, login, policyInput, share } from './fixtures.js';

function fakeNetwork(body = '{"ok":true}', connectors?: ConnectorRegistry) {
  const resolve = vi.fn(async () => [{ address: '93.184.216.34', family: 4 as const }]);
  const transport = vi.fn<EgressTransport>(async () => ({ status: 200, headers: { 'content-type': 'application/json' },
    body: Readable.from([Buffer.from(body)]), close() {} }));
  const executor = createEgressExecutor({ resolve, transport, ...(connectors ? { connectors } : {}) });
  const execute = vi.fn<EgressExecutor['execute']>((input) => executor.execute(input));
  return { execute, transport, resolve };
}

describe('agent API actions', () => {
  it('passes the active policy, canary set and signal and disposes the key on success', async () => {
    const { broker, execute } = harness();
    const item = await apiKey(broker);
    const signal = new AbortController().signal;
    const input = apiInput();
    const { data } = await invoke(broker, 'vault.callApi', { itemId: item.id }, input, { signal });
    expect(data.state).toBe('done');
    const received = execute.mock.calls[0]![0];
    expect(received.signal).toBe(signal);
    expect(received.canaries).toBe(broker.components.canaries);
    expect(received.policy).toMatchObject({ keyId: item.id, hosts: [HOST], version: 1 });
    expect(received.key.disposed).toBe(true);
    const stored = await broker.store.transaction(scopeOf(testCaller), (tx) => tx.operations.get(input.operationId));
    expect(stored!.result).toMatchObject({ state: 'done', response: { headers: {}, body: { kind: 'withheld', reason: 'replayed' } } });
    const again = await invoke(broker, 'vault.callApi', { itemId: item.id }, input);
    expect(again.data).toEqual(stored!.result);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ method: 'GET', url: 'https://elsewhere.example.test/v1/resource' }, 'host_not_allowed'],
    [{ method: 'DELETE', url: `https://${HOST}/v1/resource` }, 'method_not_allowed'],
    [{ method: 'GET', url: `https://${HOST}/v10/resource` }, 'path_not_allowed'],
    [{ method: 'GET', url: `https://${HOST}/v1/tokens` }, 'token_management_denied'],
  ] as const)('delegates policy validation to the real executor: %s', async (request, code) => {
    const network = fakeNetwork();
    const { broker } = harness({ components: { egress: network } });
    const item = await apiKey(broker);
    const { data } = await invoke(broker, 'vault.callApi', { itemId: item.id }, apiInput({ request }));
    expect(data).toMatchObject({ state: 'refused', code });
    expect(network.execute).toHaveBeenCalledTimes(1);
    expect(network.transport).not.toHaveBeenCalled();
    expect((broker.components.alerts as RecordingAlertSink).kinds()).toContain('egress_refused');
    expect((await events(broker)).at(-1)).toMatchObject({ action: 'api.refused', params: { code } });
    expect(network.execute.mock.calls[0]![0].key.disposed).toBe(true);
  });

  it('refuses missing policies and wrong item types without executing', async () => {
    const { broker, execute } = harness();
    const key = await apiKey(broker, null);
    const loginItem = await login(broker);
    expect((await invoke(broker, 'vault.callApi', { itemId: key.id }, apiInput())).data).toMatchObject({ state: 'refused', code: 'policy_missing' });
    await expect(invoke(broker, 'vault.callApi', { itemId: loginItem.id }, apiInput())).rejects.toMatchObject({ reason: 'wrong_item_type' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses an empty pre-review allowlist intersection before reservation', async () => {
    const { broker, execute } = harness({ config: { mode: 'pre_review' } });
    const item = await apiKey(broker);
    const input = apiInput();
    await expect(invoke(broker, 'vault.callApi', { itemId: item.id }, input)).rejects.toMatchObject({ reason: 'pre_review_limit' });
    expect(execute).not.toHaveBeenCalled();
    expect(await broker.store.transaction(scopeOf(testCaller), (tx) => tx.operations.get(input.operationId))).toBeNull();
  });

  it('a connector template cannot restore a host removed by the pre-review allowlist', async () => {
    const otherHost = 'other-api.example.test';
    const connectors: ConnectorRegistry = { test_connector: { id: 'test_connector', hosts: [HOST, otherHost],
      injection: { kind: 'bearer' }, defaultPathPrefixes: ['/v1'], deny: [] } };
    const network = fakeNetwork(undefined, connectors);
    const { broker } = harness({ config: { mode: 'pre_review', preReview: {
      maxItemsPerMember: 20, allowedFillOrigins: [], allowedApiHosts: [HOST] } }, components: { egress: network } });
    const item = await apiKey(broker, { ...policyInput, mode: 'connector', connector: 'test_connector', hosts: [HOST, otherHost] });
    const { data } = await invoke(broker, 'vault.callApi', { itemId: item.id }, apiInput({ request: { method: 'GET', url: `https://${otherHost}/v1/resource` } }));
    expect(data).toMatchObject({ state: 'refused', code: 'host_not_allowed' });
    expect(network.execute.mock.calls[0]![0].policy.hosts).toEqual([HOST]);
    expect(network.resolve).not.toHaveBeenCalled();
    expect(network.transport).not.toHaveBeenCalled();
  });

  it('intersects a grant and pre-review hosts before reserving when together they leave no destination', async () => {
    const otherHost = 'other-api.example.test';
    const { broker, execute } = harness({ config: { mode: 'pre_review', preReview: {
      maxItemsPerMember: 20, allowedFillOrigins: [], allowedApiHosts: [HOST] } } });
    const item = await apiKey(broker, { ...policyInput, hosts: [HOST, otherHost] });
    await share(broker, item.id, otherCaller, { hosts: [otherHost], origins: null, requireApprovalPerUse: false });
    const input = apiInput({ request: { method: 'GET', url: `https://${otherHost}/v1/resource` } });
    await expect(invoke(broker, 'vault.callApi', { itemId: item.id }, input, { caller: otherCaller }))
      .rejects.toMatchObject({ reason: 'pre_review_limit' });
    expect(execute).not.toHaveBeenCalled();
    expect(await broker.store.transaction(scopeOf(otherCaller), (tx) => tx.operations.get(input.operationId))).toBeNull();
  });

  it('binds per-use API approval to verbatim hostname, pathname, method and exact request hash', async () => {
    const { broker, execute } = harness();
    const item = await apiKey(broker);
    await share(broker, item.id, otherCaller, { hosts: [HOST], origins: null, requireApprovalPerUse: true });
    const request: ApiRequestSpec = { method: 'POST', url: `https://${HOST}/v1/a%20b?view=test-only`, body: { kind: 'json', value: { count: 1 } } };
    const input = apiInput({ request });
    const { data } = await invoke(broker, 'vault.callApi', { itemId: item.id }, input, { caller: otherCaller });
    if (data.state !== 'approval_required') throw new Error('expected approval');
    const { data: approved } = await approve(broker, data.approvalId);
    expect(approved.boundParams).toMatchObject({ kind: 'use', host: HOST, method: 'POST', path: '/v1/a%20b',
      expiresAt: approved.expiresAt, requesterMemberId: otherCaller.memberId });
    expect(approved.boundParams.actionIntentHash).toMatch(/^[a-f0-9]{64}$/);
    const changed = await invoke(broker, 'vault.callApi', { itemId: item.id }, apiInput({ request: {
      ...request, body: { kind: 'json', value: { count: 2 } } } }), { caller: otherCaller });
    expect(changed.data.state).toBe('approval_required');
    expect((await invoke(broker, 'vault.callApi', { itemId: item.id }, { ...input, operationId: randomUUID() }, { caller: otherCaller })).data.state).toBe('done');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('keeps egress refusal params fixed and disposes the key after an executor error', async () => {
    const { broker, execute } = harness();
    const item = await apiKey(broker);
    execute.mockRejectedValueOnce(new EgressRefusal('private_address'));
    const input = apiInput({ request: { method: 'GET', url: `https://${HOST}/v1/resource?private=test-only` } });
    expect((await invoke(broker, 'vault.callApi', { itemId: item.id }, input)).data).toMatchObject({ state: 'refused', code: 'private_address' });
    expect(execute.mock.calls[0]![0].key.disposed).toBe(true);
    const recorded = await events(broker);
    expect(recorded.at(-1)!.params).toEqual({ operationId: input.operationId, code: 'private_address' });
    expect(JSON.stringify(recorded)).not.toContain('?private');
    expect(JSON.stringify((broker.components.alerts as RecordingAlertSink).alerts)).not.toContain('?private');
  });

  it('wires the real response canary filter and raises the matching alert without returning the value', async () => {
    const planted = ['test', 'only', 'canary'].join('-');
    const network = fakeNetwork(JSON.stringify({ reflected: planted }));
    const canaries = buildCanarySet([planted]);
    const { broker } = harness({ components: { egress: network, canaries } });
    const item = await apiKey(broker);
    const response = await invoke(broker, 'vault.callApi', { itemId: item.id }, apiInput());
    expect(response.data).toMatchObject({ state: 'done', response: { body: { kind: 'withheld', reason: 'canary' } } });
    expect(JSON.stringify(response)).not.toContain(planted);
    expect(network.execute.mock.calls[0]![0].canaries).toBe(canaries);
    expect((await events(broker)).at(-1)).toMatchObject({ action: 'canary.detected', params: { source: 'egress_response' } });
    expect((broker.components.alerts as RecordingAlertSink).kinds()).toContain('canary_detected');
  });
});
