import { describe, expect, it } from 'vitest';
import { BROKER_ENV_KNOBS, BrokerConfigError, loadBrokerConfig } from '../../src/broker/config.js';
import { BrokerRateLimiter, BROKER_RATE_LIMITS } from '../../src/broker/rate-limit.js';
import { parseVaultCookies, serializeVaultCookie } from '../../src/broker/dispatcher.js';
import { FixedClock, makeCaller, testCaller } from '../support/kit.js';

describe('broker config and closed runtime settings', () => {
  it('defaults to off and spend stays false in every admitted mode', () => {
    expect(loadBrokerConfig({}).mode).toBe('off');
    for (const mode of ['off', 'dev', 'pre_review']) expect(loadBrokerConfig({ TM8_VAULT_MODE: mode }).features.spend).toBe(false);
    expect(loadBrokerConfig({ TM8_VAULT_MODE: 'pre_review' }).features.import).toBe(false);
  });
  it('admits production only after both gates with a real production-grade adapter', () => {
    const env = { TM8_VAULT_MODE: 'production', TM8_VAULT_REVIEW_GATE: 'passed', TM8_VAULT_PUBLIC_ORIGIN: 'https://vault.example.com' };
    expect(() => loadBrokerConfig({ ...env, TM8_VAULT_REVIEW_GATE: 'open' }, { kind: 'gcp-kms', productionGrade: true })).toThrow('TM8_VAULT_REVIEW_GATE');
    expect(() => loadBrokerConfig(env)).toThrow('TM8_VAULT_KMS_KIND');
    expect(() => loadBrokerConfig(env, { kind: 'local-dev', productionGrade: false })).toThrow('TM8_VAULT_KMS_KIND');
    expect(() => loadBrokerConfig(env, { kind: 'local-dev', productionGrade: true })).toThrow('TM8_VAULT_KMS_KIND');
    expect(() => loadBrokerConfig(env, { kind: 'gcp-kms', productionGrade: false })).toThrow('TM8_VAULT_KMS_KIND');
    expect(loadBrokerConfig(env, { kind: 'gcp-kms', productionGrade: true }).mode).toBe('production');
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
});
