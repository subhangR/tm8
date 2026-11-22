/**
 * The vault relay's boot configuration, and the refusals the relay makes
 * before it reads a body, resolves a space or contacts a broker (Secure Vault
 * brief v2; task 01a1fa87-dd1a, WS-A). No database and no broker here:
 * relay.pg.test.ts runs the relay on a real node.
 *
 * Every key is generated at runtime and none is printed. The credential-shaped
 * broker URL is assembled with the URL API.
 *
 * The agent-boundary checks (review F03, D5; src/vault/boundary.ts) run here on a view that takes
 * this process's uid and the fixture files' real owners, modes and paths, and fixed text for every
 * /etc and /proc read: no result below depends on this machine's groups, mounts or limits.
 * relay-boundary.test.ts covers each check on a wholly synthetic host. The TLS certificates for R8
 * are throwaway, made by openssl at runtime in the temporary directory.
 */
import { execFileSync } from 'node:child_process';
import { X509Certificate, createPrivateKey, generateKeyPairSync } from 'node:crypto';
import { accessSync, constants, readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CollabError } from '@tm8/contract';
import { exportAttestationKeyPair, generateAttestationKeyPair, publicKeySha256 } from '@tm8/vault/relay';

import type { FacadeDeps } from '../../src/facade/deps.js';
import type { RequestIdentity } from '../../src/http/types.js';
import { AGENT_RUN_AS_KNOB, systemHostView, type BoundaryFailure, type VaultHostView } from '../../src/vault/boundary.js';
import {
  VAULT_RELAY_DEFAULT_TIMEOUT_MS, VaultBoundaryError, VaultRelayConfigError, vaultRelayConfigFromEnv, type VaultRelayConfig,
} from '../../src/vault/config.js';
import { createVaultRelay, type VaultRelayLogEvent } from '../../src/vault/relay.js';
import { fakeResponse } from './fake-response.js';

let dir: string;
let keyFile: string;
let keyPem: string;
let socketPath: string;
let tlsPem: string;
const files: Record<string, string> = {};
/** The R8 leaf certificate's validity, and the clock the hardened view reads: its midpoint. */
let tlsValidity = { from: 0, to: 0 };
let tlsNow = 0;
/** Whether this process can read a mode-000 file (root can), which decides what a read of one names. */
let sealedReadable = false;

/** The knob a refusal names, or 'accepted'. Without a view the boot default, the real host, is used. */
function knobOf(env: NodeJS.ProcessEnv, host?: VaultHostView): string {
  try {
    vaultRelayConfigFromEnv(env, host);
    return 'accepted';
  } catch (error) {
    if (error instanceof VaultRelayConfigError) return error.knob;
    throw error;
  }
}

/** The refusal itself. */
function errorOf(env: NodeJS.ProcessEnv, host?: VaultHostView): VaultRelayConfigError {
  try {
    vaultRelayConfigFromEnv(env, host);
  } catch (error) {
    if (error instanceof VaultRelayConfigError) return error;
    throw error;
  }
  throw new Error('expected a refusal, and the config was accepted');
}

/** This process's uid. The agent range sits well clear of it. */
const UID = typeof process.getuid === 'function' ? process.getuid() : 0;
const AGENT_RANGE = `uids:${UID + 100000}-${UID + 165535}`;
const limitsText = (soft: string, hard: string): string => `${'Max core file size'.padEnd(26)}${soft.padEnd(21)}${hard.padEnd(21)}bytes     \n`;
const PROC_HIDDEN = '22 1 0:21 / /proc rw,nosuid,nodev,noexec,relatime shared:12 - proc proc rw,hidepid=invisible\n';
/** A host that meets R3 to R6, with one agent user in the range. */
const HARDENED_TEXT: Readonly<Record<string, string>> = {
  '/etc/group': `root:x:0:\ndocker:x:999:\ntm8-relay:x:${UID}:\n`,
  '/etc/passwd': `root:x:0:0:root:/root:/bin/bash\ntm8-relay:x:${UID}:${UID}::/srv/tm8-relay:/usr/sbin/nologin\n`
    + `agent1:x:${UID + 100001}:${UID + 100001}::/home/agent1:/bin/sh\n`,
  '/proc/sys/kernel/yama/ptrace_scope': '1\n',
  '/proc/self/mountinfo': PROC_HIDDEN,
  '/proc/self/limits': limitsText('0', '0'),
  '/proc/sys/kernel/core_pattern': 'core\n',
};
const HOST_FILES = Object.keys(HARDENED_TEXT).sort();

