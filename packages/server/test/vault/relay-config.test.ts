/**
 * The vault relay's boot configuration, and the refusals the relay makes
 * before it reads a body, resolves a space or contacts a broker (Secure Vault
 * brief v2; task 01a1fa87-dd1a, WS-A). No database and no broker here:
 * relay.pg.test.ts runs the relay on a real node.
 *
 * Every key is generated at runtime and none is printed. The credential-shaped
 * broker URL is assembled with the URL API.
 */
import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CollabError } from '@tm8/contract';
import { exportAttestationKeyPair, generateAttestationKeyPair, publicKeySha256 } from '@tm8/vault/relay';

import type { FacadeDeps } from '../../src/facade/deps.js';
import type { RequestIdentity } from '../../src/http/types.js';
import {
  VAULT_RELAY_DEFAULT_TIMEOUT_MS, VaultRelayConfigError, vaultRelayConfigFromEnv, type VaultRelayConfig,
} from '../../src/vault/config.js';
import { createVaultRelay, type VaultRelayLogEvent } from '../../src/vault/relay.js';
import { fakeResponse } from './fake-response.js';

let dir: string;
let keyFile: string;
let keyPem: string;
let socketPath: string;
let tlsPem: string;
const files: Record<string, string> = {};

/** The knob a refusal names, or 'accepted'. */
function knobOf(env: NodeJS.ProcessEnv): string {
  try {
    vaultRelayConfigFromEnv(env);
    return 'accepted';
  } catch (error) {
    if (error instanceof VaultRelayConfigError) return error.knob;
    throw error;
  }
}

