import { afterEach, describe, expect, it } from 'vitest';
import { lstat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { VAULT_OPERATIONS } from '@tm8/contract';
import {
  AuditUnavailableError, StoreNotFoundError, StoreUnavailableError, StoreVersionConflictError, VaultError, memberScope,
} from '../../src/core-types.js';
import { KmsUnavailableError } from '../../src/crypto/kms.js';
import { signAttestation } from '../../src/relay/attestation.js';
import { BROKER_BODY_LIMITS, createBrokerServer } from '../../src/broker/server.js';
import { startBroker } from '../../src/broker/start.js';
import { buildCanarySet } from '../../src/canary/index.js';
import { RecordingAlertSink, fakeStepUpProof, newLogin, seedItem, testBroker, testCaller } from '../support/kit.js';
import { ID, ORIGIN, harness, stubHandlers, validInput, withoutRequestId, type Harness } from './support.js';

const opened: Harness[] = [];
afterEach(async () => { for (const h of opened.splice(0)) await h.close(); });
async function setup(options: Parameters<typeof harness>[0] = {}): Promise<Harness> { const h = await harness(options); opened.push(h); return h; }

describe('broker transport and attestation', () => {
  it('sets directory 0700 and socket 0600, unlinks on close, and preserves unrelated paths', async () => {
    const h = await setup();
    expect((await lstat(h.directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(h.socketPath)).mode & 0o777).toBe(0o600);
    const other = h.socketPath + '.other';
    await writeFile(other, 'test-only');
    await h.server.close();
    await expect(lstat(h.socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await lstat(other)).isFile()).toBe(true);
    await expect(createBrokerServer({ ...h, handlers: h.handlers, socketPath: other, relayPublicKeyFile: h.publicKeyFile }).then((server) => server.listen()))
      .rejects.toThrow('socket path unavailable');
  });
  it('uses one exact 401 for missing, malformed, mismatched and replayed attestations', async () => {
    const h = await setup();
    const body = Buffer.alloc(0);
    const header = signAttestation({ privateKey: h.pair.privateKey, caller: testCaller, clock: h.clock,
      request: { method: 'GET', path: '/v2/vault/status', query: '', body } });
    expect((await h.send('vault.status', { attestation: header })).status).toBe(200);
    const refused = [await h.send('vault.status', { attestation: null }), await h.send('vault.status', { attestation: 'invalid-test-only' }),
      await h.send('vault.status', { attestation: header }), await h.send('vault.status', { signedRequest: { query: 'wrong=1' } })];
    expect(new Set(refused.map((response) => response.status))).toEqual(new Set([401]));
    expect(new Set(refused.map((response) => response.text)).size).toBe(1);
    expect(refused[0]!.json.error).toMatchObject({ code: 'unauthenticated', retryable: false });
    expect(refused[0]!.json.error.details).toBeUndefined();
    expect([...h.server.attestationFailures.values()].reduce((a, b) => a + b, 0)).toBe(4);
  });
  it.each(['method', 'path', 'query', 'body'] as const)('binds the exact %s', async (part) => {
    const h = await setup({ realCore: false });
    const signedRequest = { [part]: part === 'body' ? Buffer.from('{} ') : part === 'method' ? 'PATCH' : part === 'path' ? '/v2/vault/elsewhere' : 'a=b' };
    const response = await h.send('vault.captureLinks.create', { signedRequest });
    expect(response.status).toBe(401);
  });
  it('lowercases attested ids and UUID path params, and uses the verified rid', async () => {
    const h = await setup();
    const item = await seedItem(h.store, testCaller, newLogin(testCaller, { id: 'abcdef00-abcd-4000-8000-abcdefabcdef' }));
    let rid = '';
    const response = await h.send('vault.items.get', { params: { itemId: item.id.toUpperCase() }, caller: { ...testCaller,
      memberId: testCaller.memberId.toUpperCase(), spaceId: testCaller.spaceId.toUpperCase() }, beforeSend: (header) => {
      rid = (JSON.parse(Buffer.from(header.split('.')[0]!, 'base64url').toString()) as { rid: string }).rid;
    } });
    expect(response.status).toBe(200);
    expect(response.json.data.id).toBe(item.id);
    expect(response.json.requestId).toBe(rid);
    expect((await h.raw('GET', '/v2/vault/items/not-a-uuid')).status).toBe(404);
  });
  it('requires JSON and rejects duplicate GET params and unrecognized input without echoing', async () => {
    const h = await setup();
    expect((await h.send('vault.captureLinks.create', { headers: { 'content-type': 'text/plain' } })).status).toBe(400);
    expect((await h.send('vault.items.list', { query: 'limit=1&limit=2' })).status).toBe(400);
    const marker = 'test-only-unrecognized-sensitive-data';
    const response = await h.send('vault.status', { query: `value=${marker}` });
    expect(response.status).toBe(400);
    expect(response.text.includes(marker)).toBe(false);
  });
  it('caps ordinary and import bodies with room for base64url expansion', async () => {
    const h = await setup({ realCore: false });
    expect((await h.send('vault.captureLinks.create', { body: Buffer.alloc(BROKER_BODY_LIMITS.small + 1, 32) })).status).toBe(413);
    const input = validInput('vault.imports.upload');
    (input.sealed as { ct: string }).ct = 'A'.repeat(Math.ceil(8 * 1024 * 1024 * 4 / 3));
    const response = await h.send('vault.imports.upload', { input });
    expect(response.status).toBe(200);
    expect((await h.send('vault.imports.upload', { body: Buffer.alloc(BROKER_BODY_LIMITS.import + 1, 32) })).status).toBe(413);
  });
  it('aborts the handler signal on graceful close', async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let aborted = false;
    const handlers = stubHandlers();
    handlers['vault.status'] = async (ctx) => {
      entered();
      await new Promise<void>((resolve) => ctx.signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true }));
      throw VaultError.reason('vault_unavailable');
    };
    const h = await setup({ handlers });
    const pending = h.send('vault.status');
    await started;
    await h.server.close();
    expect(aborted).toBe(true);
    expect((await pending).status).toBe(503);
  });
});

