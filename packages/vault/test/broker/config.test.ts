import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VAULT_OPERATIONS, VAULT_OUTPUT_SCHEMAS } from '@tm8/contract';
import { BROKER_ENV_KNOBS, BrokerConfigError, assertBrokerConfig, loadBrokerConfig } from '../../src/broker/config.js';
import { BrokerRateLimiter, BROKER_RATE_LIMITS, BROKER_SHARED_LIMITS, kdfCost, rateClass } from '../../src/broker/rate-limit.js';
import { parseVaultCookies, serializeVaultCookie } from '../../src/broker/dispatcher.js';
import { RECOVERY_CODE_COUNT } from '../../src/owner-auth/codes.js';
import { FixedClock, agentOf, makeCaller, testCaller } from '../support/kit.js';
import { sourceFiles } from '../support/sql-sweep.js';

describe('broker config and closed runtime settings', () => {
  it('defaults to off and spend stays false in every admitted mode', () => {
    expect(loadBrokerConfig({}).mode).toBe('off');
    for (const mode of ['off', 'dev', 'pre_review']) expect(loadBrokerConfig({ TM8_VAULT_MODE: mode }).features.spend).toBe(false);
    expect(loadBrokerConfig({ TM8_VAULT_MODE: 'pre_review' }).features.import).toBe(false);
  });
  it('admits production only after both gates with a real production-grade adapter', () => {
    const env = { TM8_VAULT_MODE: 'production', TM8_VAULT_REVIEW_GATE: 'passed', TM8_VAULT_PUBLIC_ORIGIN: 'https://vault.example.com',
      TM8_VAULT_AUDIT_SINK: 'gcs' };
    expect(() => loadBrokerConfig({ ...env, TM8_VAULT_REVIEW_GATE: 'open' }, { kind: 'gcp-kms', productionGrade: true })).toThrow('TM8_VAULT_REVIEW_GATE');
    expect(() => loadBrokerConfig(env)).toThrow('TM8_VAULT_KMS_KIND');
    expect(() => loadBrokerConfig(env, { kind: 'local-dev', productionGrade: false })).toThrow('TM8_VAULT_KMS_KIND');
    expect(() => loadBrokerConfig(env, { kind: 'local-dev', productionGrade: true })).toThrow('TM8_VAULT_KMS_KIND');
    expect(() => loadBrokerConfig(env, { kind: 'gcp-kms', productionGrade: false })).toThrow('TM8_VAULT_KMS_KIND');
    expect(loadBrokerConfig(env, { kind: 'gcp-kms', productionGrade: true }).mode).toBe('production');
  });
  it('review F01: admits production only with the off-host gcs checkpoint sink, for a loaded or an injected config', () => {
    const kms = { kind: 'gcp-kms' as const, productionGrade: true };
    const env = { TM8_VAULT_MODE: 'production', TM8_VAULT_REVIEW_GATE: 'passed', TM8_VAULT_PUBLIC_ORIGIN: 'https://vault.example.com' };
    for (const sink of [undefined, 'off', 'file']) {
      expect(() => loadBrokerConfig({ ...env, TM8_VAULT_AUDIT_SINK: sink }, kms)).toThrow('vault broker: invalid TM8_VAULT_AUDIT_SINK');
    }
    const admitted = loadBrokerConfig({ ...env, TM8_VAULT_AUDIT_SINK: 'gcs' }, kms);
    expect(admitted.auditSink).toBe('gcs');
    // A composition root that builds its own config meets the same gate.
    for (const auditSink of ['off', 'file'] as const) {
      expect(() => assertBrokerConfig({ ...admitted, auditSink }, kms)).toThrow('vault broker: invalid TM8_VAULT_AUDIT_SINK');
    }
    expect(() => assertBrokerConfig(admitted, kms)).not.toThrow();
    // Every earlier mode keeps the file sink.
    for (const mode of ['dev', 'pre_review']) {
      expect(loadBrokerConfig({ TM8_VAULT_MODE: mode, TM8_VAULT_AUDIT_SINK: 'file' }).auditSink).toBe('file');
    }
  });
  it.each(BROKER_ENV_KNOBS.map((knob) => knob.name))('refuses an invalid %s without echoing it', (knob) => {
    const marker = 'test-only-invalid-value?private=never-echo' + (knob === 'TM8_VAULT_WEBAUTHN_RP_NAME' ? '\n' : '');
    try { loadBrokerConfig({ [knob]: marker }); throw new Error('accepted invalid config'); }
    catch (error) {
      expect(error instanceof BrokerConfigError).toBe(true);
      expect((error as Error).message).toBe(`vault broker: invalid ${knob}`);
      expect((error as Error).message.includes(marker)).toBe(false);
    }
  });
  it('rejects insecure production origins, malformed origins and RP mismatches', () => {
    const kms = { kind: 'gcp-kms' as const, productionGrade: true };
    expect(() => loadBrokerConfig({ TM8_VAULT_MODE: 'production', TM8_VAULT_REVIEW_GATE: 'passed' }, kms)).toThrow('TM8_VAULT_PUBLIC_ORIGIN');
    for (const value of ['https://example.com/path', 'https://test:only@example.com', 'https://example.com/?private=x', 'https://example.com/#x']) {
      expect(() => loadBrokerConfig({ TM8_VAULT_PUBLIC_ORIGIN: value })).toThrow('TM8_VAULT_PUBLIC_ORIGIN');
    }
    expect(() => loadBrokerConfig({ TM8_VAULT_WEBAUTHN_RP_ID: 'other.example.com' })).toThrow('TM8_VAULT_WEBAUTHN_ORIGINS');
  });
  it('puts capture links and WebAuthn on https only, with loopback http outside production alone (review addendum 2, C3)', () => {
    const kms = { kind: 'gcp-kms' as const, productionGrade: true };
    const production = { TM8_VAULT_MODE: 'production', TM8_VAULT_REVIEW_GATE: 'passed', TM8_VAULT_AUDIT_SINK: 'gcs' };
    for (const mode of ['off', 'dev', 'pre_review']) {
      expect(() => loadBrokerConfig({ TM8_VAULT_MODE: mode, TM8_VAULT_PUBLIC_ORIGIN: 'http://vault.example.com' })).toThrow('TM8_VAULT_PUBLIC_ORIGIN');
      expect(() => loadBrokerConfig({ TM8_VAULT_MODE: mode, TM8_VAULT_PUBLIC_ORIGIN: 'https://vault.example.com',
        TM8_VAULT_WEBAUTHN_ORIGINS: 'https://vault.example.com,http://vault.example.com' })).toThrow('TM8_VAULT_WEBAUTHN_ORIGINS');
    }
    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173']) {
      expect(loadBrokerConfig({ TM8_VAULT_MODE: 'pre_review', TM8_VAULT_PUBLIC_ORIGIN: origin }).publicOrigin).toBe(origin);
      expect(() => loadBrokerConfig({ ...production, TM8_VAULT_PUBLIC_ORIGIN: origin }, kms)).toThrow('TM8_VAULT_PUBLIC_ORIGIN');
    }
    expect(() => loadBrokerConfig({ ...production, TM8_VAULT_PUBLIC_ORIGIN: 'https://localhost',
      TM8_VAULT_WEBAUTHN_ORIGINS: 'https://localhost,http://localhost:5173' }, kms)).toThrow('TM8_VAULT_WEBAUTHN_ORIGINS');
    const served = loadBrokerConfig({ ...production, TM8_VAULT_PUBLIC_ORIGIN: 'https://vault.example.com' }, kms);
    expect([served.publicOrigin, served.webauthn.origins]).toEqual(['https://vault.example.com', ['https://vault.example.com']]);
  });
  it('parses exact allowlists and every feature knob', () => {
    const config = loadBrokerConfig({ TM8_VAULT_PUBLIC_ORIGIN: 'https://vault.example.com', TM8_VAULT_WEBAUTHN_RP_ID: 'example.com',
      TM8_VAULT_WEBAUTHN_ORIGINS: 'https://vault.example.com,https://app.example.com', TM8_VAULT_WEBAUTHN_RP_NAME: 'test-only',
      TM8_VAULT_PRE_REVIEW_FILL_ORIGINS: 'https://login.example.com', TM8_VAULT_PRE_REVIEW_API_HOSTS: 'api.example.com',
      TM8_VAULT_PRE_REVIEW_MAX_ITEMS: '7', TM8_VAULT_CAPTURE: 'false', TM8_VAULT_FILL: 'false', TM8_VAULT_CALL_API: 'false',
      TM8_VAULT_IMPORT: 'false', TM8_VAULT_GRANTS: 'false', TM8_VAULT_SPEND: 'false', TM8_VAULT_AUDIT_SINK: 'gcs' });
    expect(config.features).toEqual({ capture: false, fill: false, callApi: false, spend: false, import: false, grants: false });
    expect(config.preReview).toEqual({ maxItemsPerMember: 7, allowedFillOrigins: ['https://login.example.com'], allowedApiHosts: ['api.example.com'] });
    expect(new Set(BROKER_ENV_KNOBS.map((knob) => knob.name)).size).toBe(BROKER_ENV_KNOBS.length);
  });
});

