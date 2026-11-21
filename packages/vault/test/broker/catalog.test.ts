import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { VAULT_OPERATIONS, VAULT_OUTPUT_SCHEMAS } from '@tm8/contract';
import { actorOf, memberScope, type VaultCaller } from '../../src/core-types.js';
import { buildCanarySet } from '../../src/canary/index.js';
import { createBrokerCoreHandlers } from '../../src/broker/handlers/index.js';
import { RecordingAlertSink, newApproval, newLogin, otherCaller, outsiderCaller, seedItem, testCaller, tokenPair } from '../support/kit.js';
import { harness, schemaExample, scopedStubHandlers, stubHandlers, withoutRequestId, type Harness } from './support.js';

const opened: Harness[] = [];
afterEach(async () => { for (const h of opened.splice(0)) await h.close(); });
async function setup(options: Parameters<typeof harness>[0] = {}): Promise<Harness> { const h = await harness(options); opened.push(h); return h; }

function walk(schema: z.ZodTypeAny, path: string[], visit: (path: string[]) => void): void {
  if (schema instanceof z.ZodObject) {
    for (const [key, child] of Object.entries(schema.shape as Record<string, z.ZodTypeAny>)) {
      visit([...path, key]); walk(child, [...path, key], visit);
    }
  } else if (schema instanceof z.ZodArray) walk(schema.element, path, visit);
  else if (schema instanceof z.ZodUnion || schema instanceof z.ZodDiscriminatedUnion) for (const child of schema.options as z.ZodTypeAny[]) walk(child, path, visit);
  else if (schema instanceof z.ZodNullable || schema instanceof z.ZodOptional) walk(schema.unwrap(), path, visit);
  else if (schema instanceof z.ZodRecord) walk(schema._def.valueType, path, visit);
  else if (schema instanceof z.ZodEffects) walk(schema.innerType(), path, visit);
}

describe('acceptance 1: catalog-generated response boundary', () => {
  it.each(VAULT_OPERATIONS)('$name has no item-value field and its generated response validates', (row) => {
    const forbidden = new Set(['password', 'pan', 'cvv', 'cvc', 'totp', 'totpSeed', 'notes', 'secret', 'secretValue', 'plaintext',
      'ciphertext', 'wrappedDek', 'sealed', 'key', 'd', 'fields', 'sessionToken', 'refreshToken', 'linkToken']);
    walk(VAULT_OUTPUT_SCHEMAS[row.name], [], (path) => {
      expect(forbidden.has(path.at(-1)!)).toBe(false);
      if (path.at(-1) === 'value') expect(path.join('.').endsWith('response.body.value')).toBe(true);
    });
    expect(VAULT_OUTPUT_SCHEMAS[row.name].safeParse(schemaExample(VAULT_OUTPUT_SCHEMAS[row.name])).success).toBe(true);
  });
  it.each(VAULT_OPERATIONS)('$name sweeps every serialized response, including the attested envelope', async (row) => {
    const h = await setup({ handlers: stubHandlers() });
    let planted = '';
    const response = await h.send(row.name, { beforeSend: (header) => {
      // Every response has the verified request id, even doors with only boolean data or a fixed v1 refusal.
      planted = (JSON.parse(Buffer.from(header.split('.')[0]!, 'base64url').toString()) as { rid: string }).rid;
      h.components.canaries = buildCanarySet([planted]);
    } });
    expect(response.status).toBe(500);
    expect(response.text.includes(planted)).toBe(false);
    expect((h.components.alerts as RecordingAlertSink).kinds()).toEqual(['canary_detected']);
  });
});

async function foreignIds(h: Harness, caller: VaultCaller): Promise<Record<string, string>> {
  const item = await seedItem(h.store, caller, newLogin(caller));
  const ids = await h.store.transaction(memberScope(caller), async (tx) => {
    const grant = await tx.grants.create({ id: randomUUID(), itemId: item.id, granteeKind: 'member', granteeId: randomUUID(),
      constraints: { origins: null, hosts: null, requireApprovalPerUse: false }, expiresAt: null, createdBy: actorOf(caller) });
    const approval = await tx.approvals.create(newApproval(item.id, caller, h.clock));
    const operationId = randomUUID();
    await tx.operations.reserve({ operationId, itemId: item.id, kind: 'fill', intentHash: '0'.repeat(64), actor: actorOf(caller), approvalId: null });
    const passkey = await tx.passkeys.create({ id: randomUUID(), credentialId: tokenPair().token, publicKey: 'dGVzdC1wdWJsaWMta2V5', counter: 0,
      transports: ['internal'], backedUp: false, deviceType: 'singleDevice', aaguid: null, name: 'Test passkey' });
    const session = await tx.sessions.create({ id: randomUUID(), passkeyId: passkey.id, deviceLabel: 'Test device', tokenHash: tokenPair().hash,
      refreshHash: tokenPair().hash, expiresAt: h.clock.iso(600_000), refreshExpiresAt: h.clock.iso(600_000), familyExpiresAt: h.clock.iso(600_000) });
    const registration = await tx.challenges.create({ id: randomUUID(), purpose: 'registration', action: null, intentHash: null,
      challenge: 'dGVzdC1jaGFsbGVuZ2U', registration: { name: 'Test key', via: 'step_up', codeId: null, userHandle: 'dGVzdC11c2Vy' }, expiresAt: h.clock.iso(600_000) });
    const capture = await tx.captureLinks.create({ id: randomUUID(), itemType: 'login', purpose: 'create', itemId: null, name: null,
      tokenHash: tokenPair().hash, captureKid: h.components.captureKeys.kid, expiresAt: h.clock.iso(600_000), createdBy: actorOf(caller) });
    return { itemId: item.id, grantId: grant.id, approvalId: approval.id, operationId, passkeyId: passkey.id, sessionId: session.id,
      registrationId: registration.id, captureId: capture.id };
  });
  const saved = h.auth.session;
  h.auth.session = { ...saved!, memberId: caller.memberId };
  const begun = await h.send('vault.imports.begin', { caller });
  h.auth.session = saved;
  expect(begun.status).toBe(200);
  return { ...ids, importId: begun.json.data.importId as string };
}

describe('acceptance 19: catalog-generated cross-tenant substitutions', () => {
  it.each(VAULT_OPERATIONS.filter((row) => row.path.includes(':')))('$name conceals member and space existence like a random id', async (row) => {
    const h = await setup({ handlers: { ...scopedStubHandlers(), ...createBrokerCoreHandlers() } });
    const ownForeign = await foreignIds(h, otherCaller);
    const spaceForeign = await foreignIds(h, outsiderCaller);
    const key = /:([A-Za-z]+)/.exec(row.path)![1]!;
    const responses = [];
    for (const id of [randomUUID(), ownForeign[key]!, spaceForeign[key]!]) {
      // Interleave all three with the same valid credentials and input class. No token or id is included in a refusal.
      responses.push(await h.send(row.name, { params: { [key]: id } }));
    }
    expect(new Set(responses.map((response) => response.status)).size).toBe(1);
    expect(new Set(responses.map((response) => JSON.stringify(withoutRequestId(response)))).size).toBe(1);
    // These requests all take the local refusal class; none performs KMS, egress, fill or a foreign-row operation.
    expect(responses.every((response) => response.ms < 250)).toBe(true);
    expect(responses.every((response) => response.status >= 400)).toBe(true);
  });
});