describe('authority, modes and output boundary', () => {
  it.each(VAULT_OPERATIONS.filter((row) => row.authority !== 'member'))('refuses an agent on $name before its handler', async (row) => {
    const h = await setup({ realCore: false });
    const response = await h.send(row.name, { caller: { ...testCaller, kind: 'agent', sessionId: randomUUID() } });
    expect(response.status).toBe(403);
  });
  it('requires an attested allowed origin for every human-only command, and never trusts a raw Origin header (F04)', async () => {
    const h = await setup({ realCore: false });
    const humanOnly = VAULT_OPERATIONS.filter((row) => 'humanOnly' in row && row.kind === 'command');
    expect(humanOnly.length).toBeGreaterThanOrEqual(20);
    const refusedForOrigin = (response: Awaited<ReturnType<Harness['send']>>) =>
      response.status === 403 && response.json?.error?.code === 'forbidden' && response.json.error.details === undefined;
    for (const row of humanOnly) {
      // No attested origin: a CLI, an agent, or a relay that lost it.
      expect(refusedForOrigin(await h.send(row.name, { origin: null })), row.name).toBe(true);
      // An attested origin the broker's WebAuthn origins do not include.
      expect(refusedForOrigin(await h.send(row.name, { origin: 'https://foreign.example.com' })), row.name).toBe(true);
      // Anything that reaches the socket can write Origin. The allowed value in that header never substitutes for the claim.
      expect(refusedForOrigin(await h.send(row.name, { origin: null, headers: { origin: ORIGIN } })), row.name).toBe(true);
      // The attested allowed origin passes, and a raw header that disagrees changes nothing.
      expect(refusedForOrigin(await h.send(row.name, { headers: { origin: 'https://foreign.example.com' } })), row.name).toBe(false);
      expect(refusedForOrigin(await h.send(row.name)), row.name).toBe(false);
      h.clock.advanceSeconds(60);
    }
  });
  it('requires a vault session, verifies step-up before the handler, and binds parsed body and lowercase path', async () => {
    const handlers = stubHandlers();
    let called = 0;
    const original = handlers['vault.items.delete'];
    handlers['vault.items.delete'] = async (ctx, req) => { called += 1; expect(ctx.stepUp !== null).toBe(true); return original(ctx, req); };
    const h = await setup({ handlers });
    expect((await h.send('vault.items.delete', { headers: { cookie: undefined } })).json.error.details.reason).toBe('vault_session_required');
    h.auth.mode = 'invalid';
    expect((await h.send('vault.items.delete')).json.error.details.reason).toBe('step_up_invalid');
    expect(called).toBe(0);
    h.auth.mode = 'ok';
    const input = { clientMutationId: 'test-only', expectedVersion: 1, stepUp: fakeStepUpProof() };
    expect((await h.send('vault.items.delete', { input })).status).toBe(200);
    expect(called).toBe(1);
    expect(h.auth.bindings.at(-1)!.action).toBe('vault.items.delete');
  });
  it('enforces off, admin-only pre_review, import disabled, and capacity before capture submit', async () => {
    const h = await setup({ realCore: false });
    h.config.mode = 'off';
    expect((await h.send('vault.status')).json.error.details.reason).toBe('vault_disabled');
    h.config.mode = 'pre_review';
    expect((await h.send('vault.status', { caller: { ...testCaller, isSpaceAdmin: false } })).json.error.details.reason).toBe('pre_review_limit');
    expect((await h.send('vault.imports.begin')).json.error.details.reason).toBe('import_disabled');
    h.config.preReview.maxItemsPerMember = 1;
    await seedItem(h.store);
    expect((await h.send('vault.captures.submit')).json.error.details.reason).toBe('pre_review_limit');
  });
  it('rate-limits by op class and includes an integer Retry-After', async () => {
    const h = await setup({ realCore: false });
    for (let n = 0; n < 10; n += 1) expect((await h.send('vault.webauthn.challenge')).status).toBe(200);
    const response = await h.send('vault.session.begin');
    expect(response.status).toBe(429);
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
    expect((await h.send('vault.status')).status).toBe(200);
  });
  it('rejects a schema-invalid result before emitting any of its fields', async () => {
    const handlers = stubHandlers();
    const marker = 'test-only-never-leave-plaintext';
    handlers['vault.status'] = async () => ({ data: { password: marker } as never });
    const h = await setup({ handlers });
    const response = await h.send('vault.status');
    expect(response.status).toBe(500);
    expect(response.text.includes(marker)).toBe(false);
  });
  it('scans a schema-valid metadata body and raises a canary alert', async () => {
    const handlers = stubHandlers();
    const original = handlers['vault.status'];
    const marker = ['test-only-canary', randomUUID()].join('-');
    handlers['vault.status'] = async (ctx, req) => { const result = await original(ctx, req); result.data.kms = { kind: marker, productionGrade: false }; return result; };
    const h = await setup({ handlers });
    h.components.canaries = buildCanarySet([marker]);
    const response = await h.send('vault.status');
    expect(response.status).toBe(500);
    expect(response.text.includes(marker)).toBe(false);
    expect((h.components.alerts as RecordingAlertSink).kinds()).toEqual(['canary_detected']);
  });
  it('fails closed when the scanner throws or matches the refusal itself', async () => {
    const h = await setup();
    h.components.canaries = { size: 1, matches: () => { throw new Error('test-only'); } };
    const response = await h.send('vault.status');
    expect(response.status).toBe(500);
    expect(response.text).toBe('');
  });
  it('emits only the fixed cookie attributes and also refuses a canary planted in a cookie header', async () => {
    const handlers = stubHandlers();
    const original = handlers['vault.status'];
    const marker = ['test-only-cookie', randomUUID()].join('-');
    handlers['vault.status'] = async (ctx, req) => ({ ...await original(ctx, req), setCookies: [
      { name: 'tm8_vault_session', value: marker, maxAgeSeconds: 900 },
      { name: 'tm8_vault_refresh', value: null, maxAgeSeconds: 0 },
    ] });
    const h = await setup({ handlers });
    const accepted = await h.send('vault.status');
    expect(accepted.status).toBe(200);
    expect(accepted.headers['set-cookie']).toEqual([
      `tm8_vault_session=${marker}; Max-Age=900; Path=/v2/vault; HttpOnly; Secure; SameSite=Strict`,
      'tm8_vault_refresh=; Max-Age=0; Path=/v2/vault/session; HttpOnly; Secure; SameSite=Strict',
    ]);
    h.components.canaries = buildCanarySet([marker]);
    const refused = await h.send('vault.status');
    expect(refused.status).toBe(500);
    expect(refused.headers['set-cookie']).toBeUndefined();
    expect(JSON.stringify(refused.headers).includes(marker)).toBe(false);
  });
  it.each([
    [new StoreNotFoundError(), 404, 'not_found', null], [new VaultError('not_found'), 404, 'not_found', null],
    [new StoreVersionConflictError(7), 409, 'version_conflict', null], [new AuditUnavailableError(), 503, 'upstream_unavailable', 'audit_unavailable'],
    [new StoreUnavailableError(), 503, 'upstream_unavailable', 'vault_unavailable'], [new KmsUnavailableError('test-only-never-echo'), 503, 'upstream_unavailable', 'kms_unavailable'],
    [new Error('test-only-never-echo'), 500, 'invariant_violation', null],
  ] as const)('maps error %# through the fixed envelope', async (error, status, code, reason) => {
    const handlers = stubHandlers();
    handlers['vault.status'] = async () => { throw error; };
    const h = await setup({ handlers });
    const response = await h.send('vault.status');
    expect(response.status).toBe(status);
    expect(response.json.error.code).toBe(code);
    expect(response.json.error.details?.reason ?? null).toBe(reason);
    expect(response.text.includes('test-only-never-echo')).toBe(false);
    if (error instanceof StoreVersionConflictError) expect(response.json.error.details.currentVersion).toBe(7);
    if (error instanceof AuditUnavailableError) expect(h.audit.appendFailures).toBe(1);
  });
  it('logs only the operation, status, elapsed time and verified request id', async () => {
    const logs: unknown[] = [];
    const h = await setup({ server: { log: (record) => logs.push(record) } });
    const response = await h.send('vault.status');
    expect(logs).toHaveLength(1);
    expect(Object.keys(logs[0] as object).sort()).toEqual(['ms', 'op', 'requestId', 'status']);
    expect((logs[0] as { requestId: string }).requestId).toBe(response.json.requestId);
  });
});