describe('cookies and token buckets', () => {
  it('passes only the two exact vault cookie names and rejects duplicates', () => {
    expect(parseVaultCookies('other=ignored; tm8_vault_session=test-only; tm8_vault_refresh=test-refresh')).toEqual({ session: 'test-only', refresh: 'test-refresh' });
    expect(parseVaultCookies('TM8_VAULT_SESSION=ignored')).toEqual({ session: null, refresh: null });
    expect(() => parseVaultCookies('tm8_vault_session=one; tm8_vault_session=two')).toThrow();
    expect(() => parseVaultCookies('tm8_vault_session="bad"')).toThrow();
  });
  it('emits exactly the documented cookie attributes and clear paths', () => {
    expect(serializeVaultCookie({ name: 'tm8_vault_session', value: 'test-only', maxAgeSeconds: 900 }))
      .toBe('tm8_vault_session=test-only; Max-Age=900; Path=/v2/vault; HttpOnly; Secure; SameSite=Strict');
    expect(serializeVaultCookie({ name: 'tm8_vault_refresh', value: null, maxAgeSeconds: 999 }))
      .toBe('tm8_vault_refresh=; Max-Age=0; Path=/v2/vault/session; HttpOnly; Secure; SameSite=Strict');
    expect(() => serializeVaultCookie({ name: 'tm8_vault_session', value: 'test;injection', maxAgeSeconds: 900 })).toThrow();
  });
  it('limits by member and class, refills, and also limits auth/capture by IP', () => {
    const clock = new FixedClock();
    const limiter = new BrokerRateLimiter(clock);
    for (let n = 0; n < BROKER_RATE_LIMITS.auth.capacity; n += 1) limiter.take(testCaller, 'auth');
    expect(() => limiter.take(testCaller, 'auth')).toThrow('rate_limited');
    expect(() => limiter.take(makeCaller({ memberId: '00000000-0000-4000-8000-000000000055' }), 'auth')).toThrow('rate_limited');
    expect(() => limiter.take(testCaller, 'read')).not.toThrow();
    clock.advanceSeconds(6);
    expect(() => limiter.take(testCaller, 'auth')).not.toThrow();
  });
  it("review addendum 2, C2: an agent has its own buckets, so it cannot use up its member's sign-in, capture or kill-switch budget", () => {
    const limiter = new BrokerRateLimiter(new FixedClock());
    const agent = agentOf(testCaller);
    for (const group of ['auth', 'capture', 'command', 'read', 'verify'] as const) {
      for (let n = 0; n < BROKER_RATE_LIMITS[group].capacity; n += 1) limiter.take(agent, group);
      expect(() => limiter.take(agent, group), group).toThrow('rate_limited');
      // Every agent session of one member shares that member's agent budget.
      expect(() => limiter.take(agentOf(testCaller), group), group).toThrow('rate_limited');
      // The member's browser does not.
      expect(() => limiter.take(testCaller, group), group).not.toThrow();
    }
  });
  it("review addendum 2, C2: agents share the host's address, so they are not limited by it; humans are", () => {
    const limiter = new BrokerRateLimiter(new FixedClock());
    const loopback = '127.0.0.1';
    const mine = agentOf(makeCaller({ ip: loopback }));
    const theirs = agentOf(makeCaller({ memberId: '00000000-0000-4000-8000-000000000056', ip: loopback }));
    for (let n = 0; n < BROKER_RATE_LIMITS.capture.capacity; n += 1) limiter.take(mine, 'capture');
    expect(() => limiter.take(mine, 'capture')).toThrow('rate_limited');
    expect(() => limiter.take(theirs, 'capture')).not.toThrow();
    // Two people behind one address still share its sign-in and capture budgets.
    const human = makeCaller({ ip: loopback });
    const neighbour = makeCaller({ memberId: '00000000-0000-4000-8000-000000000057', ip: loopback });
    for (const group of ['auth', 'capture'] as const) {
      for (let n = 0; n < BROKER_RATE_LIMITS[group].capacity; n += 1) limiter.take(human, group);
      expect(() => limiter.take(neighbour, group), group).toThrow('rate_limited');
    }
  });
  it('review addendum 2, C2: a full audit verification has the strictest read budget', () => {
    expect(rateClass('vault.audit.verify', true)).toBe('verify');
    expect(rateClass('vault.audit.list', true)).toBe('read');
    expect(BROKER_RATE_LIMITS.verify.capacity).toBeLessThan(BROKER_RATE_LIMITS.read.capacity);
    expect(BROKER_RATE_LIMITS.verify.refillPerSecond).toBeLessThan(BROKER_RATE_LIMITS.read.refillPerSecond);
    const clock = new FixedClock();
    const limiter = new BrokerRateLimiter(clock);
    for (let n = 0; n < BROKER_RATE_LIMITS.verify.capacity; n += 1) limiter.take(testCaller, 'verify');
    expect(() => limiter.take(testCaller, 'verify')).toThrow('rate_limited');
    expect(() => limiter.take(testCaller, 'read')).not.toThrow();
    clock.advanceSeconds(1 / BROKER_RATE_LIMITS.verify.refillPerSecond);
    expect(() => limiter.take(testCaller, 'verify')).not.toThrow();
  });
  it('review addendum 2, C2: Argon2id work is charged per hash to one budget for the whole broker', () => {
    expect(kdfCost('vault.recovery.codes.create', {})).toBe(RECOVERY_CODE_COUNT);
    // The charge is the batch the contract requires.
    const batch = (n: number) => ({ codes: Array.from({ length: n }, (_, i) => `test-only-${i}`), createdAt: new Date(0).toISOString() });
    const result = VAULT_OUTPUT_SCHEMAS['vault.recovery.codes.create'];
    expect(result.safeParse(batch(RECOVERY_CODE_COUNT)).success).toBe(true);
    for (const n of [RECOVERY_CODE_COUNT - 1, RECOVERY_CODE_COUNT + 1]) expect(result.safeParse(batch(n)).success, String(n)).toBe(false);
    expect(kdfCost('vault.passkeys.registerBegin', { enrollmentCode: 'test-only' })).toBe(1);
    expect(kdfCost('vault.passkeys.registerBegin', { recoveryCode: 'test-only' })).toBe(1);
    expect(kdfCost('vault.passkeys.registerBegin', { stepUp: {} })).toBe(0);
    for (const row of VAULT_OPERATIONS) {
      if (row.name === 'vault.recovery.codes.create' || row.name === 'vault.passkeys.registerBegin') continue;
      expect(kdfCost(row.name, { enrollmentCode: 'test-only', recoveryCode: 'test-only' }), row.name).toBe(0);
    }
    const clock = new FixedClock();
    const limiter = new BrokerRateLimiter(clock);
    const { capacity, refillPerSecond } = BROKER_SHARED_LIMITS.kdf;
    limiter.takeShared('kdf', RECOVERY_CODE_COUNT);
    for (let n = RECOVERY_CODE_COUNT; n < capacity; n += 1) limiter.takeShared('kdf', 1);
    let refusal: unknown;
    try { limiter.takeShared('kdf', 1); } catch (error) { refusal = error; }
    expect(refusal).toMatchObject({ code: 'rate_limited', extra: { retryAfterSeconds: Math.ceil(1 / refillPerSecond) } });
    // A batch waits for the whole of its cost.
    clock.advanceSeconds((RECOVERY_CODE_COUNT - 1) / refillPerSecond);
    expect(() => limiter.takeShared('kdf', RECOVERY_CODE_COUNT)).toThrow('rate_limited');
    clock.advanceSeconds(2 / refillPerSecond);
    expect(() => limiter.takeShared('kdf', RECOVERY_CODE_COUNT)).not.toThrow();
    for (const cost of [0, -1, 1.5, Number.NaN, capacity + 1]) expect(() => limiter.takeShared('kdf', cost), String(cost)).toThrow('invalid rate cost');
    expect(() => new BrokerRateLimiter(clock, BROKER_RATE_LIMITS, 100_000, { kdf: { capacity: RECOVERY_CODE_COUNT - 1, refillPerSecond: 1 } }))
      .toThrow('invalid rate limit');
    expect(() => new BrokerRateLimiter(clock, BROKER_RATE_LIMITS, 100_000, { kdf: { capacity: 20, refillPerSecond: 0 } })).toThrow('invalid rate limit');
  });
  it('review addendum 2, C2: only the two charged operations reach Argon2id through the API', () => {
    const src = fileURLToPath(new URL('../../src', import.meta.url));
    const calls = sourceFiles(src).filter((file) => !file.endsWith('/owner-auth/codes.ts')).flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(/\b(findCode|newCodeBatch|newCode|mintEnrollmentCode|argon2id|argon2Verify|argon2i|argon2d|bcrypt|scrypt\w*|pbkdf2\w*)\(/g)]
        .map((match) => `${relative(src, file)} ${match[1]}`));
    // The enroll CLI is out of band: a broker operator runs it, never an operation handler.
    expect(calls.sort()).toEqual(['owner-auth/enroll-cli.ts mintEnrollmentCode', 'owner-auth/handlers.ts findCode', 'owner-auth/handlers.ts newCodeBatch']);
    const handlers = readFileSync(`${src}/owner-auth/handlers.ts`, 'utf8');
    const body = (op: string) => {
      const start = handlers.indexOf(`'${op}': async`);
      const next = handlers.slice(start + 1).search(/\n {4}'vault\./);
      return handlers.slice(start, next < 0 ? undefined : start + 1 + next);
    };
    expect(body('vault.passkeys.registerBegin')).toContain('await findCode(');
    expect(body('vault.recovery.codes.create')).toContain('await newCodeBatch(RECOVERY_CODE_COUNT)');
  });
});
