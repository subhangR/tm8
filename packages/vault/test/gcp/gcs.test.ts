import { describe, expect, it } from 'vitest';
import type { CheckpointSink } from '../../src/core-types.js';
import { GcsCheckpointError, GcsCheckpointSink } from '../../src/gcp/gcs.js';
import { expectSanitized, fakeToken, json, keyVersionName, loopbackSuite, rejected, tokens } from './fake.js';

describe('GcsCheckpointSink', () => {
  const fake = loopbackSuite();
  const bucket = 'test-only-checkpoint-bucket';
  const checkpoint = (): Parameters<CheckpointSink['put']>[0] => ({
    seq: 42, headHash: 'a'.repeat(64), at: '2026-11-20T12:00:00.000Z', keyId: keyVersionName,
    signature: Buffer.from('test-only-signature').toString('base64'),
  });

  it('constructs without I/O and uploads exactly the deterministic checkpoint bytes create-only', async () => {
    const server = await fake((_, res) => json(res, {}, 201));
    const sink = new GcsCheckpointSink({ bucket, gcsBaseUrl: server.baseUrl, tokens });
    expect(sink.kind).toBe('gcs');
    expect(server.requests).toHaveLength(0);
    expect(await sink.put(checkpoint())).toEqual({ anchored: true, location: `gs://${bucket}/checkpoints/000000000042.json` });
    expect(server.requests).toHaveLength(1);
    const request = server.requests[0]!;
    expect(request.method).toBe('POST');
    expect(request.url.pathname).toBe(`/upload/storage/v1/b/${bucket}/o`);
    expect(Object.fromEntries(request.url.searchParams)).toEqual({ uploadType: 'media', name: 'checkpoints/000000000042.json', ifGenerationMatch: '0' });
    expect(request.headers.authorization).toBe(`Bearer ${fakeToken}`);
    expect(request.headers['content-type']).toBe('application/json');
    expect(request.bytes.equals(Buffer.from(JSON.stringify(checkpoint())))).toBe(true);
  });

  it('treats 412 with identical bytes as an idempotent anchored success and only reads the existing object', async () => {
    let stored: Buffer | undefined;
    const server = await fake((req, res) => {
      if (req.method === 'POST') {
        if (stored) { json(res, { error: fakeToken }, 412); return; }
        stored = Buffer.from(req.bytes);
        json(res, {}, 200);
        return;
      }
      res.end(stored);
    });
    const sink = new GcsCheckpointSink({ bucket, gcsBaseUrl: server.baseUrl, tokens });
    const original = await sink.put(checkpoint());
    // Even callers with another property insertion order serialize to the same canonical field order.
    const reversed = Object.fromEntries(Object.entries(checkpoint()).reverse()) as Parameters<CheckpointSink['put']>[0];
    expect(await sink.put(reversed)).toEqual(original);
    expect(server.requests.map((req) => req.method)).toEqual(['POST', 'POST', 'GET']);
    expect(server.requests[2]!.url.pathname).toBe(`/storage/v1/b/${bucket}/o/checkpoints%2F000000000042.json`);
    expect(server.requests[2]!.url.searchParams.get('alt')).toBe('media');
    expect(stored).toEqual(Buffer.from(JSON.stringify(checkpoint())));
  });

  it.each(['different', 'same-json-different-bytes'])('never overwrites a 412 collision with %s', async (mode) => {
    const existing = mode === 'different' ? Buffer.from(fakeToken) : Buffer.from(JSON.stringify(checkpoint(), null, 2));
    const server = await fake((req, res) => {
      if (req.method === 'POST') { json(res, { error: fakeToken }, 412); return; }
      res.end(existing);
    });
    const sink = new GcsCheckpointSink({ bucket, gcsBaseUrl: server.baseUrl, tokens });
    const error = await rejected(sink.put(checkpoint()));
    expect(error).toBeInstanceOf(GcsCheckpointError);
    expect((error as GcsCheckpointError).code).toBe('conflict');
    expectSanitized(error);
    expect(server.requests.map((req) => req.method)).toEqual(['POST', 'GET']);
  });

  it.each([400, 403, 404, 429, 500, 503])('fails closed on upload status %s', async (status) => {
    const server = await fake((_, res) => json(res, { error: fakeToken }, status));
    const error = await rejected(new GcsCheckpointSink({ bucket, gcsBaseUrl: server.baseUrl, tokens }).put(checkpoint()));
    expect(error).toBeInstanceOf(GcsCheckpointError);
    expect((error as GcsCheckpointError).code).toBe('unavailable');
    expectSanitized(error);
    expect(server.requests).toHaveLength(1);
  });

  it.each([403, 404, 500, 503])('fails closed when the 412 collision cannot be read (%s)', async (status) => {
    const server = await fake((req, res) => json(res, { error: fakeToken }, req.method === 'POST' ? 412 : status));
    const error = await rejected(new GcsCheckpointSink({ bucket, gcsBaseUrl: server.baseUrl, tokens }).put(checkpoint()));
    expect(error).toBeInstanceOf(GcsCheckpointError);
    expect((error as GcsCheckpointError).code).toBe('unavailable');
    expectSanitized(error);
    expect(server.requests.map((req) => req.method)).toEqual(['POST', 'GET']);
  });

  it.each([
    [{ retentionPolicy: { isLocked: true, retentionPeriod: '86400' } }, 'locked'],
    [{ retentionPolicy: { isLocked: false, retentionPeriod: '86400' } }, 'unlocked'],
    [{ retentionPolicy: { retentionPeriod: '86400' } }, 'unlocked'],
    [{}, 'none'],
  ] as const)('only reads the bucket health state %#', async (body, retention) => {
    const server = await fake((_, res) => json(res, body));
    const sink = new GcsCheckpointSink({ bucket, gcsBaseUrl: server.baseUrl, tokens });
    expect(await sink.health()).toEqual({ ok: true, retention });
    expect(server.requests).toHaveLength(1);
    const request = server.requests[0]!;
    expect(request.method).toBe('GET');
    expect(request.url.pathname).toBe(`/storage/v1/b/${bucket}`);
    expect(Object.fromEntries(request.url.searchParams)).toEqual({ fields: 'retentionPolicy' });
    expect(request.bytes).toHaveLength(0);
  });

  it.each([
    null, [], 'unexpected', { retentionPolicy: null }, { retentionPolicy: [] },
    { retentionPolicy: true }, { retentionPolicy: { isLocked: 'true' } },
  ])('maps malformed health metadata to unknown %#', async (body) => {
    const server = await fake((_, res) => json(res, body));
    const sink = new GcsCheckpointSink({ bucket, gcsBaseUrl: server.baseUrl, tokens });
    expect(await sink.health()).toEqual({ ok: false, retention: 'unknown' });
  });

  it.each([400, 403, 404, 429, 500, 503])('maps health failure status %s to unknown', async (status) => {
    const server = await fake((_, res) => json(res, { error: fakeToken }, status));
    expect(await new GcsCheckpointSink({ bucket, gcsBaseUrl: server.baseUrl, tokens }).health()).toEqual({ ok: false, retention: 'unknown' });
  });

  it.each(['disconnect', 'timeout', 'body-timeout', 'redirect', 'oversize'] as const)('sanitizes %s for both upload and health', async (mode) => {
    const server = await fake((_, res) => {
      if (mode === 'disconnect') { res.destroy(); return; }
      if (mode === 'timeout') return;
      if (mode === 'body-timeout') { res.writeHead(200).flushHeaders(); res.write('{'); return; }
      if (mode === 'redirect') { res.writeHead(302, { Location: 'https://storage.googleapis.com/' }).end(); return; }
      res.end('x'.repeat(1_048_577));
    });
    const sink = new GcsCheckpointSink({ bucket, gcsBaseUrl: server.baseUrl, tokens, timeoutMs: 80 });
    const error = await rejected(sink.put(checkpoint()));
    expect(error).toBeInstanceOf(GcsCheckpointError);
    expectSanitized(error);
    expect(await sink.health()).toEqual({ ok: false, retention: 'unknown' });
  });

  it('sanitizes a throwing token source on upload and health', async () => {
    const server = await fake((_, res) => json(res, {}));
    const source = { getAccessToken: async () => { throw Object.assign(new Error(fakeToken), { token: fakeToken }); } };
    const sink = new GcsCheckpointSink({ bucket, gcsBaseUrl: server.baseUrl, tokens: source });
    const error = await rejected(sink.put(checkpoint()));
    expectSanitized(error);
    expect(await sink.health()).toEqual({ ok: false, retention: 'unknown' });
    expect(server.requests).toHaveLength(0);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER, NaN, Infinity])('rejects invalid seq %s before uploading', async (seq) => {
    const server = await fake((_, res) => json(res, {}));
    const error = await rejected(new GcsCheckpointSink({ bucket, gcsBaseUrl: server.baseUrl, tokens }).put({ ...checkpoint(), seq }));
    expect(error).toBeInstanceOf(GcsCheckpointError);
    expect((error as GcsCheckpointError).code).toBe('invalid_checkpoint');
    expect(server.requests).toHaveLength(0);
  });

  it.each([1, 999_999_999_999])('pads supported sequence boundary %s to 12 digits', async (seq) => {
    const server = await fake((_, res) => json(res, {}));
    await new GcsCheckpointSink({ bucket, gcsBaseUrl: server.baseUrl, tokens }).put({ ...checkpoint(), seq });
    expect(server.requests[0]!.url.searchParams.get('name')).toBe(`checkpoints/${String(seq).padStart(12, '0')}.json`);
  });
});
