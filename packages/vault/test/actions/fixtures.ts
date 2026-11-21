import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import type { VaultInput } from '@tm8/contract';
import { createAgentActionHandlers } from '../../src/actions/handlers.js';
import { actorOf, type AgentActionOp, type BrokerConfig, type PolicyInput,
  type VaultCaller, type VaultHandler, type VaultPathParams } from '../../src/core-types.js';
import type { FillDriver, EgressExecutor } from '../../src/types.js';
import { newApiKey, newLogin, scopeOf, testBroker, testCaller, testSecret, fakeStepUpProof, type TestBroker } from '../support/kit.js';
import { TestSpendProcessor } from './test-spend-processor.js';

export const handlers = createAgentActionHandlers();
export const ORIGIN = 'https://login.example.test';
export const NEW_ORIGIN = 'https://another.example.test';
export const HOST = 'api.example.test';
export const policyInput: PolicyInput = { mode: 'generic', connector: null, hosts: [HOST], methods: ['GET', 'POST'],
  pathPrefixes: ['/v1'], maxRequestBytes: 4096, maxResponseBytes: 4096, injection: { kind: 'bearer' } };

export function harness(options: Parameters<typeof testBroker>[0] = {}) {
  const fill = vi.fn<FillDriver['fill']>(async ({ intent }) => ({ ok: true, finalOrigin: intent.origin, submitted: intent.submit, screenshot: null }));
  const execute = vi.fn<EgressExecutor['execute']>(async () => ({ status: 200, headers: {}, body: { kind: 'json', value: { ok: true } }, redactions: 0 }));
  const processor = new TestSpendProcessor();
  const broker = testBroker({ ...options, components: { fillDriver: { fill, close: async () => {} },
    egress: { execute }, spend: processor, ...options.components } });
  return { broker, fill, execute, processor };
}

export function enableTestSpend(broker: TestBroker): void {
  // BrokerConfig intentionally cannot enable payments in any source configuration.
  (broker.config.features as Omit<BrokerConfig['features'], 'spend'> & { spend: boolean }).spend = true;
}

export async function invoke<Op extends AgentActionOp>(broker: TestBroker, op: Op, params: VaultPathParams<Op>,
  input: VaultInput<Op>, options: Parameters<TestBroker['context']>[1] = {}) {
  const handler = handlers[op] as VaultHandler<Op>;
  return handler(await broker.context(op, options), { params, input });
}

export async function login(broker: TestBroker, overrides: Partial<ReturnType<typeof newLogin>> = {}) {
  const item = newLogin(testCaller, { devMode: true, ...overrides });
  const secret = await testSecret(broker.components.kms, { id: item.id, ownerMemberId: testCaller.memberId }, 1,
    JSON.stringify({ password: 'test-only password', notes: 'test-only private note', totp: 'test-only unused totp' }));
  return broker.store.transaction(scopeOf(testCaller), (tx) => tx.items.create(item, secret));
}

export async function apiKey(broker: TestBroker, policy: PolicyInput | null = policyInput) {
  const item = newApiKey();
  const secret = await testSecret(broker.components.kms, { id: item.id, ownerMemberId: testCaller.memberId }, 1,
    JSON.stringify({ key: 'test-only-api-material' }));
  return broker.store.transaction(scopeOf(testCaller), async (tx) => {
    const created = await tx.items.create(item, secret);
    if (policy) await tx.policies.set(created.id, created.version, policy, actorOf(testCaller));
    return created;
  });
}

export async function card(broker: TestBroker) {
  const item = newLogin(testCaller, { type: 'card', origins: [], username: null, last4: '1111' });
  const secret = await testSecret(broker.components.kms, { id: item.id, ownerMemberId: testCaller.memberId }, 1, '{}');
  return broker.store.transaction(scopeOf(testCaller), (tx) => tx.items.create(item, secret));
}

export function fillInput(overrides: Partial<VaultInput<'vault.fill'>> = {}): VaultInput<'vault.fill'> {
  return { operationId: randomUUID(), origin: ORIGIN, submit: false, purpose: 'Test login', ...overrides };
}

export function apiInput(overrides: Partial<VaultInput<'vault.callApi'>> = {}): VaultInput<'vault.callApi'> {
  return { operationId: randomUUID(), request: { method: 'GET', url: `https://${HOST}/v1/resource` }, purpose: 'Test API call', ...overrides };
}

export function spendInput(overrides: Partial<VaultInput<'vault.spend.request'>> = {}): VaultInput<'vault.spend.request'> {
  return { clientMutationId: randomUUID(), merchant: 'Example merchant', amountMinor: 1234, currency: 'USD',
    itemSummary: 'Test item', purpose: 'Test purchase', ...overrides };
}

export async function approve(broker: TestBroker, approvalId: string, standing = false) {
  const { data: current } = await invoke(broker, 'vault.approvals.get', { approvalId }, {});
  return invoke(broker, 'vault.approvals.decide', { approvalId }, { clientMutationId: randomUUID(), decision: 'approve',
    approvalIntentHash: current.intentHash, standing, stepUp: fakeStepUpProof() });
}

export async function share(broker: TestBroker, itemId: string, caller: VaultCaller,
  constraints = { origins: null as string[] | null, hosts: null as string[] | null, requireApprovalPerUse: false }, expiresAt: string | null = null) {
  return broker.store.transaction(scopeOf(testCaller), (tx) => tx.grants.create({ id: randomUUID(), itemId,
    granteeKind: 'member', granteeId: caller.memberId, constraints, expiresAt, createdBy: actorOf(testCaller) }));
}

export async function events(broker: TestBroker) {
  return broker.store.transaction({ kind: 'system', purpose: 'audit' }, async (tx) => tx.audit.range(1, (await tx.audit.head()).seq));
}
