import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MAX_RETIRED_KEYS, RETIRED_KEY_KNOB, parseRetiredKeys, publicKeySha256 } from '../../src/relay/retired-keys.js';
import * as relay from '../../src/relay/index.js';

const hex = (byte: string) => byte.repeat(32);
const pairs = (byte: string) => Array.from({ length: 32 }, () => byte).join(':');

describe('retired-key denylist parsing (review F03, R7 and B2)', () => {
  it('is the empty list when unset or blank: it ships empty', () => {
    for (const value of [undefined, '', '   ', '\t\n']) expect(parseRetiredKeys(value)).toEqual(new Set());
    expect(RETIRED_KEY_KNOB).toBe('TM8_VAULT_RETIRED_KEY_SHA256');
    // The relay links the same parser through @tm8/vault/relay.
    expect(relay.parseRetiredKeys).toBe(parseRetiredKeys);
    expect(relay.publicKeySha256).toBe(publicKeySha256);
  });

  it('takes 64 hex digits or 32 colon pairs in either case, trims each entry and stores lowercase hex', () => {
    expect(parseRetiredKeys(hex('ab'))).toEqual(new Set([hex('ab')]));
    expect(parseRetiredKeys(` ${hex('AB')} , ${pairs('cD')} `)).toEqual(new Set([hex('ab'), hex('cd')]));
    // The same key twice, in two spellings, is one entry.
    expect(parseRetiredKeys(`${hex('ef')},${pairs('EF')}`)).toEqual(new Set([hex('ef')]));
  });

  it.each([
    ['63 digits', hex('ab').slice(1)],
    ['65 digits', `${hex('ab')}a`],
    ['not hex', hex('zz')],
    ['an empty entry after a comma', `${hex('ab')},`],
    ['an empty entry between commas', `${hex('ab')},,${hex('cd')}`],
    ['a lone comma', ','],
    ['a space-separated list', `${hex('ab')} ${hex('cd')}`],
    ['a semicolon-separated list', `${hex('ab')};${hex('cd')}`],
    ['pairs that are not 32', pairs('ab').slice(3)],
    ['digits not in pairs', `AB${':AB'.repeat(29)}:ABAB`],
    ['an openssl label', `SHA256 Fingerprint=${pairs('AB')}`],
    ['a sha256sum line', `${hex('ab')}  -`],
    ['a base64 digest', Buffer.alloc(32, 0xab).toString('base64')],
  ])('refuses %s, so a typo never drops an entry unseen', (_name, value) => {
    expect(parseRetiredKeys(value)).toBeNull();
  });

  it(`holds at most ${MAX_RETIRED_KEYS} entries and refuses more, and an overlong value before it splits`, () => {
    const entries = Array.from({ length: MAX_RETIRED_KEYS + 1 }, (_, i) => createHash('sha256').update(String(i)).digest('hex'));
    expect(parseRetiredKeys(entries.slice(0, MAX_RETIRED_KEYS).join(','))?.size).toBe(MAX_RETIRED_KEYS);
    expect(parseRetiredKeys(entries.join(','))).toBeNull();
    // Two valid entries: padding inside the value is trimmed per entry, until the whole value is too long.
    expect(parseRetiredKeys(`${hex('ab')},${' '.repeat(1000)}${hex('cd')}`)?.size).toBe(2);
    expect(parseRetiredKeys(`${hex('ab')},${' '.repeat(MAX_RETIRED_KEYS * 100)}${hex('cd')}`)).toBeNull();
  });
});

describe('retired-key fingerprints', () => {
  let dir: string | undefined;
  afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

  it('is the SHA-256 of the DER SubjectPublicKeyInfo, the same from the private and the public half', () => {
    // Throwaway keys generated at runtime; none is a deployed key.
    for (const pair of [generateKeyPairSync('ed25519'), generateKeyPairSync('rsa', { modulusLength: 2048 }), generateKeyPairSync('ec', { namedCurve: 'P-256' })]) {
      const expected = createHash('sha256').update(pair.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
      expect(publicKeySha256(pair.privateKey)).toBe(expected);
      expect(publicKeySha256(pair.publicKey)).toBe(expected);
      expect(publicKeySha256(createPublicKey(pair.privateKey))).toBe(expected);
      expect(expected).toMatch(/^[0-9a-f]{64}$/);
    }
    const [one, two] = [generateKeyPairSync('ed25519'), generateKeyPairSync('ed25519')];
    expect(publicKeySha256(one.privateKey)).not.toBe(publicKeySha256(two.privateKey));
  });

  it('matches the openssl commands the operator is told to run (relay/retired-keys.ts)', async () => {
    dir = await mkdtemp(join(tmpdir(), 'vault-retired-'));
    const pair = generateKeyPairSync('ed25519');
    await writeFile(join(dir, 'relay.key'), pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    await writeFile(join(dir, 'relay.pub'), pair.publicKey.export({ type: 'spki', format: 'pem' }));
    const digest = (der: Buffer) => createHash('sha256').update(der).digest('hex');
    const fromPrivate = execFileSync('openssl', ['pkey', '-in', join(dir, 'relay.key'), '-pubout', '-outform', 'DER'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const fromPublic = execFileSync('openssl', ['pkey', '-pubin', '-in', join(dir, 'relay.pub'), '-outform', 'DER'], { stdio: ['ignore', 'pipe', 'ignore'] });
    expect(digest(fromPrivate)).toBe(publicKeySha256(pair.privateKey));
    expect(digest(fromPublic)).toBe(publicKeySha256(pair.privateKey));
    expect(parseRetiredKeys(digest(fromPrivate))).toEqual(new Set([publicKeySha256(pair.publicKey)]));
  });
});