describe('startup', () => {
  it('runs config, KMS/store health, beforeServe and incremental verification before listening', async () => {
    const h = await setup();
    await h.server.close();
    const order: string[] = [];
    h.components.kms.health = async () => { order.push('kms'); return { ok: true }; };
    h.store.health = async () => { order.push('store'); return { ok: true }; };
    h.audit.verifyIncremental = async () => { order.push('audit'); return h.audit.verification; };
    const server = await startBroker({ ...h, config: undefined, env: {}, handlers: h.handlers,
      relayPublicKeyFile: h.publicKeyFile, beforeServe: [async () => { order.push('replay'); await expect(lstat(h.socketPath)).rejects.toMatchObject({ code: 'ENOENT' }); }] });
    expect(order).toEqual(['kms', 'store', 'replay', 'audit']);
    expect(server.http.listening).toBe(true);
    await server.close();
  });
  it('does not listen when health or audit verification fails and validates the injected production KMS first', async () => {
    const h = await setup();
    await h.server.close();
    const deps = { ...h, handlers: h.handlers, relayPublicKeyFile: h.publicKeyFile };
    h.config.mode = 'production';
    h.config.reviewGate = 'passed';
    await expect(startBroker(deps)).rejects.toThrow('TM8_VAULT_KMS_KIND');
    h.config.mode = 'dev';
    h.components.kms.health = async () => ({ ok: false });
    await expect(startBroker(deps)).rejects.toThrow('kms_unavailable');
    h.components.kms.health = async () => ({ ok: true });
    h.audit.verification.status = 'broken';
    await expect(startBroker(deps)).rejects.toThrow('audit_unavailable');
    await expect(lstat(h.socketPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
