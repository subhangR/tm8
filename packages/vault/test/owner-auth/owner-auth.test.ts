import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  VAULT_INPUT_SCHEMAS, VAULT_OUTPUT_SCHEMAS, VAULT_OPERATIONS, VAULT_REFRESH_FAMILY_TTL_SECONDS,
  VAULT_SESSION_TTL_SECONDS, VAULT_STEP_UP_CHALLENGE_TTL_SECONDS, vaultStepUpBoundParams,
  type VaultInput, type VaultStepUpProof,
} from '@tm8/contract';
import * as argon from 'hash-wasm';
import {
  AuditUnavailableError, OWNER_AUTH_OPS, VAULT_COOKIE_NAMES, VaultError,
  memberScope, type HandlerContext, type OwnerAuthOp, type StepUpBinding,
  type VaultCaller, type VaultCookies, type VaultHandler, type VaultPathParams, type VaultSetCookie,
} from '../../src/core-types.js';
import { MemoryVaultStore } from '../../src/store/memory.js';
import { stepUpIntentHash } from '../../src/intent/step-up.js';
import { createOwnerAuth, createOwnerAuthHandlers, mintEnrollmentCode, runEnrollmentCli } from '../../src/owner-auth/index.js';
import { findCode, newCodeBatch } from '../../src/owner-auth/codes.js';
import { sha256 } from '../../src/owner-auth/primitives.js';
import { FixedClock, FakeAuditGate, RecordingAlertSink, testConfig, testComponents, testCaller, otherCaller, SPACE_A, OWNER_ID } from '../support/kit.js';
import { SoftwareAuthenticator, type CeremonyOptions } from './authenticator.js';
import { RecordingStore } from './recording-store.js';

vi.mock('hash-wasm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('hash-wasm')>();
  return { ...actual, argon2Verify: vi.fn(actual.argon2Verify) };
});

type WithOptionalMutation<T> = T extends unknown ? Omit<T, 'clientMutationId'> & { clientMutationId?: string } : never;

