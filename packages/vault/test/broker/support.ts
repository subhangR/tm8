import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { VAULT_OPERATIONS, VAULT_OUTPUT_SCHEMAS, type VaultOperationName } from '@tm8/contract';
import { StoreNotFoundError, type HandlerContext, type VaultCaller, type VaultHandlers } from '../../src/core-types.js';
import { exportAttestationKeyPair, generateAttestationKeyPair, signAttestation } from '../../src/relay/attestation.js';
import { createBrokerServer, type BrokerServer, type BrokerServerOptions } from '../../src/broker/server.js';
import { createBrokerCoreHandlers } from '../../src/broker/handlers/index.js';
import { fakeStepUpProof, testBroker, testCaller, type TestBroker } from '../support/kit.js';

export const ID = '00000000-0000-4000-8000-000000000011';
export const ORIGIN = 'https://tm8.example.test';

/** Minimal schema-valid data, generated from the success catalog rather than a second op list. */
export function schemaExample(schema: z.ZodTypeAny): unknown {
  if (schema instanceof z.ZodObject) return Object.fromEntries(Object.entries(schema.shape as Record<string, z.ZodTypeAny>)
    .filter(([, child]) => !(child instanceof z.ZodOptional)).map(([key, child]) => [key, schemaExample(child)]));
  if (schema instanceof z.ZodLiteral) return schema.value;
  if (schema instanceof z.ZodEnum) return schema.options[0];
  if (schema instanceof z.ZodNullable) return null;
  if (schema instanceof z.ZodOptional) return undefined;
  if (schema instanceof z.ZodBoolean) return false;
  if (schema instanceof z.ZodNumber) {
    for (const value of [0, 1, 100, 2000]) if (schema.safeParse(value).success) return value;
  }
  if (schema instanceof z.ZodString) {
    const checks = schema._def.checks;
    const lengths = checks.flatMap((check) => 'value' in check && typeof check.value === 'number' ? [check.value] : []);
    const candidates = ['test-only', ID, '2026-11-20T12:00:00.000Z', 'https://example.com', 'USD',
      ...[4, 8, 10, 12, 16, 32, 43, 64, 87, ...lengths].filter((n) => n <= 1024).flatMap((n) => ['A'.repeat(n), '0'.repeat(n)])];
    for (const value of candidates) if (schema.safeParse(value).success) return value;
  }
  if (schema instanceof z.ZodArray) {
    const n = schema._def.exactLength?.value ?? schema._def.minLength?.value ?? 0;
    return Array.from({ length: n }, () => schemaExample(schema.element));
  }
  if (schema instanceof z.ZodUnion || schema instanceof z.ZodDiscriminatedUnion) {
    for (const option of schema.options as z.ZodTypeAny[]) {
      try { const value = schemaExample(option); if (schema.safeParse(value).success) return value; } catch { /* next variant */ }
    }
  }
  if (schema instanceof z.ZodRecord) return {};
  if (schema instanceof z.ZodUnknown || schema instanceof z.ZodAny || schema instanceof z.ZodNull) return null;
  if (schema instanceof z.ZodEffects) return schemaExample(schema.innerType());
  throw new Error('broker test: no schema example');
}

