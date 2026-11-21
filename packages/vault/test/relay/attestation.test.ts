import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ATTESTATION_DEFAULT_TTL_SECONDS,
  ATTESTATION_MAX_HEADER_CHARS,
  AttestationError,
  AttestationTooLargeError,
  AttestationVerifier,
  VAULT_ATTESTATION_HEADER,
  exportAttestationKeyPair,
  generateAttestationKeyPair,
  loadAttestationPrivateKey,
  loadAttestationPublicKey,
  signAttestation,
  type AttestedRequest,
  type VaultCaller,
} from '../../src/index.js';
import { FixedClock, T0, agentOf, makeCaller, testCaller } from '../support/kit.js';

/**
 * The wire format, written out here by hand so that a change to it fails a
 * test: the relay and the broker deploy separately, and a silent format change
 * would lock every caller out.
 */
const SIGNING_PREFIX = 'tm8-vault-attest|v1|';

const REQUEST: AttestedRequest = { method: 'POST', path: '/v2/vault/items', query: 'limit=2', body: '{"name":"Test item"}' };

function signRaw(privateKey: KeyObject, claims: unknown, prefix = SIGNING_PREFIX): string {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${payload}.${sign(null, Buffer.from(prefix + payload, 'ascii'), privateKey).toString('base64url')}`;
}

function decodeClaims(header: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(header.split('.')[0]!, 'base64url').toString('utf8')) as Record<string, unknown>;
}

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof AttestationError) return error.code;
    throw error;
  }
  return 'accepted';
}

describe('relay attestation', () => {
  let keys: { privateKey: KeyObject; publicKey: KeyObject };
  let relayClock: FixedClock;
  let brokerClock: FixedClock;
  let verifier: AttestationVerifier;

  beforeEach(() => {
    keys = generateAttestationKeyPair();
    relayClock = new FixedClock(T0);
    brokerClock = new FixedClock(T0);
    verifier = new AttestationVerifier(keys.publicKey, { clock: brokerClock });
  });

  const attest = (caller: VaultCaller = testCaller, request: AttestedRequest = REQUEST, ttlSeconds?: number) =>
    signAttestation({ privateKey: keys.privateKey, caller, request, clock: relayClock, ...(ttlSeconds === undefined ? {} : { ttlSeconds }) });
  const rawClaims = (overrides: Record<string, unknown> = {}) => {
    const iat = Math.floor(relayClock.now().getTime() / 1000);
    return {
      v: 1, rid: randomUUID(), iat, exp: iat + 15, method: REQUEST.method, path: REQUEST.path, query: REQUEST.query,
      bodySha256: createHash('sha256').update(REQUEST.body).digest('hex'),
      caller: { kind: 'member', memberId: testCaller.memberId, spaceId: testCaller.spaceId, sessionId: null, name: testCaller.name, isSpaceAdmin: true, ip: testCaller.ip },
      ...overrides,
    };
  };

  it('names the header the relay sends', () => {
    expect(VAULT_ATTESTATION_HEADER).toBe('x-tm8-vault-caller');
  });

  it('round-trips exactly the caller, for a member and for an agent', () => {
    expect(verifier.verify(attest(), REQUEST)).toEqual({ ...testCaller });
    const agent = agentOf(testCaller, randomUUID());
    const result = verifier.verify(attest(agent), REQUEST);
    expect(result).toEqual({ ...agent });
    expect(Object.keys(result).sort()).toEqual(['ip', 'isSpaceAdmin', 'kind', 'memberId', 'name', 'sessionId', 'spaceId']);
  });

  it('carries only the documented claims, and lives 15 seconds by default', () => {
    const claims = decodeClaims(attest());
    expect(Object.keys(claims).sort()).toEqual(['bodySha256', 'caller', 'exp', 'iat', 'method', 'path', 'query', 'rid', 'v']);
    expect(claims).toMatchObject({ v: 1, iat: Date.parse(T0) / 1000, exp: Date.parse(T0) / 1000 + ATTESTATION_DEFAULT_TTL_SECONDS });
    expect(claims.bodySha256).toBe(createHash('sha256').update(REQUEST.body).digest('hex'));
  });

  it('accepts a header built by hand from the documented format', () => {
    expect(verifier.verify(signRaw(keys.privateKey, rawClaims()), REQUEST)).toEqual({ ...testCaller });
  });

  it('returns ids lowercase and keys the replay check on the lowercase request id', () => {
    const rid = randomUUID();
    const upper = rawClaims({ rid: rid.toUpperCase(), caller: { ...rawClaims().caller, memberId: testCaller.memberId.toUpperCase(), spaceId: testCaller.spaceId.toUpperCase(), sessionId: rid.toUpperCase() } });
    expect(verifier.verify(signRaw(keys.privateKey, upper), REQUEST)).toMatchObject({ memberId: testCaller.memberId, spaceId: testCaller.spaceId, sessionId: rid });
    expect(code(() => verifier.verify(signRaw(keys.privateKey, { ...upper, rid }), REQUEST))).toBe('replayed');
  });

  it('is single-use', () => {
    const header = attest();
    verifier.verify(header, REQUEST);
    expect(code(() => verifier.verify(header, REQUEST))).toBe('replayed');
    expect(verifier.replayEntries).toBe(1);
  });

  it('binds method, path, query and the exact body bytes, and a mismatch does not burn the header', () => {
    const header = attest();
    for (const other of [
      { ...REQUEST, method: 'PATCH' },
      { ...REQUEST, path: '/v2/vault/items/other' },
      { ...REQUEST, query: 'limit=3' },
      { ...REQUEST, query: '' },
      { ...REQUEST, body: '{"name":"Test item" }' },
      { ...REQUEST, body: '' },
    ]) {
      expect(code(() => verifier.verify(header, other))).toBe('request_mismatch');
    }
    expect(verifier.verify(header, { ...REQUEST, body: Buffer.from(REQUEST.body as string) })).toEqual({ ...testCaller });
    const bytes = new Uint8Array(Buffer.from(REQUEST.body as string));
    expect(verifier.verify(attest(), { ...REQUEST, body: bytes })).toEqual({ ...testCaller });
    const get: AttestedRequest = { method: 'GET', path: '/v2/vault/items', query: '', body: '' };
    expect(verifier.verify(attest(testCaller, get), { ...get, body: Buffer.alloc(0) })).toEqual({ ...testCaller });
  });

  it('refuses a header from another key, an edited payload, or a signature without the domain prefix', () => {
    const other = generateAttestationKeyPair();
    expect(code(() => verifier.verify(signAttestation({ privateKey: other.privateKey, caller: testCaller, request: REQUEST, clock: relayClock }), REQUEST))).toBe('bad_signature');
    const [payload, signature] = attest().split('.') as [string, string];
    const edited = Buffer.from(JSON.stringify({ ...decodeClaims(`${payload}.x`), caller: { ...(decodeClaims(`${payload}.x`).caller as object), isSpaceAdmin: false } })).toString('base64url');
    expect(code(() => verifier.verify(`${edited}.${signature}`, REQUEST))).toBe('bad_signature');
    expect(code(() => verifier.verify(signRaw(keys.privateKey, rawClaims(), ''), REQUEST))).toBe('bad_signature');
    expect(code(() => verifier.verify(signRaw(keys.privateKey, rawClaims(), 'tm8-vault-attest|v2|'), REQUEST))).toBe('bad_signature');
  });

  it('refuses a malformed or malleable header before checking anything else', () => {
    const header = attest();
    const [payload, signature] = header.split('.') as [string, string];
    // The last character of a 64-byte signature carries 4 unused bits: flipping one decodes to the same bytes.
    // The base64url alphabet, by index: a byte i << 2 encodes to alphabet[i] first.
    const alphabet = Array.from({ length: 64 }, (_, index) => Buffer.from([index << 2]).toString('base64url')[0]).join('');
    const malleable = signature.slice(0, -1) + alphabet[alphabet.indexOf(signature.at(-1)!) + 1];
    expect(Buffer.compare(Buffer.from(malleable, 'base64url'), Buffer.from(signature, 'base64url'))).toBe(0);
    const truncated = sign(null, Buffer.from(SIGNING_PREFIX + payload, 'ascii'), keys.privateKey).subarray(0, 63).toString('base64url');
    expect(code(() => verifier.verify(undefined, REQUEST))).toBe('missing');
    expect(code(() => verifier.verify('', REQUEST))).toBe('missing');
    for (const bad of [
      [header], [header, header], payload, `${header}.x`, `${payload}.${malleable}`, `${payload}=.${signature}`,
      `${payload.replace(/-/g, '+')}+.${signature}`, `${payload}.${truncated}`, `.${signature}`, `${payload}.`,
      `${payload}.${signature}${'A'.repeat(4096)}`, ` ${header}`,
    ]) {
      expect(code(() => verifier.verify(bad, REQUEST))).toBe('malformed');
    }
    expect(verifier.verify(header, REQUEST)).toEqual({ ...testCaller });
  });

  it('refuses signed claims the schema refuses', () => {
    const base = rawClaims();
    for (const claims of [
      { ...base, extra: true },
      { ...base, v: 2 },
      { ...base, path: '/v1/vault/items' },
      { ...base, path: '/v2/vault/items?x=1' },
      { ...base, rid: 'not-a-uuid' },
      { ...base, method: 'HEAD' },
      { ...base, iat: base.iat + 0.5 },
      { ...base, caller: { ...base.caller, kind: 'system' } },
      { ...base, caller: { ...base.caller, extra: 'must-not-pass' } },
      { ...base, caller: { ...base.caller, name: 'x'.repeat(201) } },
    ]) {
      expect(code(() => verifier.verify(signRaw(keys.privateKey, claims), REQUEST))).toBe('malformed');
    }
    const notJson = Buffer.from('{"v":1,').toString('base64url');
    expect(code(() => verifier.verify(`${notJson}.${sign(null, Buffer.from(SIGNING_PREFIX + notJson, 'ascii'), keys.privateKey).toString('base64url')}`, REQUEST))).toBe('malformed');
  });

  it('honours the lifetime with five seconds of skew either way', () => {
    // Signed at T0, 15 s TTL: good until 19.999 s after T0, refused from 20 s. Times are
    // whole seconds, floored: a broker 5.001 s behind reads as 6 s behind, so it refuses.
    for (const [offsetMs, expected] of [[0, 'accepted'], [19_999, 'accepted'], [20_000, 'expired'], [-5_000, 'accepted'], [-5_001, 'not_yet_valid']] as const) {
      brokerClock.set(new Date(Date.parse(T0) + offsetMs).toISOString());
      expect(code(() => verifier.verify(attest(), REQUEST)), `broker at ${offsetMs} ms`).toBe(expected);
    }
    // A relay clock 6 s ahead of the broker is refused; 5 s is accepted.
    brokerClock.set(T0);
    relayClock.set(new Date(Date.parse(T0) + 6_000).toISOString());
    expect(code(() => verifier.verify(attest(), REQUEST))).toBe('not_yet_valid');
    relayClock.set(new Date(Date.parse(T0) + 5_000).toISOString());
    expect(code(() => verifier.verify(attest(), REQUEST))).toBe('accepted');
  });

  it('keeps every header within the cap: the relay refuses to sign a longer one and the broker refuses to read it', () => {
    const long: AttestedRequest = { ...REQUEST, query: `cursor=${'q'.repeat(3000)}` };
    expect(() => attest(testCaller, long)).toThrow(AttestationTooLargeError);
    const fits: AttestedRequest = { ...REQUEST, query: `cursor=${'q'.repeat(1500)}` };
    expect(verifier.verify(attest(testCaller, fits), fits)).toEqual({ ...testCaller });
    // Validly signed and schema-valid, but over the cap: refused before the signature is checked.
    const oversized = signRaw(keys.privateKey, rawClaims({ query: long.query }));
    expect(oversized.length).toBeGreaterThan(ATTESTATION_MAX_HEADER_CHARS);
    expect(code(() => verifier.verify(oversized, long))).toBe('malformed');
  });

  it('refuses a lifetime over 30 seconds, or none, even when signed', () => {
    const base = rawClaims();
    expect(code(() => verifier.verify(signRaw(keys.privateKey, { ...base, exp: base.iat + 31 }), REQUEST))).toBe('ttl_too_long');
    expect(code(() => verifier.verify(signRaw(keys.privateKey, { ...base, rid: randomUUID(), exp: base.iat }), REQUEST))).toBe('ttl_too_long');
    expect(code(() => verifier.verify(signRaw(keys.privateKey, { ...base, rid: randomUUID(), exp: base.iat + 30 }), REQUEST))).toBe('accepted');
    expect(code(() => verifier.verify(attest(testCaller, REQUEST, 30), REQUEST))).toBe('accepted');
  });

  it('the relay refuses to sign what the broker would refuse', () => {
    for (const ttlSeconds of [0, 31, 1.5, -1]) expect(() => attest(testCaller, REQUEST, ttlSeconds)).toThrow(TypeError);
    for (const request of [
      { ...REQUEST, path: '/v2/other' }, { ...REQUEST, path: '/v2/vault/a b' }, { ...REQUEST, path: '/v2/vault/items?x=1' },
      { ...REQUEST, query: 'a#b' }, { ...REQUEST, method: 'HEAD' },
    ]) {
      expect(() => attest(testCaller, request)).toThrow(TypeError);
    }
    for (const caller of [makeCaller({ memberId: 'not-a-uuid' }), makeCaller({ name: 'x'.repeat(201) }), makeCaller({ kind: 'system' as VaultCaller['kind'] })]) {
      expect(() => attest(caller)).toThrow(TypeError);
    }
  });

  it('accepts Ed25519 keys of the right half only, and round-trips them through PEM', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(() => signAttestation({ privateKey: keys.publicKey, caller: testCaller, request: REQUEST })).toThrow(TypeError);
    expect(() => signAttestation({ privateKey: rsa.privateKey, caller: testCaller, request: REQUEST })).toThrow(TypeError);
    expect(() => new AttestationVerifier(keys.privateKey)).toThrow(TypeError);
    expect(() => new AttestationVerifier(rsa.publicKey)).toThrow(TypeError);
    const pem = exportAttestationKeyPair(keys);
    // PKCS#8 and SPKI labels. The private label is split so no key-shaped text sits in the source.
    expect(pem.privatePem.split('\n')[0]).toBe(`-----BEGIN ${'PRIVATE'} KEY-----`);
    expect(pem.publicPem.split('\n')[0]).toBe('-----BEGIN PUBLIC KEY-----');
    const relayKey = loadAttestationPrivateKey(pem.privatePem);
    const brokerVerifier = new AttestationVerifier(loadAttestationPublicKey(pem.publicPem), { clock: brokerClock });
    expect(brokerVerifier.verify(signAttestation({ privateKey: relayKey, caller: testCaller, request: REQUEST, clock: relayClock }), REQUEST)).toEqual({ ...testCaller });
    expect(() => loadAttestationPrivateKey(rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }))).toThrow(TypeError);
    expect(() => loadAttestationPublicKey(rsa.publicKey.export({ type: 'spki', format: 'pem' }))).toThrow(TypeError);
  });

  it('refuses when the replay cache is full of live entries, and recovers once they lapse', () => {
    const small = new AttestationVerifier(keys.publicKey, { clock: brokerClock, maxReplayEntries: 2 });
    small.verify(attest(), REQUEST);
    small.verify(attest(), REQUEST);
    const third = attest();
    expect(code(() => small.verify(third, REQUEST))).toBe('replay_cache_full');
    expect(small.replayEntries).toBe(2);
    brokerClock.set(new Date(Date.parse(T0) + 20_000).toISOString());
    relayClock.set(brokerClock.iso());
    expect(code(() => small.verify(third, REQUEST))).toBe('expired');
    expect(code(() => small.verify(attest(), REQUEST))).toBe('accepted');
    expect(small.replayEntries).toBe(1);
  });

  it('a full cache sweeps every lapsed entry, not only those before the first live one', () => {
    const small = new AttestationVerifier(keys.publicKey, { clock: brokerClock, maxReplayEntries: 2 });
    small.verify(attest(testCaller, REQUEST, 30), REQUEST); // lapses at +35 s
    small.verify(attest(testCaller, REQUEST, 1), REQUEST); // lapses at +6 s, but sits behind the live one
    brokerClock.set(new Date(Date.parse(T0) + 6_000).toISOString());
    relayClock.set(brokerClock.iso());
    expect(code(() => small.verify(attest(), REQUEST))).toBe('accepted');
    expect(small.replayEntries).toBe(2);
  });
});