describe('registration and out-of-band codes', () => {
  it('consumes enrollment only at finish, rejects reuse and refuses enrollment after the first passkey', async () => {
    const h = harness();
    const code = await mintEnrollmentCode(h.store, { memberId: OWNER_ID, spaceId: SPACE_A, ttlSeconds: 600 });
    const first = await h.beginRegistration({ enrollmentCode: code });
    const second = await h.beginRegistration({ enrollmentCode: code });
    const before = await h.store.transaction(memberScope(testCaller), (tx) => tx.enrollmentCodes.listUsable());
    expect(before).toHaveLength(1);
    const device = new SoftwareAuthenticator();
    await h.call('vault.passkeys.registerFinish', { credential: device.register(first.publicKey.challenge) }, { registrationId: first.registrationId });
    const next = new SoftwareAuthenticator();
    await expect(h.call('vault.passkeys.registerFinish', { credential: next.register(second.publicKey.challenge) }, { registrationId: second.registrationId })).rejects.toMatchObject({ reason: 'code_invalid' });
    await expect(h.beginRegistration({ enrollmentCode: code })).rejects.toMatchObject({ reason: 'code_invalid' });
    const fresh = await mintEnrollmentCode(h.store, { memberId: OWNER_ID, spaceId: SPACE_A, ttlSeconds: 600 });
    await expect(h.beginRegistration({ enrollmentCode: fresh })).rejects.toMatchObject({ reason: 'code_invalid' });
  });

  it('checks enrollment expiry both at begin and after an abandoned begin', async () => {
    const h = harness();
    const code = await mintEnrollmentCode(h.store, { memberId: OWNER_ID, spaceId: SPACE_A, ttlSeconds: 30 });
    const registration = await h.beginRegistration({ enrollmentCode: code });
    h.clock.advanceSeconds(30);
    await expect(h.beginRegistration({ enrollmentCode: code })).rejects.toMatchObject({ reason: 'code_invalid' });
    await expect(h.call('vault.passkeys.registerFinish', { credential: new SoftwareAuthenticator().register(registration.publicKey.challenge) }, { registrationId: registration.registrationId })).rejects.toMatchObject({ reason: 'code_invalid' });
    expect((await h.auth.viewer(testCaller, h.cookies)).passkeys).toBe(0);
  });

  it.each([
    ['wrong origin', { origin: 'https://wrong.example.test' }],
    ['wrong RP ID', { rpId: 'wrong.example.test' }],
    ['missing UV', { uv: false }],
    ['missing UP', { up: false }],
    ['cross origin', { crossOrigin: true }],
  ] as const)('rejects registration with %s, burns its challenge, and preserves its enrollment code', async (_label, options) => {
    const h = harness();
    const code = await mintEnrollmentCode(h.store, { memberId: OWNER_ID, spaceId: SPACE_A, ttlSeconds: 600 });
    const registration = await h.beginRegistration({ enrollmentCode: code });
    const device = new SoftwareAuthenticator();
    await expect(h.call('vault.passkeys.registerFinish', { credential: device.register(registration.publicKey.challenge, options) }, { registrationId: registration.registrationId })).rejects.toMatchObject({ reason: 'step_up_invalid' });
    await expect(h.call('vault.passkeys.registerFinish', { credential: device.register(registration.publicKey.challenge) }, { registrationId: registration.registrationId })).rejects.toMatchObject({ reason: 'step_up_invalid' });
    expect((await h.beginRegistration({ enrollmentCode: code })).registrationId).not.toBe(registration.registrationId);
  });

  it('rejects expired registration challenges uniformly', async () => {
    const h = harness();
    const code = await mintEnrollmentCode(h.store, { memberId: OWNER_ID, spaceId: SPACE_A, ttlSeconds: 600 });
    const registration = await h.beginRegistration({ enrollmentCode: code });
    h.clock.advanceSeconds(VAULT_STEP_UP_CHALLENGE_TTL_SECONDS);
    await expect(h.call('vault.passkeys.registerFinish', { credential: new SoftwareAuthenticator().register(registration.publicKey.challenge) }, { registrationId: registration.registrationId })).rejects.toMatchObject({ reason: 'step_up_invalid' });
  });

  it('recovery consumes once at finish, ends every session, and preserves existing passkeys', async () => {
    const h = harness();
    const { device, key } = await h.enroll();
    const first = await h.signIn(device);
    const codes = await recoveryCodes(h, device);
    const second = await h.signIn(device);
    const before = await h.beginRegistration({ recoveryCode: codes[0]! });
    const abandoned = await h.beginRegistration({ recoveryCode: codes[0]! });
    expect(await h.auth.resolveSession(testCaller, h.cookies)).not.toBeNull();
    expect(h.alerts.kinds()).not.toContain('recovery_code_used');
    const recovering = new SoftwareAuthenticator();
    await h.call('vault.passkeys.registerFinish', { credential: recovering.register(before.publicKey.challenge) }, { registrationId: before.registrationId });
    expect(await h.auth.resolveSession(testCaller, h.cookies)).toBeNull();
    expect(h.alerts.kinds()).toContain('recovery_code_used');
    for (const id of [first.data.id, second.data.id]) {
      const row = await h.store.transaction(memberScope(testCaller), (tx) => tx.sessions.get(id));
      expect(row?.revokedReason).toBe('recovery');
    }
    const oldKey = await h.store.transaction(memberScope(testCaller), (tx) => tx.passkeys.get(key.id));
    expect(oldKey?.revokedAt).toBeNull();
    expect((await h.auth.viewer(testCaller, h.cookies)).passkeys).toBe(2);
    await expect(h.beginRegistration({ recoveryCode: codes[0]! })).rejects.toMatchObject({ reason: 'code_invalid' });
    await expect(h.call('vault.passkeys.registerFinish', { credential: new SoftwareAuthenticator().register(abandoned.publicKey.challenge) }, { registrationId: abandoned.registrationId })).rejects.toMatchObject({ reason: 'code_invalid' });
    await h.signIn(device);
    expect((await h.auth.viewer(testCaller, h.cookies)).recoveryCodesRemaining).toBe(9);
    const persisted = JSON.stringify({ rows: h.store.calls, alerts: h.alerts.alerts, errors: h.errors });
    for (const value of h.raw) expect(persisted.includes(value)).toBe(false);
  }, 30_000);

  it('regenerating codes invalidates every unused code and every pending registration that used one', async () => {
    const h = harness();
    const { device } = await h.enroll();
    await h.signIn(device);
    const codes = await recoveryCodes(h, device);
    const registration = await h.beginRegistration({ recoveryCode: codes[0]! });
    const fresh = await recoveryCodes(h, device);
    expect(new Set([...codes, ...fresh]).size).toBe(20);
    await expect(h.beginRegistration({ recoveryCode: codes[1]! })).rejects.toMatchObject({ reason: 'code_invalid' });
    await expect(h.call('vault.passkeys.registerFinish', { credential: new SoftwareAuthenticator().register(registration.publicKey.challenge) }, { registrationId: registration.registrationId })).rejects.toMatchObject({ reason: 'code_invalid' });
    expect((await h.auth.viewer(testCaller, h.cookies)).recoveryCodesRemaining).toBe(10);
  }, 30_000);

  it('recovery codes retain their lifetime after years without use', async () => {
    const h = harness();
    const { device } = await h.enroll();
    await h.signIn(device);
    const codes = await recoveryCodes(h, device);
    h.clock.advanceSeconds(2 * 365 * 24 * 3600);
    const registration = await h.beginRegistration({ recoveryCode: codes[0]! });
    await h.call('vault.passkeys.registerFinish', { credential: new SoftwareAuthenticator().register(registration.publicKey.challenge) }, { registrationId: registration.registrationId });
    expect((await h.auth.viewer(testCaller, h.cookies)).passkeys).toBe(2);
  }, 30_000);

  it('hashes once for matching, absent, malformed, used and expired prefixes with uniform code_invalid', async () => {
    const h = harness();
    const code = await mintEnrollmentCode(h.store, { memberId: OWNER_ID, spaceId: SPACE_A, ttlSeconds: 30 });
    const verify = vi.mocked(argon.argon2Verify);
    for (const candidate of [code, `${'f'.repeat(12)}.${'a'.repeat(27)}`, 'invalid-code']) {
      const count = verify.mock.calls.length;
      if (candidate === code) await h.beginRegistration({ enrollmentCode: candidate });
      else await expect(h.beginRegistration({ enrollmentCode: candidate })).rejects.toMatchObject({ reason: 'code_invalid' });
      expect(verify.mock.calls.length - count).toBe(1);
    }
    h.clock.advanceSeconds(30);
    const count = verify.mock.calls.length;
    await expect(h.beginRegistration({ enrollmentCode: code })).rejects.toMatchObject({ reason: 'code_invalid' });
    expect(verify.mock.calls.length - count).toBe(1);
    const records = await newCodeBatch(2);
    const invalidHash = { ...records[0]!, hash: records[0]!.hash.replace('m=65536', 'm=8'), memberId: OWNER_ID, createdAt: h.clock.iso(), usedAt: null };
    expect(await findCode([invalidHash], records[0]!.code)).toBeNull();
    expect(records.every((row) => row.hash.includes('$m=65536,t=3,p=1$'))).toBe(true);
    expect(new Set(records.map((row) => row.code.split('.')[0])).size).toBe(2);
    expect(records.every((row) => Buffer.from(row.code.split('.')[1]!, 'base64url').length >= 10)).toBe(true);
  }, 30_000);

  it('requires exactly one authorization, a live owner session and a correctly bound step-up', async () => {
    const h = harness();
    const { device } = await h.enroll();
    await h.signIn(device);
    const proof = await h.proof(device, { action: 'vault.passkeys.registerBegin', pathParams: {}, body: { name: 'Different device' } });
    await expect(h.beginRegistration({ stepUp: proof })).rejects.toMatchObject({ reason: 'step_up_invalid' });
    await expect(h.call('vault.passkeys.registerBegin', { name: 'Test device' })).rejects.toBeDefined();
    await expect(h.call('vault.passkeys.registerBegin', { name: 'Test device', enrollmentCode: 'invalid-code', recoveryCode: 'invalid-code' })).rejects.toBeDefined();
    await expect(h.call('vault.passkeys.registerBegin', { name: 'Test device', stepUp: proof }, {}, testCaller, { session: null, refresh: null })).rejects.toMatchObject({ reason: 'vault_session_required' });
  });

  it.each(['different session', 'revoked session', 'expired session', 'revoked passkey'] as const)(
    'refuses an added passkey after %s and consumes its registration challenge', async (change) => {
      const h = harness();
      const { device, key } = await h.enroll();
      const signed = await h.signIn(device);
      const proof = await h.proof(device, { action: 'vault.passkeys.registerBegin', pathParams: {}, body: { name: 'Test device' } });
      const registration = await h.beginRegistration({ stepUp: proof });
      const originalJar = { ...h.cookies };
      if (change === 'different session') await h.signIn(device);
      else if (change === 'revoked session') await h.call('vault.sessions.revoke', {}, { sessionId: signed.data.id });
      else if (change === 'expired session') h.clock.advanceSeconds(VAULT_SESSION_TTL_SECONDS);
      else await h.call('vault.passkeys.revoke', { confirmLast: true }, { passkeyId: key.id });
      const adding = new SoftwareAuthenticator();
      await expect(h.call('vault.passkeys.registerFinish', { credential: adding.register(registration.publicKey.challenge) }, { registrationId: registration.registrationId })).rejects.toMatchObject({ reason: 'step_up_invalid' });
      await expect(h.call('vault.passkeys.registerFinish', { credential: adding.register(registration.publicKey.challenge) }, { registrationId: registration.registrationId }, testCaller, originalJar)).rejects.toMatchObject({ reason: 'step_up_invalid' });
      const rows = await h.store.transaction(memberScope(testCaller), (tx) => tx.passkeys.listForMember());
      expect(rows).toHaveLength(1);
    },
  );

  it('CLI injects the store and writes exactly one line once', async () => {
    const h = harness();
    const writes: string[] = [];
    const output = { write: (chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; } } as Pick<NodeJS.WriteStream, 'write'>;
    await runEnrollmentCli(h.store, [OWNER_ID, SPACE_A, '60'], output);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(/^[a-f0-9]{12}\.[A-Za-z0-9_-]{27}\n$/);
    expect(JSON.stringify(h.store.calls)).not.toContain(writes[0]!.trim());
    await expect(runEnrollmentCli(h.store, [OWNER_ID, SPACE_A, '0'], output)).rejects.toMatchObject({ code: 'invalid_input' });
    expect(writes).toHaveLength(1);
  });

  it('audit outages roll back code consumption and passkey insertion, without restoring a consumed ceremony', async () => {
    const h = harness();
    const code = await mintEnrollmentCode(h.store, { memberId: OWNER_ID, spaceId: SPACE_A, ttlSeconds: 600 });
    const registration = await h.beginRegistration({ enrollmentCode: code });
    const device = new SoftwareAuthenticator();
    h.store.beforeCall = (repo, method) => { if (repo === 'passkeys' && method === 'create') h.memory.faults.auditAppend = true; };
    await expect(h.call('vault.passkeys.registerFinish', { credential: device.register(registration.publicKey.challenge) }, { registrationId: registration.registrationId })).rejects.toBeInstanceOf(AuditUnavailableError);
    h.memory.faults.auditAppend = false;
    h.store.beforeCall = undefined;
    const rows = await h.store.transaction(memberScope(testCaller), (tx) => tx.enrollmentCodes.listUsable());
    expect(rows).toHaveLength(1);
    expect((await h.auth.viewer(testCaller, h.cookies)).passkeys).toBe(0);
    await expect(h.call('vault.passkeys.registerFinish', { credential: device.register(registration.publicKey.challenge) }, { registrationId: registration.registrationId })).rejects.toMatchObject({ reason: 'step_up_invalid' });
  });
});