export function validInput(op: VaultOperationName): Record<string, unknown> {
  const command = { clientMutationId: randomUUID() };
  const stepUp = fakeStepUpProof();
  const assertion = stepUp.assertion;
  const sealed = { v: 1, kid: '0'.repeat(32), epk: 'A'.repeat(87), nonce: 'A'.repeat(16), ct: 'A'.repeat(23) };
  const policy = { mode: 'generic', connector: null, hosts: ['api.example.com'], methods: ['GET'], pathPrefixes: ['/v1'],
    maxRequestBytes: 1024, maxResponseBytes: 1024, injection: { kind: 'bearer' } };
  switch (op) {
    case 'vault.captureLinks.create': return { ...command, itemType: 'login', purpose: 'create' };
    case 'vault.fill': return { operationId: ID, origin: 'https://example.com', submit: false, purpose: 'test-only' };
    case 'vault.callApi': return { operationId: ID, request: { method: 'GET', url: 'https://api.example.com/v1' }, purpose: 'test-only' };
    case 'vault.origins.requestAdd': return { ...command, origin: 'https://example.com', mode: 'one_use', purpose: 'test-only' };
    case 'vault.spend.request': return { ...command, merchant: 'test-only', amountMinor: 100, currency: 'USD', itemSummary: 'test-only', purpose: 'test-only' };
    case 'vault.spend.execute': return { operationId: ID };
    case 'vault.webauthn.challenge': return { ...command, purpose: 'sign_in' };
    case 'vault.session.begin': return { ...command, challengeId: ID, assertion };
    case 'vault.passkeys.registerBegin': return { ...command, name: 'test-only', enrollmentCode: 'test-only-code' };
    case 'vault.passkeys.registerFinish': return { ...command, credential: { id: assertion.id, rawId: assertion.rawId, type: 'public-key',
      response: { clientDataJSON: 'e30', attestationObject: 'AAAA' }, clientExtensionResults: {} } };
    case 'vault.captures.open': return { ...command, linkToken: randomBytes(32).toString('base64url') };
    case 'vault.captures.submit': return { ...command, linkToken: randomBytes(32).toString('base64url'), sealed, stepUp };
    case 'vault.approvals.decide': return { ...command, decision: 'deny', approvalIntentHash: '0'.repeat(64) };
    case 'vault.items.update': return { ...command, expectedVersion: 1, name: 'Updated test item' };
    case 'vault.items.setProperties': return { ...command, expectedVersion: 1, devMode: false, stepUp };
    case 'vault.items.delete': return { ...command, expectedVersion: 1, stepUp };
    case 'vault.policies.set': return { ...command, expectedVersion: 1, policy, stepUp };
    case 'vault.grants.create': return { ...command, grantee: { kind: 'space', id: testCaller.spaceId },
      constraints: { origins: null, hosts: null, requireApprovalPerUse: false }, expiresAt: null, stepUp };
    case 'vault.imports.upload': return { ...command, sealed };
    case 'vault.imports.commit': return { ...command, rows: [{ index: 0, include: true, exposureTier: 'a' }], stepUp };
    case 'vault.recovery.codes.create': return { ...command, stepUp };
    default: return VAULT_OPERATIONS.find((row) => row.name === op)!.method === 'GET' ? {} : command;
  }
}

/** G and J are represented only by explicit seam stubs; all H handlers are real by default. */
export type MutableVaultHandlers = { -readonly [K in keyof VaultHandlers]: VaultHandlers[K] };
export function stubHandlers(): MutableVaultHandlers {
  const result: Record<string, unknown> = {};
  for (const row of VAULT_OPERATIONS) result[row.name] = async () => ({ data: schemaExample(VAULT_OUTPUT_SCHEMAS[row.name]) });
  return result as MutableVaultHandlers;
}

/** Scoped lookups for the foreign handler groups in generated tenant-isolation tests. */
export function scopedStubHandlers(): VaultHandlers {
  const handlers = stubHandlers();
  for (const row of VAULT_OPERATIONS) {
    if (!row.path.includes(':')) continue;
    (handlers as unknown as Record<string, unknown>)[row.name] = async (ctx: HandlerContext, { params }: { params: Record<string, string> }) => {
      return ctx.store.transaction({ kind: 'member', memberId: ctx.caller.memberId, spaceId: ctx.caller.spaceId }, async (tx) => {
        let found: unknown = null;
        if (params.itemId) found = await tx.items.get(params.itemId);
        else if (params.approvalId) found = await tx.approvals.get(params.approvalId);
        else if (params.operationId) found = await tx.operations.get(params.operationId);
        else if (params.sessionId) found = await tx.sessions.get(params.sessionId);
        else if (params.passkeyId) found = await tx.passkeys.get(params.passkeyId);
        else if (params.registrationId) found = await tx.challenges.consume(params.registrationId, 'registration');
        if (!found) throw new StoreNotFoundError();
        return { data: schemaExample(VAULT_OUTPUT_SCHEMAS[row.name]) };
      });
    };
  }
  return handlers;
}