interface HostPatch {
  readonly uid?: number;
  readonly gids?: readonly number[] | null;
  readonly text?: Readonly<Record<string, string | null>>;
  readonly writable?: readonly string[];
  readonly now?: number;
}

/** The real uid, lstat and realpath; fixed /etc and /proc text, groups, sockets and clock. `reads` collects every readText path. */
function hardenedHost(patch: HostPatch = {}, reads: string[] = []): VaultHostView {
  const text: Record<string, string | null> = { ...HARDENED_TEXT, ...patch.text };
  return {
    uid: () => patch.uid ?? systemHostView.uid(),
    gids: () => (patch.gids === undefined ? [UID] : patch.gids),
    lstat: (path) => systemHostView.lstat(path),
    realpath: (path) => systemHostView.realpath(path),
    readText: (path) => { reads.push(path); return text[path] ?? null; },
    canWrite: (path) => (patch.writable ?? []).includes(path),
    now: () => patch.now ?? tlsNow,
  };
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
  // Canonical, so the boundary's R2 sees the fixture paths as their own realpaths.
  dir = await realpath(await mkdtemp(join(tmpdir(), 'tm8-vault-config-')));
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

  // Review F03, R8: throwaway TLS material, generated here. A CA, a leaf client certificate it
  // signed, and a CA file holding that CA twice.
  const openssl = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: ['ignore', 'ignore', 'ignore'] });
  const p256 = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes'];
  openssl('req', '-x509', ...p256, '-keyout', 'tls-ca.key', '-out', 'tls-ca.crt', '-subj', '/CN=vault-test-ca', '-days', '1');
  openssl('req', ...p256, '-keyout', 'tls-client.key', '-out', 'tls-client.csr', '-subj', '/CN=vault-test-relay');
  await writeFile(join(dir, 'tls-client.ext'), 'extendedKeyUsage=clientAuth\n');
  openssl('x509', '-req', '-in', 'tls-client.csr', '-CA', 'tls-ca.crt', '-CAkey', 'tls-ca.key', '-CAcreateserial',
    '-out', 'tls-client.crt', '-days', '1', '-extfile', 'tls-client.ext');
  for (const [name, file, mode] of [['tlsCaCrt', 'tls-ca.crt', 0o644], ['tlsClientKey', 'tls-client.key', 0o600], ['tlsClientCrt', 'tls-client.crt', 0o644]] as const) {
    files[name] = join(dir, file);
    await chmod(files[name]!, mode);
  }
  const caPem = (await readFile(files['tlsCaCrt']!)).toString('latin1');
  await write('tlsCaPair', `${caPem}${caPem}`, 0o644);
  const leaf = new X509Certificate(await readFile(files['tlsClientCrt']!));
  tlsValidity = { from: Date.parse(leaf.validFrom), to: Date.parse(leaf.validTo) };
  tlsNow = tlsValidity.from + Math.floor((tlsValidity.to - tlsValidity.from) / 2);

  // Review F03, R2 on real paths: a link to the signing key, a directory to put ".." through, a
  // group-writable directory and a sticky world-writable one, each holding a copy of the key.
  files['keyLink'] = join(dir, 'relay-link.key');
  await symlink(keyFile, files['keyLink']);
  await mkdir(join(dir, 'sub'), { mode: 0o700 });
  for (const [name, mode] of [['shared', 0o770], ['sticky', 0o1777]] as const) {
    await mkdir(join(dir, name));
    await chmod(join(dir, name), mode);
    files[`${name}Key`] = join(dir, name, 'relay.key');
    await writeFile(files[`${name}Key`]!, keyPem, { mode: 0o600 });
  }
  files['sharedCert'] = join(dir, 'shared', 'tls-client.crt');
  await writeFile(files['sharedCert'], await readFile(files['tlsClientCrt']!), { mode: 0o644 });

  // Sealed files: mode 000 and not keys, so a read (EACCES) or a parse (as root) names the file.
  for (const name of ['sealedTlsKey', 'sealedCert', 'sealedCa', 'sealedKey']) await write(name, 'not a key', 0o000);
  try { accessSync(files['sealedTlsKey']!, constants.R_OK); sealedReadable = true; } catch { sealedReadable = false; }
}, 30_000);

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

  it('production requires TM8_VAULT_AGENT_RUN_AS, runs the boundary checks, and is still refused before any key file is opened (review F03)', () => {
    const url = 'https://broker.invalid:8443';
    const production = { TM8_VAULT_MODE: 'production' };
    const absent = join(dir, 'never-created');
    // Without the knob, or with a blank one: refused before any file is checked, so an absent or
    // unsafe file is not named.
    for (const extra of [production, { TM8_VAULT_MODE: ' production ' }, { ...production, TM8_VAULT_AGENT_RUN_AS: ' \t' }]) {
      expect(knobOf(urlEnv(url, extra))).toBe(AGENT_RUN_AS_KNOB);
      expect(knobOf(urlEnv(url, {
        ...extra, TM8_VAULT_RELAY_TLS_KEY_FILE: absent, TM8_VAULT_RELAY_TLS_CERT_FILE: absent,
        TM8_VAULT_RELAY_TLS_CA_FILE: absent, TM8_VAULT_RELAY_PRIVATE_KEY_FILE: files['openKey'],
      }))).toBe(AGENT_RUN_AS_KNOB);
    }
    expect(String(errorOf(urlEnv(url, production)))).toBe('VaultRelayConfigError: vault relay: TM8_VAULT_AGENT_RUN_AS is required in production '
      + '(review F03): name the uid, uid range or gVisor sandbox agent sessions run as, apart from this server');
    // The target's shape is still checked first, so a socket names the socket and no target names both.
    expect(knobOf(socketEnv(production))).toBe('TM8_VAULT_BROKER_SOCKET');
    expect(knobOf(production)).toBe('TM8_VAULT_BROKER_SOCKET');

    const withKnob = { ...production, TM8_VAULT_AGENT_RUN_AS: AGENT_RANGE };
    // With the knob, each file's metadata is checked (stat, which opens nothing) ...
    expect(knobOf(urlEnv(url, { ...withKnob, TM8_VAULT_RELAY_TLS_CA_FILE: absent }), hardenedHost())).toBe('TM8_VAULT_RELAY_TLS_CA_FILE');
    expect(knobOf(urlEnv(url, { ...withKnob, TM8_VAULT_RELAY_PRIVATE_KEY_FILE: files['openKey'] }), hardenedHost())).toBe('TM8_VAULT_RELAY_PRIVATE_KEY_FILE');
    // ... then the boundary: agents may not run as this server (R1) ...
    const own = errorOf(urlEnv(url, withKnob), hardenedHost({ uid: UID + 100001 }));
    expect(own).toBeInstanceOf(VaultBoundaryError);
    expect((own as VaultBoundaryError).failures).toEqual([{
      check: 'R1', knob: AGENT_RUN_AS_KNOB, rule: `includes this server's own uid (${UID + 100001}): agents would run as the relay and could read its keys`,
    }]);
    // ... and on the real host's view a failing check would refuse here too. With every check
    // met, production is still refused, and before any file is read: each file is sealed (mode
    // 000) and is not a key, so a read or a parse would have named it.
    const sealed = {
      ...withKnob, TM8_VAULT_RELAY_TLS_KEY_FILE: files['sealedTlsKey'], TM8_VAULT_RELAY_TLS_CERT_FILE: files['sealedCert'],
      TM8_VAULT_RELAY_TLS_CA_FILE: files['sealedCa'], TM8_VAULT_RELAY_PRIVATE_KEY_FILE: files['sealedKey'],
    };
    const reads: string[] = [];
    const locked = errorOf(urlEnv(url, sealed), hardenedHost({}, reads));
    expect([locked.name, locked.knob]).toEqual(['VaultRelayConfigError', 'TM8_VAULT_MODE']);
    expect(String(locked)).toMatch(/^VaultRelayConfigError: vault relay: TM8_VAULT_MODE production is refused \(review F03\)/);
    expect(String(locked).includes(dir)).toBe(false);
    // The boundary ran first: it read every host fact.
    expect([...new Set(reads)].sort()).toEqual(HOST_FILES);
    // Outside production the same sealed files are read, and refused by name.
    expect(knobOf(urlEnv(url, { ...sealed, TM8_VAULT_MODE: 'pre_review' }), hardenedHost()))
      .toBe(sealedReadable ? 'TM8_VAULT_RELAY_PRIVATE_KEY_FILE' : 'TM8_VAULT_RELAY_TLS_KEY_FILE');
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

describe('review F03, D5: TM8_VAULT_AGENT_RUN_AS and the boundary checks at boot', () => {
  const url = 'https://broker.invalid:8443';
  const knob = { TM8_VAULT_AGENT_RUN_AS: AGENT_RANGE };
  const realTls = (): NodeJS.ProcessEnv => ({
    TM8_VAULT_RELAY_TLS_KEY_FILE: files['tlsClientKey'], TM8_VAULT_RELAY_TLS_CERT_FILE: files['tlsClientCrt'], TM8_VAULT_RELAY_TLS_CA_FILE: files['tlsCaCrt'],
  });
  const failuresOf = (env: NodeJS.ProcessEnv, host: VaultHostView = hardenedHost()): readonly BoundaryFailure[] => {
    const error = errorOf(env, host);
    if (!(error instanceof VaultBoundaryError)) throw new Error(`expected a boundary refusal, got ${error.knob}`);
    return error.failures;
  };

  it('a malformed value refuses in every mode but off, before any file is checked', () => {
    const absent = join(dir, 'never-created');
    const message = 'VaultRelayConfigError: vault relay: TM8_VAULT_AGENT_RUN_AS must be uid:<uid>, uids:<first>-<last> or gvisor:<first>-<last>, '
      + 'in decimal uids from 1 to 4294967294 (review F03)';
    for (const value of ['uid:0', 'uids:5-4', 'tm8-agent', `uid:${UID}`.replace('uid:', 'uid: '), 'uid:1001,1002']) {
      for (const mode of ['dev', 'pre_review']) {
        expect([value, mode, String(errorOf(socketEnv({ TM8_VAULT_MODE: mode, TM8_VAULT_AGENT_RUN_AS: value, TM8_VAULT_RELAY_PRIVATE_KEY_FILE: absent })))])
          .toEqual([value, mode, message]);
      }
      expect(String(errorOf(urlEnv(url, {
        TM8_VAULT_MODE: 'production', TM8_VAULT_AGENT_RUN_AS: value, TM8_VAULT_RELAY_TLS_KEY_FILE: absent, TM8_VAULT_RELAY_PRIVATE_KEY_FILE: absent,
      })))).toBe(message);
      expect(vaultRelayConfigFromEnv({ TM8_VAULT_MODE: 'off', TM8_VAULT_AGENT_RUN_AS: value })).toBeNull();
    }
  });

  it('without the knob, outside production, the host is never consulted and boot is unchanged', () => {
    const trap = new Proxy({} as VaultHostView, {
      get: (_target, name) => () => { throw new Error(`the host view was consulted: ${String(name)}`); },
    });
    for (const env of [socketEnv(), socketEnv({ TM8_VAULT_MODE: 'dev' }), urlEnv(url), urlEnv(url, { TM8_VAULT_MODE: 'dev', ...realTls() })]) {
      expect(knobOf(env, trap)).toBe('accepted');
    }
    // A blank knob is no knob.
    expect(knobOf(socketEnv({ TM8_VAULT_AGENT_RUN_AS: '  ' }), trap)).toBe('accepted');
  });

  it('a hardened host is accepted over the socket and over mutual TLS, and the checks read /etc and /proc, never a key file', () => {
    for (const mode of ['dev', 'pre_review']) {
      const reads: string[] = [];
      expect(knobOf(socketEnv({ TM8_VAULT_MODE: mode, ...knob }), hardenedHost({}, reads))).toBe('accepted');
      expect([...new Set(reads)].sort()).toEqual(HOST_FILES);
      const tlsReads: string[] = [];
      const config = vaultRelayConfigFromEnv(urlEnv(url, { TM8_VAULT_MODE: mode, ...knob, ...realTls() }), hardenedHost({}, tlsReads))!;
      expect([config.mode, config.broker.kind]).toEqual([mode, 'mtls']);
      expect([...new Set(tlsReads)].sort()).toEqual(HOST_FILES);
    }
    // Each variant of the knob (the owner's decision D2) is checked the same way; gVisor skips the
    // mount check, because each sandbox has its own /proc.
    for (const value of [`uid:${UID + 100001}`, `gvisor:${UID + 200000}-${UID + 265535}`]) {
      const reads: string[] = [];
      expect(knobOf(urlEnv(url, { TM8_VAULT_AGENT_RUN_AS: value, ...realTls() }), hardenedHost({}, reads))).toBe('accepted');
      expect(reads.includes('/proc/self/mountinfo')).toBe(!value.startsWith('gvisor:'));
    }
  });

  it('with the knob, a host that fails is refused in every mode, every failure named, and no key content in the message', () => {
    const exposed = hardenedHost({
      gids: [UID, 999],
      text: {
        '/proc/self/mountinfo': PROC_HIDDEN.replace(',hidepid=invisible', ''),
        '/proc/self/limits': limitsText('0', 'unlimited'),
        '/proc/sys/kernel/core_pattern': '|/usr/share/apport/apport -p%p -s%s -c%c -d%d -P%P -u%u -g%g -- %E\n',
      },
      writable: ['/run/docker.sock'],
    });
    for (const mode of ['dev', 'pre_review']) {
      for (const env of [socketEnv({ TM8_VAULT_MODE: mode, ...knob }), urlEnv(url, { TM8_VAULT_MODE: mode, ...knob, ...realTls() })]) {
        const error = errorOf(env, exposed);
        expect(error).toBeInstanceOf(VaultBoundaryError);
        expect((error as VaultBoundaryError).failures.map((failure) => failure.check)).toEqual(['R3', 'R3', 'R5', 'R6', 'R6']);
        expect(error.knob).toBe(AGENT_RUN_AS_KNOB);
        expect(error.message.startsWith('vault relay: refused (review F03 agent boundary): '
          + 'R3 TM8_VAULT_AGENT_RUN_AS cannot be met while this server is in the docker group (gid 999); '
          + 'R3 TM8_VAULT_AGENT_RUN_AS cannot be met while this server can connect to "/run/docker.sock"; ')).toBe(true);
        for (const text of ['BEGIN', 'PRIVATE', keyPem.split('\n')[1]!, dir]) expect(error.message.includes(text)).toBe(false);
      }
    }
  });

  it('R2 on real files: a link, a ".." or a group-writable directory is refused, a sticky directory is not', () => {
    const signing = (path: string) => socketEnv({ ...knob, TM8_VAULT_RELAY_PRIVATE_KEY_FILE: path });
    const canonical = 'must be a canonical path with no symbolic link, "." or ".." in it';
    const r2 = (fileKnob: string, rule: string) => [{ check: 'R2', knob: fileKnob, rule }];
    // The link and the ".." path both stat as the real, owner-only key: only R2 tells them apart.
    expect(knobOf(signing(keyFile), hardenedHost())).toBe('accepted');
    expect(failuresOf(signing(files['keyLink']!))).toEqual(r2('TM8_VAULT_RELAY_PRIVATE_KEY_FILE', canonical));
    expect(failuresOf(signing(`${dir}/sub/../relay.key`))).toEqual(r2('TM8_VAULT_RELAY_PRIVATE_KEY_FILE', canonical));
    expect(failuresOf(signing(`${dir}//relay.key`))).toEqual(r2('TM8_VAULT_RELAY_PRIVATE_KEY_FILE', canonical));
    const shared = `is under a directory that group or others can write: ${JSON.stringify(join(dir, 'shared'))}`;
    expect(failuresOf(signing(files['sharedKey']!))).toEqual(r2('TM8_VAULT_RELAY_PRIVATE_KEY_FILE', shared));
    expect(knobOf(signing(files['stickyKey']!), hardenedHost())).toBe('accepted');
    // Over mutual TLS the certificate and the CA are checked too, not only the keys.
    expect(failuresOf(urlEnv(url, { ...knob, ...realTls(), TM8_VAULT_RELAY_TLS_CERT_FILE: files['sharedCert'] })))
      .toEqual(r2('TM8_VAULT_RELAY_TLS_CERT_FILE', shared));
    // ... and the signing key as well, which a socket target checks alone: it reads no TLS file.
    expect(knobOf(urlEnv(url, { ...knob, ...realTls(), TM8_VAULT_RELAY_PRIVATE_KEY_FILE: files['sharedKey'] }), hardenedHost())).toBe('TM8_VAULT_RELAY_PRIVATE_KEY_FILE');
    expect(knobOf(socketEnv({ ...knob, ...realTls(), TM8_VAULT_RELAY_TLS_CERT_FILE: files['sharedCert'] }), hardenedHost())).toBe('accepted');
  });

  it('R8 at boot: a leaf client certificate that matches its key, inside its validity, and a CA file of one CA certificate', () => {
    const r8 = (fileKnob: string, rule: string) => ({ check: 'R8', knob: fileKnob, rule });
    const tls = (patch: NodeJS.ProcessEnv, host?: VaultHostView) => failuresOf(urlEnv(url, { ...knob, ...realTls(), ...patch }), host);
    // The default fixtures are not TLS material: accepted without the knob (they are parsed at connect time), refused with it.
    expect(knobOf(urlEnv(url))).toBe('accepted');
    expect(failuresOf(urlEnv(url, knob))).toEqual([
      r8('TM8_VAULT_RELAY_TLS_KEY_FILE', 'is not an unencrypted PEM private key'),
      r8('TM8_VAULT_RELAY_TLS_CERT_FILE', 'is not a certificate'),
      r8('TM8_VAULT_RELAY_TLS_CA_FILE', 'must hold exactly one PEM block, a certificate (it holds 0 certificates and 0 other PEM blocks)'),
    ]);
    expect(tls({ TM8_VAULT_RELAY_TLS_KEY_FILE: files['tlsRealKey'] })).toEqual([r8('TM8_VAULT_RELAY_TLS_CERT_FILE', 'does not match TM8_VAULT_RELAY_TLS_KEY_FILE')]);
    expect(tls({ TM8_VAULT_RELAY_TLS_CA_FILE: files['tlsClientCrt'] })).toEqual([r8('TM8_VAULT_RELAY_TLS_CA_FILE', 'holds a certificate that is not a CA')]);
    expect(tls({ TM8_VAULT_RELAY_TLS_CA_FILE: files['tlsCaPair'] }))
      .toEqual([r8('TM8_VAULT_RELAY_TLS_CA_FILE', 'must hold exactly one PEM block, a certificate (it holds 2 certificates and 0 other PEM blocks)')]);
    expect(tls({}, hardenedHost({ now: tlsValidity.to + 1 }))).toEqual([r8('TM8_VAULT_RELAY_TLS_CERT_FILE', 'has expired')]);
    expect(tls({}, hardenedHost({ now: tlsValidity.from - 1 }))).toEqual([r8('TM8_VAULT_RELAY_TLS_CERT_FILE', 'is not valid yet')]);
    for (const now of [tlsValidity.from, tlsValidity.to]) {
      expect(knobOf(urlEnv(url, { ...knob, ...realTls() }), hardenedHost({ now }))).toBe('accepted');
    }
  });

  it('R7 runs before R8: a retired key is named even when the TLS files would fail R8', () => {
    const signing = publicKeySha256(createPrivateKey(keyPem));
    expect(String(errorOf(urlEnv(url, { ...knob, TM8_VAULT_RETIRED_KEY_SHA256: signing }), hardenedHost())))
      .toBe('VaultRelayConfigError: vault relay: TM8_VAULT_RELAY_PRIVATE_KEY_FILE is a retired key (TM8_VAULT_RETIRED_KEY_SHA256, review F03 R7)');
    expect(String(errorOf(urlEnv(url, { ...knob, TM8_VAULT_RETIRED_KEY_SHA256: 'ab'.repeat(32) }), hardenedHost())))
      .toBe('VaultRelayConfigError: vault relay: TM8_VAULT_RELAY_TLS_KEY_FILE is not an unencrypted PEM private key, '
        + 'so it cannot be checked against TM8_VAULT_RETIRED_KEY_SHA256');
    // And a listed TLS client key that R8 would accept is still refused.
    const tls = publicKeySha256(createPrivateKey(readFileSync(files['tlsClientKey']!, 'utf8')));
    expect(knobOf(urlEnv(url, { ...knob, ...realTls(), TM8_VAULT_RETIRED_KEY_SHA256: tls }), hardenedHost())).toBe('TM8_VAULT_RELAY_TLS_KEY_FILE');
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