const socketEnv = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  TM8_VAULT_MODE: 'pre_review', TM8_VAULT_BROKER_SOCKET: socketPath, TM8_VAULT_RELAY_PRIVATE_KEY_FILE: keyFile, ...extra,
});
const urlEnv = (url: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  TM8_VAULT_MODE: 'pre_review',
  TM8_VAULT_BROKER_URL: url,
  TM8_VAULT_RELAY_TLS_KEY_FILE: files['tlsKey'],
  TM8_VAULT_RELAY_TLS_CERT_FILE: files['cert'],
  TM8_VAULT_RELAY_TLS_CA_FILE: files['ca'],
  TM8_VAULT_RELAY_PRIVATE_KEY_FILE: keyFile,
  ...extra,
});

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tm8-vault-config-'));
  socketPath = join(dir, 'broker.sock');
  keyPem = exportAttestationKeyPair(generateAttestationKeyPair()).privatePem;
  keyFile = join(dir, 'relay.key');
  await writeFile(keyFile, keyPem, { mode: 0o600 });
  // The TLS material is read at boot and parsed only when the relay connects.
  const write = async (name: string, body: string, mode: number): Promise<void> => {
    files[name] = join(dir, name);
    await writeFile(files[name]!, body, { mode });
  };
  await write('tlsKey', 'relay tls key, parsed at connect time', 0o600);
  await write('cert', 'relay certificate', 0o644);
  await write('ca', 'broker ca', 0o644);
  await write('openKey', keyPem, 0o644);
  await write('groupKey', keyPem, 0o640);
  await write('openTlsKey', 'relay tls key', 0o644);
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  await write('ecKey', ec, 0o600);
  await write('garbage', 'not a key', 0o600);
  // A parseable TLS client key, for the retired-key check (review F03, R7). Throwaway, generated here.
  tlsPem = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  await write('tlsRealKey', tlsPem, 0o600);
  files['dirKey'] = join(dir, 'a-directory');
  await mkdir(files['dirKey'], { mode: 0o700 });
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('vaultRelayConfigFromEnv', () => {
  it('is off by default, and off reads nothing else', () => {
    expect(vaultRelayConfigFromEnv({})).toBeNull();
    expect(vaultRelayConfigFromEnv({ TM8_VAULT_MODE: ' off ' })).toBeNull();
    // Off never opens the key file or checks the target, however broken they are.
    expect(vaultRelayConfigFromEnv({
      TM8_VAULT_MODE: 'off', TM8_VAULT_BROKER_SOCKET: 'relative.sock', TM8_VAULT_BROKER_URL: 'http://x', TM8_VAULT_RELAY_PRIVATE_KEY_FILE: '/absent',
    })).toBeNull();
  });

  it('refuses any mode it does not know', () => {
    for (const mode of ['on', 'OFF', 'prod', 'preview', 'true', '1']) expect(knobOf({ TM8_VAULT_MODE: mode })).toBe('TM8_VAULT_MODE');
  });

  it('a socket target is absolute, never in production, never alongside a URL, and one of the two is required', () => {
    expect(knobOf(socketEnv())).toBe('accepted');
    expect(knobOf(socketEnv({ TM8_VAULT_MODE: 'dev' }))).toBe('accepted');
    expect(knobOf(socketEnv({ TM8_VAULT_MODE: 'production' }))).toBe('TM8_VAULT_BROKER_SOCKET');
    expect(knobOf(socketEnv({ TM8_VAULT_BROKER_SOCKET: 'broker.sock' }))).toBe('TM8_VAULT_BROKER_SOCKET');
    expect(knobOf(socketEnv({ TM8_VAULT_BROKER_URL: 'https://broker.invalid' }))).toBe('TM8_VAULT_BROKER_SOCKET');
    expect(knobOf(socketEnv({ TM8_VAULT_BROKER_SOCKET: '  ' }))).toBe('TM8_VAULT_BROKER_SOCKET');
  });

  it('a URL target is a bare https origin with the three TLS files, the key owner-only', () => {
    expect(knobOf(urlEnv('https://broker.invalid:8443'))).toBe('accepted');
    expect(knobOf(urlEnv('https://broker.invalid:8443/'))).toBe('accepted');
    const withCredentials = new URL('https://broker.invalid');
    withCredentials.username = 'relay';
    withCredentials.password = ['not', 'a', 'secret'].join('-');
    for (const url of [
      'http://broker.invalid', 'https://broker.invalid/v2', 'https://broker.invalid/?a=1', 'https://broker.invalid/#f',
      withCredentials.href, 'broker.invalid:8443', 'not a url',
    ]) {
      expect(knobOf(urlEnv(url))).toBe('TM8_VAULT_BROKER_URL');
    }
    expect(knobOf(urlEnv('https://broker.invalid', { TM8_VAULT_RELAY_TLS_KEY_FILE: '' }))).toBe('TM8_VAULT_RELAY_TLS_KEY_FILE');
    expect(knobOf(urlEnv('https://broker.invalid', { TM8_VAULT_RELAY_TLS_KEY_FILE: files['openTlsKey'] }))).toBe('TM8_VAULT_RELAY_TLS_KEY_FILE');
    expect(knobOf(urlEnv('https://broker.invalid', { TM8_VAULT_RELAY_TLS_CERT_FILE: undefined }))).toBe('TM8_VAULT_RELAY_TLS_CERT_FILE');
    expect(knobOf(urlEnv('https://broker.invalid', { TM8_VAULT_RELAY_TLS_CA_FILE: join(dir, 'absent.pem') }))).toBe('TM8_VAULT_RELAY_TLS_CA_FILE');
    expect(knobOf(urlEnv('https://broker.invalid:8443', { TM8_VAULT_MODE: 'dev' }))).toBe('accepted');
    const config = vaultRelayConfigFromEnv(urlEnv('https://broker.invalid:8443'))!;
    expect(config.broker.kind).toBe('mtls');
    expect(config.broker.kind === 'mtls' && config.broker.url.origin).toBe('https://broker.invalid:8443');
  });

  it('production is refused before any key file is opened, while agents run as the server user (review F03)', () => {
    const production = { TM8_VAULT_MODE: 'production' };
    // Every file valid: still refused.
    expect(knobOf(urlEnv('https://broker.invalid:8443', production))).toBe('TM8_VAULT_MODE');
    expect(knobOf(urlEnv('https://broker.invalid:8443', { TM8_VAULT_MODE: ' production ' }))).toBe('TM8_VAULT_MODE');
    // Every file absent or unsafe: a read would name that file's knob, so none was opened.
    const absent = join(dir, 'never-created');
    expect(knobOf(urlEnv('https://broker.invalid:8443', {
      ...production, TM8_VAULT_RELAY_TLS_KEY_FILE: absent, TM8_VAULT_RELAY_TLS_CERT_FILE: absent,
      TM8_VAULT_RELAY_TLS_CA_FILE: absent, TM8_VAULT_RELAY_PRIVATE_KEY_FILE: files['openKey'],
    }))).toBe('TM8_VAULT_MODE');
    // The target's shape is still checked first, so a socket names the socket and no target names both.
    expect(knobOf(socketEnv(production))).toBe('TM8_VAULT_BROKER_SOCKET');
    expect(knobOf(production)).toBe('TM8_VAULT_BROKER_SOCKET');
    let message = '';
    try { vaultRelayConfigFromEnv(urlEnv('https://broker.invalid:8443', production)); } catch (error) { message = String(error); }
    expect(message).toMatch(/^VaultRelayConfigError: vault relay: TM8_VAULT_MODE production is refused \(review F03\)/);
    expect(message.includes(dir)).toBe(false);
  });

  it('the signing key is a required, owner-only, regular PKCS#8 Ed25519 file, and a refusal never echoes it', () => {
    const key = (path: string | undefined): string => knobOf(socketEnv({ TM8_VAULT_RELAY_PRIVATE_KEY_FILE: path }));
    for (const path of [undefined, '', 'relay.key', join(dir, 'absent.key'), files['dirKey'], files['openKey'], files['groupKey'], files['ecKey'], files['garbage']]) {
      expect(key(path)).toBe('TM8_VAULT_RELAY_PRIVATE_KEY_FILE');
    }
    for (const path of [files['openKey'], files['ecKey'], files['garbage']]) {
      let message = '';
      try { vaultRelayConfigFromEnv(socketEnv({ TM8_VAULT_RELAY_PRIVATE_KEY_FILE: path })); } catch (error) { message = String(error); }
      expect(message).toMatch(/^VaultRelayConfigError: vault relay: TM8_VAULT_RELAY_PRIVATE_KEY_FILE /);
      expect(message.includes('PRIVATE KEY')).toBe(false);
      expect(message.includes(keyPem.split('\n')[1]!)).toBe(false);
    }
  });

  it('review F03, R7: a malformed retired-key list refuses in every mode, before any key file is opened', () => {
    const url = 'https://broker.invalid:8443';
    for (const value of ['zz'.repeat(32), `${'ab'.repeat(32)},`, `${'ab'.repeat(32)} ${'cd'.repeat(32)}`, 'ab'.repeat(31), `SHA256 Fingerprint=${'AB:'.repeat(31)}AB`]) {
      expect(knobOf(socketEnv({ TM8_VAULT_RETIRED_KEY_SHA256: value }))).toBe('TM8_VAULT_RETIRED_KEY_SHA256');
      expect(knobOf(urlEnv(url, { TM8_VAULT_RETIRED_KEY_SHA256: value }))).toBe('TM8_VAULT_RETIRED_KEY_SHA256');
      // An absent key file would name its own knob if it had been opened first.
      expect(knobOf(socketEnv({ TM8_VAULT_RETIRED_KEY_SHA256: value, TM8_VAULT_RELAY_PRIVATE_KEY_FILE: join(dir, 'never-created') }))).toBe('TM8_VAULT_RETIRED_KEY_SHA256');
      expect(knobOf(urlEnv(url, { TM8_VAULT_MODE: 'production', TM8_VAULT_RETIRED_KEY_SHA256: value }))).toBe('TM8_VAULT_RETIRED_KEY_SHA256');
    }
    // Unset or blank is the empty list, the shipped default.
    for (const value of [undefined, '', '  ']) expect(knobOf(socketEnv({ TM8_VAULT_RETIRED_KEY_SHA256: value }))).toBe('accepted');
  });

  it('review F03, R7: refuses a signing key or a TLS client key on the list, naming the file knob and never the fingerprint', () => {
    const url = 'https://broker.invalid:8443';
    const signing = publicKeySha256(createPrivateKey(keyPem));
    const tls = publicKeySha256(createPrivateKey(tlsPem));
    const other = 'ab'.repeat(32);
    const colons = (fingerprint: string) => fingerprint.toUpperCase().match(/../g)!.join(':');
    for (const listed of [signing, colons(signing), `${other},${signing}`, `${tls},${signing}`]) {
      expect(knobOf(socketEnv({ TM8_VAULT_RETIRED_KEY_SHA256: listed }))).toBe('TM8_VAULT_RELAY_PRIVATE_KEY_FILE');
      expect(knobOf(urlEnv(url, { TM8_VAULT_RELAY_TLS_KEY_FILE: files['tlsRealKey'], TM8_VAULT_RETIRED_KEY_SHA256: listed }))).toBe('TM8_VAULT_RELAY_PRIVATE_KEY_FILE');
    }
    for (const listed of [tls, colons(tls), `${other},${tls}`]) {
      expect(knobOf(urlEnv(url, { TM8_VAULT_RELAY_TLS_KEY_FILE: files['tlsRealKey'], TM8_VAULT_RETIRED_KEY_SHA256: listed }))).toBe('TM8_VAULT_RELAY_TLS_KEY_FILE');
      expect(knobOf(urlEnv(url, { TM8_VAULT_MODE: 'dev', TM8_VAULT_RELAY_TLS_KEY_FILE: files['tlsRealKey'], TM8_VAULT_RETIRED_KEY_SHA256: listed }))).toBe('TM8_VAULT_RELAY_TLS_KEY_FILE');
      // A socket target has no TLS key, so a listed TLS key is not this relay's.
      expect(knobOf(socketEnv({ TM8_VAULT_RETIRED_KEY_SHA256: listed }))).toBe('accepted');
    }
    const messages: string[] = [];
    for (const env of [socketEnv({ TM8_VAULT_RETIRED_KEY_SHA256: signing }), urlEnv(url, { TM8_VAULT_RELAY_TLS_KEY_FILE: files['tlsRealKey'], TM8_VAULT_RETIRED_KEY_SHA256: tls })]) {
      try { vaultRelayConfigFromEnv(env); } catch (error) { messages.push(String(error)); }
    }
    expect(messages).toEqual([
      'VaultRelayConfigError: vault relay: TM8_VAULT_RELAY_PRIVATE_KEY_FILE is a retired key (TM8_VAULT_RETIRED_KEY_SHA256, review F03 R7)',
      'VaultRelayConfigError: vault relay: TM8_VAULT_RELAY_TLS_KEY_FILE is a retired key (TM8_VAULT_RETIRED_KEY_SHA256, review F03 R7)',
    ]);
    // Keys that are not listed load, in both targets.
    expect(knobOf(socketEnv({ TM8_VAULT_RETIRED_KEY_SHA256: other }))).toBe('accepted');
    expect(knobOf(urlEnv(url, { TM8_VAULT_RELAY_TLS_KEY_FILE: files['tlsRealKey'], TM8_VAULT_RETIRED_KEY_SHA256: other }))).toBe('accepted');
  });

  it('review F03, R7: with a non-empty list, a TLS client key that cannot be parsed cannot be shown not retired, so it refuses', () => {
    const url = 'https://broker.invalid:8443';
    // The default fixture is not a key: the empty list never parses it, as before (it is parsed at connect time).
    expect(knobOf(urlEnv(url))).toBe('accepted');
    let message = '';
    try { vaultRelayConfigFromEnv(urlEnv(url, { TM8_VAULT_RETIRED_KEY_SHA256: 'ab'.repeat(32) })); } catch (error) { message = String(error); }
    expect(message).toBe('VaultRelayConfigError: vault relay: TM8_VAULT_RELAY_TLS_KEY_FILE is not an unencrypted PEM private key, '
      + 'so it cannot be checked against TM8_VAULT_RETIRED_KEY_SHA256');
    expect(message.includes('relay tls key')).toBe(false);
  });

  it('the timeout is whole milliseconds from 10 s to 10 min, 190 s by default', () => {
    expect(vaultRelayConfigFromEnv(socketEnv())!.timeoutMs).toBe(VAULT_RELAY_DEFAULT_TIMEOUT_MS);
    expect(VAULT_RELAY_DEFAULT_TIMEOUT_MS).toBe(190_000);
    for (const raw of ['10000', '600000', ' 45000 ']) {
      expect(vaultRelayConfigFromEnv(socketEnv({ TM8_VAULT_RELAY_TIMEOUT_MS: raw }))!.timeoutMs).toBe(Number(raw));
    }
    for (const raw of ['9999', '600001', '1e4', '0x2710', '12000.5', '-10000', '10_000', 'abc', '99999999']) {
      expect(knobOf(socketEnv({ TM8_VAULT_RELAY_TIMEOUT_MS: raw }))).toBe('TM8_VAULT_RELAY_TIMEOUT_MS');
    }
  });

  it('returns a frozen config holding a key object, not the PEM', () => {
    const config = vaultRelayConfigFromEnv(socketEnv())!;
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.broker)).toBe(true);
    expect([config.mode, config.broker]).toEqual(['pre_review', { kind: 'socket', socketPath }]);
    expect([config.privateKey.type, config.privateKey.asymmetricKeyType]).toEqual(['private', 'ed25519']);
    expect(JSON.stringify(config).includes(keyPem.split('\n')[1]!)).toBe(false);
  });
});