export interface WireResponse { status: number; text: string; json: any; headers: import('node:http').IncomingHttpHeaders; ms: number }
export interface Harness extends TestBroker {
  directory: string;
  socketPath: string;
  publicKeyFile: string;
  pair: ReturnType<typeof generateAttestationKeyPair>;
  handlers: VaultHandlers;
  server: BrokerServer;
  send(op: VaultOperationName, options?: SendOptions): Promise<WireResponse>;
  raw(method: string, path: string, options?: SendOptions): Promise<WireResponse>;
  close(): Promise<void>;
}
export interface SendOptions {
  input?: Record<string, unknown>;
  params?: Record<string, string>;
  caller?: VaultCaller;
  headers?: Record<string, string | undefined>;
  query?: string;
  body?: Buffer;
  attestation?: string | null;
  /**
   * The origin the relay attests. By default what the relay would: ORIGIN for a
   * member (a browser session) and null for an agent. No raw Origin header is
   * sent unless `headers` names one, because the relay never forwards it.
   */
  origin?: string | null;
  signedRequest?: { method?: string; path?: string; query?: string; body?: Buffer };
  beforeSend?: (header: string) => void;
}

export async function harness(options: { realCore?: boolean; handlers?: VaultHandlers; broker?: TestBroker;
  server?: Partial<BrokerServerOptions> } = {}): Promise<Harness> {
  const broker = options.broker ?? testBroker();
  const directory = await mkdtemp(join(tmpdir(), 'vault-h-'));
  const socketPath = join(directory, 'broker.sock');
  const publicKeyFile = join(directory, 'relay.pub');
  const pair = generateAttestationKeyPair();
  await writeFile(publicKeyFile, exportAttestationKeyPair(pair).publicPem, { mode: 0o600 });
  const handlers = options.handlers ?? { ...stubHandlers(), ...(options.realCore === false ? {} : createBrokerCoreHandlers()) };
  const server = await createBrokerServer({ ...broker, handlers, socketPath, relayPublicKeyFile: publicKeyFile, ...options.server });
  await server.listen();
  const raw = async (method: string, target: string, settings: SendOptions = {}): Promise<WireResponse> => {
    const path = target.split('?')[0]!;
    const query = settings.query ?? target.split('?').slice(1).join('?');
    const body = settings.body ?? (method === 'GET' ? Buffer.alloc(0) : Buffer.from(JSON.stringify(settings.input ?? {})));
    const signed = settings.signedRequest ?? {};
    const caller = settings.caller ?? testCaller;
    const origin = settings.origin !== undefined ? settings.origin : caller.kind === 'agent' ? null : ORIGIN;
    const header = settings.attestation === undefined ? signAttestation({ privateKey: pair.privateKey, caller, clock: broker.clock, origin,
      request: { method: signed.method ?? method, path: signed.path ?? path, query: signed.query ?? query, body: signed.body ?? body } }) : settings.attestation;
    if (header) settings.beforeSend?.(header);
    const headers: Record<string, string> = { 'content-type': 'application/json', cookie: 'tm8_vault_session=test-session-cookie' };
    if (header !== null) headers['x-tm8-vault-caller'] = header;
    for (const [key, value] of Object.entries(settings.headers ?? {})) { if (value === undefined) delete headers[key]; else headers[key] = value; }
    const started = performance.now();
    return new Promise((resolve, reject) => {
      const req = request({ socketPath, path: path + (query ? `?${query}` : ''), method, headers, agent: false }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode!, text, json: text ? JSON.parse(text) : null, headers: res.headers, ms: performance.now() - started });
        });
      });
      req.once('error', reject);
      req.end(body);
    });
  };
  return { ...broker, directory, socketPath, publicKeyFile, pair, handlers, server, raw,
    send(op, settings = {}) {
      const row = VAULT_OPERATIONS.find((row) => row.name === op)!;
      const path = row.path.replace(/:([A-Za-z]+)/g, (_match, key: string) => settings.params?.[key] ?? ID);
      return raw(row.method, path, { ...settings, input: settings.input ?? validInput(op) });
    },
    async close() { await server.close(); await broker.store.close(); broker.components.captureKeys.destroy(); await rm(directory, { recursive: true, force: true }); },
  };
}

export function withoutRequestId(response: WireResponse): unknown {
  const copy = structuredClone(response.json);
  if (copy?.error) delete copy.error.requestId;
  if (copy?.requestId) delete copy.requestId;
  return copy;
}