function harness() {
  const clock = new FixedClock();
  const memory = new MemoryVaultStore({ clock });
  const store = new RecordingStore(memory);
  const config = testConfig();
  const auth = createOwnerAuth({ store, config, clock });
  const handlers = createOwnerAuthHandlers();
  const alerts = new RecordingAlertSink();
  const components = testComponents({ alerts });
  const cookies: VaultCookies = { session: null, refresh: null };
  const raw: string[] = [];
  const errors: string[] = [];
  const covered = new Set<string>();

  async function call<Op extends OwnerAuthOp>(op: Op, input: WithOptionalMutation<VaultInput<Op>>, params: VaultPathParams<Op> = {} as VaultPathParams<Op>,
    caller: VaultCaller = testCaller, jar: VaultCookies = cookies) {
    const command = VAULT_OPERATIONS.find((row) => row.name === op)!.kind === 'command';
    const parsed = VAULT_INPUT_SCHEMAS[op].parse(command ? { clientMutationId: randomUUID(), ...input } : input) as VaultInput<Op>;
    const ownerSession = await auth.resolveSession(caller, jar);
    const ctx: HandlerContext = { op, caller, actor: { kind: caller.kind, memberId: caller.memberId, name: caller.name, sessionId: caller.sessionId },
      requestId: randomUUID(), clock, store, config, auth, components, audit: new FakeAuditGate(),
      ownerSession, stepUp: null, cookies: jar, signal: new AbortController().signal };
    if (op === 'vault.recovery.codes.create') {
      if (!ownerSession) throw VaultError.reason('vault_session_required');
      const proof = (parsed as VaultInput<'vault.recovery.codes.create'>).stepUp;
      (ctx as { stepUp: HandlerContext['stepUp'] }).stepUp = await auth.verifyStepUp(caller, ownerSession, proof,
        { action: 'vault.recovery.codes.create', pathParams: params, body: parsed as Record<string, unknown> });
    }
    try {
      const result = await (handlers[op] as VaultHandler<Op>)(ctx, { params, input: parsed });
      VAULT_OUTPUT_SCHEMAS[op].parse(result.data);
      covered.add(op);
      return result;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'unknown error');
      throw error;
    }
  }

  function applyCookies(values: VaultSetCookie[] | undefined) {
    for (const cookie of values ?? []) {
      if (cookie.value) raw.push(cookie.value);
      if (cookie.name === VAULT_COOKIE_NAMES.session) cookies.session = cookie.value;
      else cookies.refresh = cookie.value;
    }
  }

  async function beginRegistration(authorization: { enrollmentCode?: string; recoveryCode?: string; stepUp?: VaultStepUpProof }) {
    const result = await call('vault.passkeys.registerBegin', { name: 'Test device', ...authorization });
    raw.push(result.data.publicKey.challenge);
    return result.data;
  }

  async function enroll(device = new SoftwareAuthenticator()) {
    const code = await mintEnrollmentCode(store, { memberId: OWNER_ID, spaceId: SPACE_A, ttlSeconds: 600 });
    raw.push(code);
    const registration = await beginRegistration({ enrollmentCode: code });
    const key = await call('vault.passkeys.registerFinish', { credential: device.register(registration.publicKey.challenge) }, { registrationId: registration.registrationId });
    return { device, key: key.data, code };
  }

  async function challenge(binding?: StepUpBinding) {
    const result = await call('vault.webauthn.challenge', binding ? { purpose: 'step_up', ...binding } : { purpose: 'sign_in' });
    raw.push(result.data.publicKey.challenge);
    return result.data;
  }

  async function signIn(device: SoftwareAuthenticator) {
    const ch = await challenge();
    const result = await call('vault.session.begin', { challengeId: ch.challengeId, assertion: device.assert(ch.publicKey.challenge), deviceLabel: 'Test device' });
    applyCookies(result.setCookies);
    return result;
  }

  async function proof(device: SoftwareAuthenticator, binding: StepUpBinding): Promise<VaultStepUpProof> {
    const ch = await challenge(binding);
    return { challengeId: ch.challengeId, assertion: device.assert(ch.publicKey.challenge) };
  }

  return { clock, memory, store, auth, handlers, alerts, cookies, raw, errors, covered,
    call, applyCookies, beginRegistration, enroll, signIn, challenge, proof };
}

