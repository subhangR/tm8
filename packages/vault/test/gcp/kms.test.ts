import { describe, expect, it, vi } from 'vitest';
import { KmsRefusedError, KmsUnavailableError, LocalDevKms } from '../../src/crypto/kms.js';
import { crc32c } from '../../src/gcp/crc32c.js';
import { GcpKmsProvider } from '../../src/gcp/kms.js';
import { allZero, expectSanitized, fakeToken, json, keyName, loopbackSuite, recordFetch, rejected, tokens } from './fake.js';

describe('GcpKmsProvider', () => {
  const fake = loopbackSuite();
  const dek = () => Buffer.alloc(32, 7);
  const aad = () => Buffer.from('test-only-item-owner-version');
  async function kmsFake() {
    const local = LocalDevKms.ephemeral();
    const state = {
      key: { purpose: 'ENCRYPT_DECRYPT', primary: { state: 'ENABLED', protectionLevel: 'HSM' } },
      encryptPatch: {} as Record<string, unknown>, decryptPatch: {} as Record<string, unknown>,
      status: 200,
    };
    const server = await fake(async (req, res) => {
      if (state.status !== 200) { json(res, { error: fakeToken }, state.status); return; }
      if (req.method === 'GET' && req.url.pathname === `/v1/${keyName}`) { json(res, state.key); return; }
      const body = req.json();
      const associated = Buffer.from(body.additionalAuthenticatedData as string, 'base64');
      if (body.additionalAuthenticatedDataCrc32c !== String(crc32c(associated))) {
        json(res, { error: fakeToken }, 400); return;
      }
      if (req.url.pathname === `/v1/${keyName}:encrypt`) {
        const plaintext = Buffer.from(body.plaintext as string, 'base64');
        if (body.plaintextCrc32c !== String(crc32c(plaintext))) { json(res, {}, 400); return; }
        const wrapped = await local.wrap(plaintext, associated);
        json(res, {
          ciphertext: wrapped.ciphertext.toString('base64'), ciphertextCrc32c: String(crc32c(wrapped.ciphertext)),
          verifiedPlaintextCrc32c: true, verifiedAdditionalAuthenticatedDataCrc32c: true,
          ...state.encryptPatch,
        });
        return;
      }
      if (req.url.pathname === `/v1/${keyName}:decrypt`) {
        const ciphertext = Buffer.from(body.ciphertext as string, 'base64');
        if (body.ciphertextCrc32c !== String(crc32c(ciphertext))) { json(res, {}, 400); return; }
        try {
          const plaintext = await local.unwrap({ kekId: local.activeKekId, ciphertext }, associated);
          json(res, { plaintext: plaintext.toString('base64'), plaintextCrc32c: String(crc32c(plaintext)), ...state.decryptPatch });
          plaintext.fill(0);
        } catch { json(res, { error: fakeToken }, 400); }
        return;
      }
      json(res, {}, 404);
    });
    return { server, state, connect: () => GcpKmsProvider.connect({ keyName, kmsBaseUrl: server.baseUrl, tokens }) };
  }

  it('reads the key on connect and wraps/unwraps with the bound AAD and every request checksum', async () => {
    const { server, connect } = await kmsFake();
    const provider = await connect();
    expect(server.requests).toHaveLength(1);
    expect(provider.kind).toBe('gcp-kms');
    expect(provider.activeKekId).toBe(keyName);
    expect(provider.productionGrade).toBe(true);
    const wrapped = await provider.wrap(dek(), aad());
    expect(wrapped.kekId).toBe(keyName);
    expect(wrapped.ciphertext).not.toEqual(dek());
    const plaintext = await provider.unwrap(wrapped, aad());
    expect(plaintext).toEqual(dek());
    plaintext.fill(0);
    expect(server.requests.map((req) => req.method)).toEqual(['GET', 'POST', 'POST']);
    for (const req of server.requests) expect(req.headers.authorization).toBe(`Bearer ${fakeToken}`);
    expect(server.requests[1]!.json()).toEqual({
      plaintext: dek().toString('base64'), plaintextCrc32c: String(crc32c(dek())),
      additionalAuthenticatedData: aad().toString('base64'), additionalAuthenticatedDataCrc32c: String(crc32c(aad())),
    });
    expect(server.requests[2]!.json()).toEqual({
      ciphertext: wrapped.ciphertext.toString('base64'), ciphertextCrc32c: String(crc32c(wrapped.ciphertext)),
      additionalAuthenticatedData: aad().toString('base64'), additionalAuthenticatedDataCrc32c: String(crc32c(aad())),
    });
  });

  it.each([
    ['ENCRYPT_DECRYPT', 'ENABLED', 'SOFTWARE'],
    ['ENCRYPT_DECRYPT', 'ENABLED', 'EXTERNAL'],
    ['ENCRYPT_DECRYPT', 'DISABLED', 'HSM'],
    ['ENCRYPT_DECRYPT', 'DESTROYED', 'HSM'],
    ['ASYMMETRIC_SIGN', 'ENABLED', 'HSM'],
  ])('does not claim production grade for %s/%s/%s', async (purpose, state, protectionLevel) => {
    const fixture = await kmsFake();
    fixture.state.key = { purpose, primary: { state, protectionLevel } };
    const provider = await fixture.connect();
    expect(provider.productionGrade).toBe(false);
    if (protectionLevel === 'SOFTWARE') {
      const wrapped = await provider.wrap(dek(), aad());
      expect(await provider.unwrap(wrapped, aad())).toEqual(dek());
      expect(await provider.health()).toEqual({ ok: true });
    }
  });

  it('health re-reads state and withdraws the HSM claim on failure or software rotation', async () => {
    const { server, state, connect } = await kmsFake();
    const provider = await connect();
    state.key.primary.protectionLevel = 'SOFTWARE';
    expect(await provider.health()).toEqual({ ok: true });
    expect(provider.productionGrade).toBe(false);
    state.key.primary = { protectionLevel: 'HSM', state: 'ENABLED' };
    expect(await provider.health()).toEqual({ ok: true });
    expect(provider.productionGrade).toBe(true);
    state.key.primary.state = 'DISABLED';
    expect(await provider.health()).toEqual({ ok: false });
    expect(provider.productionGrade).toBe(false);
    state.status = 500;
    expect(await provider.health()).toEqual({ ok: false, detail: 'KMS unavailable' });
    expect(server.requests).toHaveLength(5);
  });

  it('refuses a wrong AAD without disclosing upstream content', async () => {
    const { connect } = await kmsFake();
    const provider = await connect();
    const wrapped = await provider.wrap(dek(), aad());
    const error = await rejected(provider.unwrap(wrapped, Buffer.from('different-test-only-aad')));
    expect(error).toBeInstanceOf(KmsRefusedError);
    expectSanitized(error, dek().toString('base64'));
  });

  it('refuses a foreign kekId before any request can be steered', async () => {
    const { server, connect } = await kmsFake();
    const provider = await connect();
    const foreign = `${keyName}-foreign?token=${fakeToken}`;
    const error = await rejected(provider.unwrap({ kekId: foreign, ciphertext: Buffer.alloc(32) }, aad()));
    expect(error).toBeInstanceOf(KmsRefusedError);
    expectSanitized(error, foreign);
    expect(server.requests).toHaveLength(1);
  });

  it.each([
    ['verifiedPlaintextCrc32c', false], ['verifiedPlaintextCrc32c', undefined], ['verifiedPlaintextCrc32c', 'true'],
    ['verifiedAdditionalAuthenticatedDataCrc32c', false], ['verifiedAdditionalAuthenticatedDataCrc32c', undefined],
    ['ciphertextCrc32c', '1'], ['ciphertextCrc32c', undefined], ['ciphertextCrc32c', null],
    ['ciphertext', '*invalid*'], ['ciphertext', ''],
  ])('rejects corrupt or absent encrypt integrity %s (%s)', async (field, value) => {
    const { state, connect } = await kmsFake();
    state.encryptPatch[field as string] = value;
    const provider = await connect();
    const error = await rejected(provider.wrap(dek(), aad()));
    expect(error).toBeInstanceOf(KmsUnavailableError);
    expectSanitized(error, dek().toString('base64'));
  });

  it.each([
    ['plaintextCrc32c', '1'], ['plaintextCrc32c', undefined], ['plaintextCrc32c', null],
    ['plaintextCrc32c', -1], ['plaintextCrc32c', 0x100000000], ['plaintext', '*invalid*'],
  ])('rejects corrupt or absent decrypt integrity %s (%s)', async (field, value) => {
    const { state, connect } = await kmsFake();
    const provider = await connect();
    const wrapped = await provider.wrap(dek(), aad());
    state.decryptPatch[field as string] = value;
    const error = await rejected(provider.unwrap(wrapped, aad()));
    expect(error).toBeInstanceOf(KmsUnavailableError);
    expectSanitized(error, dek().toString('base64'));
  });

  it.each([400, 403, 404, 401, 408, 429, 500, 502, 503, 504])('maps HTTP %s on connect, wrap and unwrap', async (status) => {
    const fixture = await kmsFake();
    const provider = await fixture.connect();
    const wrapped = await provider.wrap(dek(), aad());
    fixture.state.status = status;
    const errorClass = [400, 403, 404].includes(status) ? KmsRefusedError : KmsUnavailableError;
    for (const pending of [() => fixture.connect(), () => provider.wrap(dek(), aad()), () => provider.unwrap(wrapped, aad())]) {
      const error = await rejected(pending());
      expect(error).toBeInstanceOf(errorClass);
      expectSanitized(error, dek().toString('base64'));
    }
    expect(await provider.health()).toEqual({ ok: false, detail: 'KMS unavailable' });
  });

  it.each([400, 403, 404])('preserves refusal status %s without consuming an unending error body', async (status) => {
    const server = await fake((_, res) => { res.writeHead(status).flushHeaders(); res.write(fakeToken); });
    const error = await rejected(GcpKmsProvider.connect({ keyName, kmsBaseUrl: server.baseUrl, tokens, timeoutMs: 300 }));
    expect(error).toBeInstanceOf(KmsRefusedError);
    expectSanitized(error);
  });

  it.each(['disconnect', 'timeout', 'body-timeout', 'invalid-json', 'redirect', 'oversize'] as const)('maps %s to unavailable', async (mode) => {
    const { server, connect } = await kmsFake();
    const provider = await connect();
    server.handle = (_, res) => {
      if (mode === 'disconnect') { res.destroy(); return; }
      if (mode === 'timeout') return;
      if (mode === 'body-timeout') { res.writeHead(200).flushHeaders(); res.write('{'); return; }
      if (mode === 'redirect') { res.writeHead(302, { Location: 'https://cloudkms.googleapis.com/' }).end(); return; }
      res.end(mode === 'oversize' ? 'x'.repeat(1_048_577) : fakeToken);
    };
    const short = await rejected(GcpKmsProvider.connect({ keyName, kmsBaseUrl: server.baseUrl, tokens, timeoutMs: 80 }));
    expect(short).toBeInstanceOf(KmsUnavailableError);
    expectSanitized(short);
    if (!['timeout', 'body-timeout'].includes(mode)) {
      const error = await rejected(provider.wrap(dek(), aad()));
      expect(error).toBeInstanceOf(KmsUnavailableError);
      expectSanitized(error);
    }
  });

  it('sanitizes throwing and invalid token sources and includes token acquisition in the deadline', async () => {
    const { server } = await kmsFake();
    const sources = [
      { getAccessToken: async () => { throw Object.assign(new Error(fakeToken), { response: fakeToken }); } },
      { getAccessToken: async () => `${fakeToken}\n` },
      { getAccessToken: () => new Promise<string>(() => {}) },
    ];
    for (const source of sources) {
      const error = await rejected(GcpKmsProvider.connect({ keyName, kmsBaseUrl: server.baseUrl, tokens: source, timeoutMs: 80 }));
      expect(error).toBeInstanceOf(KmsUnavailableError);
      expectSanitized(error);
    }
    expect(server.requests).toHaveLength(0);
  });

  it('never starts a late request when token acquisition finishes after timeout', async () => {
    const { server } = await kmsFake();
    let release!: (token: string) => void;
    const source = { getAccessToken: () => new Promise<string>((resolve) => { release = resolve; }) };
    await rejected(GcpKmsProvider.connect({ keyName, kmsBaseUrl: server.baseUrl, tokens: source, timeoutMs: 80 }));
    release(fakeToken);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(server.requests).toHaveLength(0);
  });

  it.each(['../elsewhere', `${keyName}?token=${fakeToken}`, `${keyName}/cryptoKeyVersions/1`])('rejects malformed CryptoKey names without making a request', async (name) => {
    const { server } = await kmsFake();
    const error = await rejected(GcpKmsProvider.connect({ keyName: name, kmsBaseUrl: server.baseUrl, tokens }));
    expect(error).toBeInstanceOf(KmsRefusedError);
    expectSanitized(error);
    expect(server.requests).toHaveLength(0);
  });

  it.each([{}, { purpose: 'ENCRYPT_DECRYPT' }, { purpose: 'ENCRYPT_DECRYPT', primary: [] }])('refuses malformed key metadata %#', async (body) => {
    const server = await fake((_, res) => json(res, body));
    expect(await rejected(GcpKmsProvider.connect({ keyName, kmsBaseUrl: server.baseUrl, tokens }))).toBeInstanceOf(KmsUnavailableError);
  });

  describe('plaintext copies of a DEK (review F05)', () => {
    /** Unwraps with every client-side copy observable: response chunks, Buffer.concat results, parsed objects. */
    async function observedUnwrap(options: { split: boolean; corruptCrc?: boolean }) {
      const { server, state, connect } = await kmsFake();
      const provider = await connect();
      const wrapped = await provider.wrap(dek(), aad());
      if (options.corruptCrc) state.decryptPatch.plaintextCrc32c = String((crc32c(dek()) + 1) >>> 0);
      const record = recordFetch({ split: options.split });
      const concat = vi.spyOn(Buffer, 'concat');
      const parse = vi.spyOn(JSON, 'parse');
      let outcome: Buffer | Error;
      let joined: Buffer[];
      let parsed: unknown[];
      try {
        outcome = await provider.unwrap(wrapped, aad()).catch((error: Error) => error);
        // Only the client's own join of the response chunks: its parts are views of the recorded chunks.
        joined = concat.mock.calls.flatMap(([list], index) => list.length > 1 && list.every((part, at) =>
          part.buffer === record.chunks[at]?.buffer && part.byteOffset === record.chunks[at]?.byteOffset)
          ? [concat.mock.results[index]!.value as Buffer] : []);
        parsed = parse.mock.results.map((result) => result.value as unknown);
      } finally {
        concat.mockRestore();
        parse.mockRestore();
      }
      const response = parsed.filter((value): value is Record<string, unknown> =>
        typeof value === 'object' && value !== null && 'plaintextCrc32c' in value);
      return { server, record, outcome, joined, response };
    }

    it('wipes the decrypt response it read in one chunk, and drops the parsed plaintext field', async () => {
      const { server, record, outcome, joined, response } = await observedUnwrap({ split: false });
      expect(outcome).toEqual(dek());
      expect(record.chunks).toHaveLength(1);
      expect(record.chunks.every(allZero)).toBe(true);
      expect(joined).toEqual([]);
      expect(response).toHaveLength(1);
      expect(response[0]).not.toHaveProperty('plaintext');
      // No compressed transfer, so no zlib buffers hold the response.
      expect(server.requests.at(-1)!.headers['accept-encoding']).toBe('identity');
      (outcome as Buffer).fill(0);
    });

    it('wipes every chunk and the joined copy when the response arrives in pieces', async () => {
      const { record, outcome, joined, response } = await observedUnwrap({ split: true });
      expect(outcome).toEqual(dek());
      expect(record.chunks.length).toBeGreaterThan(1);
      expect(record.chunks.every(allZero)).toBe(true);
      expect(joined).toHaveLength(1);
      expect(allZero(joined[0]!)).toBe(true);
      expect(response[0]).not.toHaveProperty('plaintext');
      (outcome as Buffer).fill(0);
    });

    it('wipes the same copies when the plaintext checksum is wrong', async () => {
      const { record, outcome, joined, response } = await observedUnwrap({ split: true, corruptCrc: true });
      expect(outcome).toBeInstanceOf(KmsUnavailableError);
      expectSanitized(outcome as Error);
      expect(record.chunks.every(allZero)).toBe(true);
      expect(joined.every(allZero)).toBe(true);
      expect(response).toHaveLength(1);
      expect(response[0]).not.toHaveProperty('plaintext');
    });

    it('decodes the base64 DEK without re-encoding it to a string', async () => {
      const { connect } = await kmsFake();
      const provider = await connect();
      const wrapped = await provider.wrap(dek(), aad());
      const original = Buffer.prototype.toString;
      const secret = dek();
      let reencoded = 0;
      const spy = vi.spyOn(Buffer.prototype, 'toString').mockImplementation(function (this: Buffer, ...args: unknown[]) {
        if (args[0] === 'base64' && this.length === secret.length && this.equals(secret)) reencoded += 1;
        return original.apply(this, args as Parameters<Buffer['toString']>);
      });
      let plaintext: Buffer;
      try { plaintext = await provider.unwrap(wrapped, aad()); }
      finally { spy.mockRestore(); }
      expect(plaintext).toEqual(secret);
      // The loopback fake (same process) encodes the DEK once to build its response; the client adds none.
      expect(reencoded).toBe(1);
      plaintext.fill(0);
    });

    it('sends the DEK to encrypt from bytes it wipes, never as a base64 or JSON string', async () => {
      const { server, connect } = await kmsFake();
      const provider = await connect();
      const secret = dek();
      const encoded = secret.toString('base64');
      const record = recordFetch();
      const original = Buffer.prototype.toString;
      let reencoded = 0;
      const toString = vi.spyOn(Buffer.prototype, 'toString').mockImplementation(function (this: Buffer, ...args: unknown[]) {
        if (args[0] === 'base64' && this.length === secret.length && this.equals(secret)) reencoded += 1;
        return original.apply(this, args as Parameters<Buffer['toString']>);
      });
      const stringify = vi.spyOn(JSON, 'stringify');
      let carried: number;
      try {
        await provider.wrap(secret, aad());
        carried = stringify.mock.results.filter((result) => typeof result.value === 'string' && result.value.includes(encoded)).length;
      } finally {
        toString.mockRestore();
        stringify.mockRestore();
      }
      expect(reencoded).toBe(0);
      expect(carried).toBe(0);
      const sent = record.bodies.at(-1);
      expect(Buffer.isBuffer(sent)).toBe(true);
      expect(allZero(sent as Buffer)).toBe(true);
      // The runtime's own copy of the body reached the server intact.
      expect(server.requests.at(-1)!.json()).toEqual({
        plaintext: encoded, plaintextCrc32c: String(crc32c(secret)),
        additionalAuthenticatedData: aad().toString('base64'), additionalAuthenticatedDataCrc32c: String(crc32c(aad())),
      });
    });
  });
});
