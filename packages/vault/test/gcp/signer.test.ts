import { createHash, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { KmsRefusedError, KmsUnavailableError } from '../../src/crypto/kms.js';
import { crc32c } from '../../src/gcp/crc32c.js';
import { KmsCheckpointSigner, type CheckpointKeyAlgorithm } from '../../src/gcp/signer.js';
import { expectSanitized, fakeToken, json, keyVersionName, loopbackSuite, rejected, tokens } from './fake.js';

describe('KmsCheckpointSigner', () => {
  const fake = loopbackSuite();
  const message = () => Buffer.from('test-only checkpoint chain head');
  const algorithms: CheckpointKeyAlgorithm[] = ['EC_SIGN_ED25519', 'EC_SIGN_P256_SHA256'];

  async function signerFake(algorithm: CheckpointKeyAlgorithm) {
    const pair = algorithm === 'EC_SIGN_ED25519'
      ? generateKeyPairSync('ed25519')
      : generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const state = {
      algorithm: algorithm as string, pem, pemCrc32c: String(crc32c(Buffer.from(pem))),
      publicPatch: {} as Record<string, unknown>, signPatch: {} as Record<string, unknown>,
      signingKey: pair.privateKey as KeyObject, status: 200,
    };
    const server = await fake((req, res) => {
      if (state.status !== 200) { json(res, { error: fakeToken }, state.status); return; }
      if (req.method === 'GET' && req.url.pathname === `/v1/${keyVersionName}/publicKey`) {
        json(res, { pem: state.pem, pemCrc32c: state.pemCrc32c, algorithm: state.algorithm, name: keyVersionName, ...state.publicPatch });
        return;
      }
      if (req.url.pathname !== `/v1/${keyVersionName}:asymmetricSign` || req.method !== 'POST') { json(res, {}, 404); return; }
      const body = req.json();
      const ed25519 = algorithm === 'EC_SIGN_ED25519';
      const received = Buffer.from(ed25519 ? body.data as string : (body.digest as { sha256: string }).sha256, 'base64');
      if (String(crc32c(received)) !== (ed25519 ? body.dataCrc32c : body.digestCrc32c)) { json(res, {}, 400); return; }
      // Node hashes the original message for P-256, equivalent to KMS signing its supplied SHA-256 digest.
      if (!ed25519 && !received.equals(createHash('sha256').update(message()).digest())) { json(res, {}, 400); return; }
      const signature = sign(ed25519 ? null : 'sha256', ed25519 ? received : message(), state.signingKey);
      json(res, {
        name: keyVersionName, signature: signature.toString('base64'), signatureCrc32c: String(crc32c(signature)),
        ...(ed25519 ? { verifiedDataCrc32c: true } : { verifiedDigestCrc32c: true }), ...state.signPatch,
      });
    });
    return {
      server, state, pem, publicKey: pair.publicKey,
      connect: () => KmsCheckpointSigner.connect({ keyVersionName, kmsBaseUrl: server.baseUrl, tokens }),
    };
  }

  it.each(algorithms)('signs and locally verifies %s, exposes the public verifier', async (algorithm) => {
    const fixture = await signerFake(algorithm);
    const signer = await fixture.connect();
    expect(signer.keyId).toBe(keyVersionName);
    expect(signer.publicKey()).toEqual({ pem: fixture.pem, algorithm });
    const signature = await signer.sign(message());
    expect(verify(algorithm === 'EC_SIGN_ED25519' ? null : 'sha256', message(), fixture.publicKey, signature)).toBe(true);
    const sent = fixture.server.requests[1]!.json();
    if (algorithm === 'EC_SIGN_ED25519') {
      expect(sent).toEqual({ data: message().toString('base64'), dataCrc32c: String(crc32c(message())) });
    } else {
      const digest = createHash('sha256').update(message()).digest();
      expect(sent).toEqual({ digest: { sha256: digest.toString('base64') }, digestCrc32c: String(crc32c(digest)) });
    }
    for (const req of fixture.server.requests) expect(req.headers.authorization).toBe(`Bearer ${fakeToken}`);
    const exposed = signer.publicKey();
    exposed.pem = 'changed by caller';
    expect(signer.publicKey().pem).toBe(fixture.pem);
  });

  it.each(['RSA_SIGN_PSS_2048_SHA256', 'EC_SIGN_P384_SHA384', '', undefined])('rejects unsupported algorithm %s', async (algorithm) => {
    const fixture = await signerFake('EC_SIGN_ED25519');
    fixture.state.publicPatch.algorithm = algorithm;
    const error = await rejected(fixture.connect());
    expect(error).toBeInstanceOf(KmsRefusedError);
    expectSanitized(error);
  });

  it.each(['1', undefined, null, -1, 0x100000000])('rejects corrupt or absent pemCrc32c (%s)', async (checksum) => {
    const fixture = await signerFake('EC_SIGN_ED25519');
    fixture.state.publicPatch.pemCrc32c = checksum;
    const error = await rejected(fixture.connect());
    expect(error).toBeInstanceOf(KmsUnavailableError);
    expectSanitized(error);
  });

  it('rejects an invalid PEM despite a matching CRC and never exposes its contents', async () => {
    const fixture = await signerFake('EC_SIGN_ED25519');
    fixture.state.pem = fakeToken;
    fixture.state.pemCrc32c = String(crc32c(Buffer.from(fakeToken)));
    const error = await rejected(fixture.connect());
    expect(error).toBeInstanceOf(KmsUnavailableError);
    expectSanitized(error);
  });

  it.each(algorithms)('rejects a public key inconsistent with %s', async (algorithm) => {
    const fixture = await signerFake(algorithm);
    const wrong = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
    fixture.state.pem = wrong.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    fixture.state.pemCrc32c = String(crc32c(Buffer.from(fixture.state.pem)));
    expect(await rejected(fixture.connect())).toBeInstanceOf(KmsUnavailableError);
  });

  it.each(algorithms)('rejects every missing or corrupted signature integrity field for %s', async (algorithm) => {
    const fixture = await signerFake(algorithm);
    const signer = await fixture.connect();
    const flag = algorithm === 'EC_SIGN_ED25519' ? 'verifiedDataCrc32c' : 'verifiedDigestCrc32c';
    for (const patch of [
      { [flag]: false }, { [flag]: undefined }, { [flag]: 'true' },
      { signatureCrc32c: '1' }, { signatureCrc32c: undefined }, { signatureCrc32c: null },
      { signature: '*invalid*' }, { signature: '' }, { name: `${keyVersionName}-foreign` },
    ]) {
      fixture.state.signPatch = patch;
      const error = await rejected(signer.sign(message()));
      expect(error).toBeInstanceOf(KmsUnavailableError);
      expectSanitized(error);
    }
  });

  it.each(algorithms)('rejects a well-checksummed signature made by another %s key', async (algorithm) => {
    const fixture = await signerFake(algorithm);
    const signer = await fixture.connect();
    fixture.state.signingKey = algorithm === 'EC_SIGN_ED25519'
      ? generateKeyPairSync('ed25519').privateKey
      : generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
    const error = await rejected(signer.sign(message()));
    expect(error).toBeInstanceOf(KmsUnavailableError);
    expectSanitized(error);
  });

  it.each(algorithms)('rejects a well-checksummed malformed signature for %s', async (algorithm) => {
    const fixture = await signerFake(algorithm);
    const signer = await fixture.connect();
    const malformed = Buffer.alloc(31, 7);
    fixture.state.signPatch = { signature: malformed.toString('base64'), signatureCrc32c: String(crc32c(malformed)) };
    expect(await rejected(signer.sign(message()))).toBeInstanceOf(KmsUnavailableError);
  });

  it.each([400, 403, 404, 401, 429, 500, 503])('maps status %s for both public key retrieval and sign', async (status) => {
    const fixture = await signerFake('EC_SIGN_ED25519');
    const signer = await fixture.connect();
    fixture.state.status = status;
    for (const operation of [() => fixture.connect(), () => signer.sign(message())]) {
      const error = await rejected(operation());
      expect(error).toBeInstanceOf([400, 403, 404].includes(status) ? KmsRefusedError : KmsUnavailableError);
      expectSanitized(error);
    }
  });

  it.each(['disconnect', 'timeout', 'body-timeout', 'invalid-json'] as const)('sanitizes %s on signing', async (mode) => {
    const fixture = await signerFake('EC_SIGN_ED25519');
    const signer = await KmsCheckpointSigner.connect({ keyVersionName, kmsBaseUrl: fixture.server.baseUrl, tokens, timeoutMs: 80 });
    fixture.server.handle = (_, res) => {
      if (mode === 'disconnect') { res.destroy(); return; }
      if (mode === 'timeout') return;
      if (mode === 'body-timeout') { res.writeHead(200).flushHeaders(); res.write('{'); return; }
      res.end(fakeToken);
    };
    const error = await rejected(signer.sign(message()));
    expect(error).toBeInstanceOf(KmsUnavailableError);
    expectSanitized(error);
  });

  it('refuses a mismatched public key resource name', async () => {
    const fixture = await signerFake('EC_SIGN_ED25519');
    fixture.state.publicPatch.name = `${keyVersionName}2`;
    expect(await rejected(fixture.connect())).toBeInstanceOf(KmsUnavailableError);
  });

  it('requires a version resource before contacting KMS', async () => {
    const fixture = await signerFake('EC_SIGN_ED25519');
    const error = await rejected(KmsCheckpointSigner.connect({ keyVersionName: keyVersionName.replace('/cryptoKeyVersions/1', ''), kmsBaseUrl: fixture.server.baseUrl, tokens }));
    expect(error).toBeInstanceOf(KmsRefusedError);
    expect(fixture.server.requests).toHaveLength(0);
  });
});