type Harness = ReturnType<typeof harness>;
const recoveryBinding: StepUpBinding = { action: 'vault.recovery.codes.create', pathParams: {}, body: {} };

async function recoveryCodes(h: Harness, device: SoftwareAuthenticator) {
  const result = await h.call('vault.recovery.codes.create', { stepUp: await h.proof(device, recoveryBinding) });
  h.raw.push(...result.data.codes);
  return result.data.codes;
}

describe('owner authentication', () => {
  it('covers all 11 operations with real ES256 signatures and scans every repository call', async () => {
    const h = harness();
    const { device, key } = await h.enroll();
    const signedIn = await h.signIn(device);
    expect(Buffer.from(h.cookies.session!, 'base64url')).toHaveLength(32);
    expect(Buffer.from(h.cookies.refresh!, 'base64url')).toHaveLength(32);
    expect(JSON.stringify(signedIn.data)).not.toContain(h.cookies.session);
    expect(signedIn.setCookies?.map((cookie) => cookie.maxAgeSeconds)).toEqual([VAULT_SESSION_TTL_SECONDS, VAULT_REFRESH_FAMILY_TTL_SECONDS]);
    expect((await h.call('vault.passkeys.list', {})).data.passkeys).toHaveLength(1);
    expect((await h.call('vault.sessions.list', {})).data.sessions[0]?.current).toBe(true);
    const refreshed = await h.call('vault.session.refresh', {});
    h.applyCookies(refreshed.setCookies);
    expect((await h.auth.viewer(testCaller, h.cookies)).session?.sessionId).toBe(signedIn.data.id);
    const codes = await recoveryCodes(h, device);
    expect(codes).toHaveLength(10);
    expect((await h.auth.viewer(testCaller, h.cookies)).recoveryCodesRemaining).toBe(10);
    const adding = { name: 'Test device' };
    const registration = await h.beginRegistration({ stepUp: await h.proof(device, { action: 'vault.passkeys.registerBegin', pathParams: {}, body: adding }) });
    const second = new SoftwareAuthenticator();
    const secondKey = await h.call('vault.passkeys.registerFinish', { credential: second.register(registration.publicKey.challenge) }, { registrationId: registration.registrationId });
    const signedInAgain = await h.signIn(second);
    await h.call('vault.sessions.revoke', {}, { sessionId: signedIn.data.id });
    await h.call('vault.passkeys.revoke', {}, { passkeyId: key.id });
    await h.call('vault.session.end', {});
    expect(await h.auth.resolveSession(testCaller, h.cookies)).toBeNull();
    expect(signedInAgain.data.passkeyId).toBe(secondKey.data.id);
    expect([...h.covered].sort()).toEqual([...OWNER_AUTH_OPS].sort());
    expect(h.alerts.kinds()).toContain('passkey_new_device');
    const snapshot = h.memory.testing.snapshot();
    expect(snapshot).toBeDefined();
    // RecordingStore captures the full write surface, including data rolled back before a snapshot.
    const persisted = JSON.stringify({ rows: h.store.calls, alerts: h.alerts.alerts, errors: h.errors });
    for (const value of h.raw) expect(persisted.includes(value)).toBe(false);
    expect(persisted).not.toContain(testCaller.name);
  }, 30_000);

  it.each([
    ['wrong origin', { origin: 'https://wrong.example.test' }],
    ['wrong RP ID', { rpId: 'wrong.example.test' }],
    ['UV absent', { uv: false }],
    ['UP absent', { up: false }],
    ['cross origin', { crossOrigin: true }],
  ] as const)('uniformly rejects sign-in with %s and burns the challenge', async (_label, options) => {
    const h = harness();
    const { device } = await h.enroll();
    const ch = await h.challenge();
    const assertion = device.assert(ch.publicKey.challenge, options);
    await expect(h.call('vault.session.begin', { challengeId: ch.challengeId, assertion })).rejects.toMatchObject({ reason: 'step_up_invalid' });
    await expect(h.call('vault.session.begin', { challengeId: ch.challengeId, assertion: device.assert(ch.publicKey.challenge) })).rejects.toMatchObject({ reason: 'step_up_invalid' });
    const events = await h.store.transaction(memberScope(testCaller), (tx) => tx.audit.list({ action: 'step_up.failed' }));
    expect(events.rows).toHaveLength(2);
    expect(events.rows.every((event) => event.params.code === 'assertion_invalid')).toBe(true);
  });

  it('uniformly rejects unknown credentials, bad signatures, replay and expired challenges', async () => {
    const h = harness();
    const { device } = await h.enroll();
    let ch = await h.challenge();
    await expect(h.call('vault.session.begin', { challengeId: ch.challengeId, assertion: new SoftwareAuthenticator().assert(ch.publicKey.challenge) })).rejects.toMatchObject({ reason: 'step_up_invalid' });
    ch = await h.challenge();
    const invalid = device.assert(ch.publicKey.challenge);
    invalid.response.signature = Buffer.alloc(70).toString('base64url');
    await expect(h.call('vault.session.begin', { challengeId: ch.challengeId, assertion: invalid })).rejects.toMatchObject({ reason: 'step_up_invalid' });
    ch = await h.challenge();
    const assertion = device.assert(ch.publicKey.challenge);
    await h.call('vault.session.begin', { challengeId: ch.challengeId, assertion });
    await expect(h.call('vault.session.begin', { challengeId: ch.challengeId, assertion })).rejects.toMatchObject({ reason: 'step_up_invalid' });
    ch = await h.challenge();
    h.clock.advanceSeconds(VAULT_STEP_UP_CHALLENGE_TTL_SECONDS);
    await expect(h.call('vault.session.begin', { challengeId: ch.challengeId, assertion: device.assert(ch.publicKey.challenge) })).rejects.toMatchObject({ reason: 'step_up_invalid' });
  });

  it('applies counter rules after verifying signatures, and audits regressions', async () => {
    const h = harness();
    const { device } = await h.enroll();
    await h.signIn(device);
    const ch = await h.challenge();
    await expect(h.call('vault.session.begin', { challengeId: ch.challengeId, assertion: device.assert(ch.publicKey.challenge, { counter: 0 }) })).rejects.toMatchObject({ reason: 'step_up_invalid' });
    const events = await h.store.transaction(memberScope(testCaller), (tx) => tx.audit.list({ action: 'step_up.failed' }));
    expect(events.rows[0]?.params.code).toBe('counter_regression');
  });

  it('allows authenticators that consistently report a zero counter', async () => {
    const h = harness();
    const { device } = await h.enroll();
    for (let i = 0; i < 2; i += 1) {
      const ch = await h.challenge();
      const result = await h.call('vault.session.begin', { challengeId: ch.challengeId, assertion: device.assert(ch.publicKey.challenge, { counter: 0 }) });
      expect(result.data.passkeyId).toBeDefined();
    }
  });

  it('requires passkeys, and distinguishes missing proof from every invalid proof', async () => {
    const h = harness();
    await expect(h.challenge()).rejects.toMatchObject({ reason: 'passkey_required' });
    const { device } = await h.enroll();
    await h.signIn(device);
    const session = (await h.auth.resolveSession(testCaller, h.cookies))!;
    await expect(h.auth.verifyStepUp(testCaller, session, undefined, recoveryBinding)).rejects.toMatchObject({ reason: 'step_up_required' });
    expect((await h.auth.viewer(otherCaller, h.cookies)).recoveryCodesRemaining).toBeNull();
  });

  it('binds the action, path and actual body, embeds the hash, and ignores only transport fields', async () => {
    const h = harness();
    const { device } = await h.enroll();
    await h.signIn(device);
    const session = (await h.auth.resolveSession(testCaller, h.cookies))!;
    const binding: StepUpBinding = { action: 'vault.items.setProperties', pathParams: { itemId: randomUUID() }, body: { devMode: true, expectedVersion: 1 } };
    const ch = await h.challenge(binding);
    const hash = stepUpIntentHash(binding.action, vaultStepUpBoundParams(binding.pathParams, binding.body));
    expect(Buffer.from(ch.publicKey.challenge, 'base64url').subarray(32).toString('hex')).toBe(hash);
    const proof = { challengeId: ch.challengeId, assertion: device.assert(ch.publicKey.challenge) };
    const verified = await h.auth.verifyStepUp(testCaller, session, proof, { ...binding, body: { ...binding.body, clientMutationId: randomUUID(), stepUp: proof } });
    expect(verified.intentHash).toBe(hash);
    await expect(h.auth.verifyStepUp(testCaller, session, proof, binding)).rejects.toMatchObject({ reason: 'step_up_invalid' });
    for (const changed of [
      { ...binding, body: { ...binding.body, devMode: false } },
      { ...binding, pathParams: { itemId: randomUUID() } },
      { ...binding, action: 'vault.items.delete' as const },
    ]) {
      const fresh = await h.proof(device, binding);
      await expect(h.auth.verifyStepUp(testCaller, session, fresh, changed)).rejects.toMatchObject({ reason: 'step_up_invalid' });
    }
    const record = h.store.calls.find((call) => call.repo === 'challenges' && call.method === 'create' && (call.args[0] as { purpose: string }).purpose === 'step_up');
    expect(record?.args[0]).toMatchObject({ challenge: sha256(ch.publicKey.challenge), intentHash: hash });
    expect(JSON.stringify(record)).not.toContain('devMode');
  });

  it('commits step-up outcomes even if the subsequent action rolls back', async () => {
    const h = harness();
    const { device } = await h.enroll();
    await h.signIn(device);
    const session = (await h.auth.resolveSession(testCaller, h.cookies))!;
    const proof = await h.proof(device, recoveryBinding);
    await h.auth.verifyStepUp(testCaller, session, proof, recoveryBinding);
    await expect(h.store.transaction(memberScope(testCaller), async () => { throw new VaultError('conflict'); })).rejects.toMatchObject({ code: 'conflict' });
    await expect(h.auth.verifyStepUp(testCaller, session, proof, recoveryBinding)).rejects.toMatchObject({ reason: 'step_up_invalid' });
    const events = await h.store.transaction(memberScope(testCaller), (tx) => tx.audit.list({ action: 'step_up.verified' }));
    expect(events.rows.some((event) => event.params.purpose === 'step_up')).toBe(true);
  });

  it('expires step-up challenges, and exactly one concurrent use can verify', async () => {
    const h = harness();
    const { device } = await h.enroll();
    await h.signIn(device);
    const session = (await h.auth.resolveSession(testCaller, h.cookies))!;
    const expired = await h.proof(device, recoveryBinding);
    h.clock.advanceSeconds(VAULT_STEP_UP_CHALLENGE_TTL_SECONDS);
    await expect(h.auth.verifyStepUp(testCaller, session, expired, recoveryBinding)).rejects.toMatchObject({ reason: 'step_up_invalid' });
    const proof = await h.proof(device, recoveryBinding);
    const results = await Promise.allSettled([
      h.auth.verifyStepUp(testCaller, session, proof, recoveryBinding),
      h.auth.verifyStepUp(testCaller, session, proof, recoveryBinding),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('rotates every refresh, detects reuse and commits family revocation before returning an error', async () => {
    const h = harness();
    const { device } = await h.enroll();
    const first = await h.signIn(device);
    const stale = { ...h.cookies };
    h.clock.advanceSeconds(1);
    const rotated = await h.call('vault.session.refresh', {});
    h.applyCookies(rotated.setCookies);
    expect(h.cookies.session).not.toBe(stale.session);
    expect(h.cookies.refresh).not.toBe(stale.refresh);
    expect(await h.auth.resolveSession(testCaller, stale)).toBeNull();
    await expect(h.call('vault.session.refresh', {}, {}, testCaller, stale)).rejects.toMatchObject({ reason: 'vault_session_required' });
    expect(await h.auth.resolveSession(testCaller, h.cookies)).toBeNull();
    const row = await h.store.transaction(memberScope(testCaller), (tx) => tx.sessions.get(first.data.id));
    expect(row?.revokedReason).toBe('refresh_reuse');
    expect(h.alerts.kinds()).toContain('refresh_reuse_detected');
  });

  it('enforces access TTL and absolute refresh family TTL', async () => {
    const h = harness();
    const { device } = await h.enroll();
    const first = await h.signIn(device);
    h.clock.advanceSeconds(VAULT_SESSION_TTL_SECONDS);
    expect(await h.auth.resolveSession(testCaller, h.cookies)).toBeNull();
    const rotated = await h.call('vault.session.refresh', {});
    h.applyCookies(rotated.setCookies);
    expect(rotated.data.refreshExpiresAt).toBe(first.data.refreshExpiresAt);
    h.clock.advanceSeconds(VAULT_REFRESH_FAMILY_TTL_SECONDS - VAULT_SESSION_TTL_SECONDS);
    await expect(h.call('vault.session.refresh', {})).rejects.toMatchObject({ reason: 'vault_session_required' });
  });

  it('ends the refresh family when the browser has already discarded its expired access cookie', async () => {
    const h = harness();
    const { device } = await h.enroll();
    const signed = await h.signIn(device);
    h.clock.advanceSeconds(VAULT_SESSION_TTL_SECONDS);
    h.cookies.session = null;
    const result = await h.call('vault.session.end', {});
    expect(result.data.ended).toBe(true);
    expect(result.setCookies?.every((cookie) => cookie.value === null)).toBe(true);
    await expect(h.call('vault.session.refresh', {})).rejects.toMatchObject({ reason: 'vault_session_required' });
    const row = await h.store.transaction(memberScope(testCaller), (tx) => tx.sessions.get(signed.data.id));
    expect(row?.revokedReason).toBe('ended');
  });

  it('rejects another member cookie and cross-member passkey/session IDs without disclosing rows', async () => {
    const h = harness();
    const { device, key } = await h.enroll();
    const signed = await h.signIn(device);
    expect(await h.auth.resolveSession(otherCaller, h.cookies)).toBeNull();
    await expect(h.call('vault.session.refresh', {}, {}, otherCaller)).rejects.toMatchObject({ reason: 'vault_session_required' });
    const otherKey = await h.store.transaction(memberScope(otherCaller), (tx) => tx.passkeys.create({
      id: randomUUID(), credentialId: 'dGVzdC1vdGhlcg', publicKey: 'dGVzdC1wdWJsaWM', counter: 0, transports: [],
      backedUp: false, deviceType: 'singleDevice', aaguid: null, name: 'Other test device',
    }));
    await expect(h.call('vault.passkeys.revoke', {}, { passkeyId: otherKey.id })).rejects.toMatchObject({ code: 'not_found' });
    const inaccessible = await h.store.transaction(memberScope(otherCaller), (tx) => tx.sessions.get(signed.data.id));
    expect(inaccessible).toBeNull();
    expect(key.id).not.toBe(otherKey.id);
  });

  it('guards the last passkey, and revocation kills access and refresh tokens', async () => {
    const h = harness();
    const { device, key } = await h.enroll();
    await h.signIn(device);
    await expect(h.call('vault.passkeys.revoke', {}, { passkeyId: key.id })).rejects.toMatchObject({ reason: 'last_passkey' });
    const result = await h.call('vault.passkeys.revoke', { confirmLast: true }, { passkeyId: key.id });
    expect(result.setCookies?.every((cookie) => cookie.value === null && cookie.maxAgeSeconds === 0)).toBe(true);
    expect(await h.auth.resolveSession(testCaller, h.cookies)).toBeNull();
    await expect(h.call('vault.session.refresh', {})).rejects.toMatchObject({ reason: 'vault_session_required' });
    await expect(h.challenge()).rejects.toMatchObject({ reason: 'passkey_required' });
  });
});