describe('vault relay refusals before any broker contact', () => {
  const member: RequestIdentity = { kind: 'bearer', identityId: 'vault-config-member', authKind: 'browser', token: ['opaque', 'test', 'credential'].join('-') };
  const request = (method: string): IncomingMessage => ({ method, headers: {} }) as unknown as IncomingMessage;
  // Nothing below may reach the database: a deps object with no members proves it.
  const deps = {} as FacadeDeps;
  let config: VaultRelayConfig;
  beforeAll(() => { config = vaultRelayConfigFromEnv(socketEnv())!; });

  async function refusal(relayConfig: VaultRelayConfig | null, method: string, path: string, identity: RequestIdentity = member) {
    const events: VaultRelayLogEvent[] = [];
    const relay = createVaultRelay({ config: relayConfig, deps, log: (event) => events.push(event) });
    const { res, sent } = fakeResponse();
    await relay.handleHttp(request(method), res, { requestId: 'req-vault-config', identity, url: new URL(path, 'http://node.invalid') });
    const body = JSON.parse(sent.body!.toString('utf8')) as { error: { code: string; details: { reason: string }; retryable: boolean; requestId: string } };
    return { status: sent.status, headers: sent.headers, body, events };
  }

  it('claims /v2/vault and everything under it, nothing else', () => {
    const relay = createVaultRelay({ config: null, deps });
    expect(['/v2/vault', '/v2/vault/', '/v2/vault/status', '/v2/vault/items/x'].map((path) => relay.matches(path))).toEqual([true, true, true, true]);
    expect(['/v2/vaults', '/v2/vaultstatus', '/v2/x/v2/vault', '/vault', '/v2'].map((path) => relay.matches(path))).toEqual([false, false, false, false, false]);
  });

  it('with the vault off answers every admitted call 503 vault_disabled, retryable, under the relay headers', async () => {
    const off = await refusal(null, 'GET', '/v2/vault/status');
    expect(createVaultRelay({ config: null, deps }).enabled).toBe(false);
    expect([off.status, off.body.error.code, off.body.error.details.reason, off.body.error.retryable]).toEqual([503, 'upstream_unavailable', 'vault_disabled', true]);
    expect(off.body.error.requestId).toBe('req-vault-config');
    expect(off.headers).toMatchObject({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-tm8-request-id': 'req-vault-config' });
    // Off answers the same for a route that does not exist: nothing about the table leaks.
    expect((await refusal(null, 'GET', '/v2/vault/nope')).body.error.details.reason).toBe('vault_disabled');
  });

  it('admits only a signed-in member or agent: no auto-owner, no link or bridge credential, no anonymous caller', async () => {
    const cases: Array<[RequestIdentity, string]> = [
      [{ kind: 'anonymous' }, 'unauthenticated'],
      [{ kind: 'auto-owner', identityId: 'node-owner', authKind: 'browser' }, 'unauthenticated'],
      [{ kind: 'bearer', authKind: 'browser' }, 'unauthenticated'],
      [{ kind: 'bearer', identityId: 'x', authKind: 'link' }, 'forbidden'],
      [{ kind: 'bearer', identityId: 'x', authKind: 'bridge_runtime' }, 'forbidden'],
      [{ kind: 'bearer', identityId: 'x' }, 'forbidden'],
    ];
    for (const relayConfig of [null, config]) {
      for (const [identity, code] of cases) {
        const relay = createVaultRelay({ config: relayConfig, deps, log: () => undefined });
        const { res, sent } = fakeResponse();
        const outcome = await relay.handleHttp(request('GET'), res, { requestId: 'r', identity, url: new URL('http://node.invalid/v2/vault/status') })
          .then(() => 'answered', (error: unknown) => (error instanceof CollabError ? error.code : 'other'));
        expect([identity.kind, identity.authKind, outcome, sent.status]).toEqual([identity.kind, identity.authKind, code, 0]);
      }
    }
  });

  it('a read-only tool token cannot send a vault command', async () => {
    const relay = createVaultRelay({ config, deps, log: () => undefined });
    const { res } = fakeResponse();
    const readOnly: RequestIdentity = { ...member, apiScope: 'read' };
    await expect(relay.handleHttp(request('POST'), res, {
      requestId: 'r', identity: readOnly, url: new URL('http://node.invalid/v2/vault/session/end'),
    })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('answers an unknown method, path or parameter 404 and an over-long query 414, and logs no caller', async () => {
    const missing = [
      ['GET', '/v2/vault/nope'], ['PUT', '/v2/vault/status'], ['POST', '/v2/vault/status'], ['DELETE', '/v2/vault/items'],
      ['GET', '/v2/vault/items/not-a-uuid'], ['GET', '/v2/vault/items/'], ['GET', '/v2/vault'],
    ] as const;
    for (const [method, path] of missing) {
      const answer = await refusal(config, method, path);
      expect([method, path, answer.status, answer.body.error.details.reason]).toEqual([method, path, 404, 'not_found']);
    }
    const long = await refusal(config, 'GET', `/v2/vault/status?q=${'a'.repeat(4_100)}`);
    expect([long.status, long.body.error.code, long.body.error.details.reason]).toEqual([414, 'invalid_input', 'uri_too_long']);
    expect(long.events).toEqual([{ event: 'vault.relay', requestId: 'req-vault-config', op: 'vault.status', status: 414, ms: expect.any(Number) }]);
    const logged = JSON.stringify(long.events);
    expect([logged.includes(member.identityId!), logged.includes(member.token!), logged.includes('aaaa')]).toEqual([false, false, false]);
  });
});
