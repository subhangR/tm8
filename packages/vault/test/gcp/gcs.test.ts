import { describe, expect, it } from 'vitest';
import { CheckpointReadError, type CheckpointSink } from '../../src/core-types.js';
import { GcsCheckpointError, GcsCheckpointSink } from '../../src/gcp/gcs.js';
import { expectSanitized, fakeToken, json, keyVersionName, loopbackSuite, rejected, tokens, type FakeRequest } from './fake.js';

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

describe('GcsCheckpointSink read-back (review F01)', () => {
  const fake = loopbackSuite();
  const bucket = 'test-only-checkpoint-bucket';
  const objectName = (seq: number) => `checkpoints/${String(seq).padStart(12, '0')}.json`;
  const retained = (seq: number, patch: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({
    seq, headHash: 'a'.repeat(64), at: '2026-11-20T12:00:00.000Z', keyId: keyVersionName,
    signature: Buffer.from('test-only-signature').toString('base64url'), ...patch,
  }));
  const listPath = `/storage/v1/b/${bucket}/o`;

  /** A bucket that lists like GCS: lexicographic names from startOffset under prefix, paged by token. */
  async function bucketFake(objects: Map<string, Buffer>, options: { pageSize?: number; list?: (req: FakeRequest) => unknown; mediaStatus?: number } = {}) {
    const pageSize = options.pageSize ?? 1_000;
    return fake((req, res) => {
      if (req.method !== 'GET') { json(res, {}, 405); return; }
      if (req.url.pathname === listPath) {
        if (options.list) { json(res, options.list(req)); return; }
        const prefix = req.url.searchParams.get('prefix') ?? '';
        const start = req.url.searchParams.get('startOffset') ?? '';
        const offset = Number(req.url.searchParams.get('pageToken') ?? '0');
        const names = [...objects.keys()].filter((name) => name.startsWith(prefix) && name >= start).sort();
        const page = names.slice(offset, offset + pageSize);
        json(res, {
          ...(page.length ? { items: page.map((name) => ({ name, bucket, size: String(objects.get(name)!.length) })) } : {}),
          ...(offset + pageSize < names.length ? { nextPageToken: String(offset + pageSize) } : {}),
        });
        return;
      }
      if (req.url.pathname.startsWith(`${listPath}/`) && req.url.searchParams.get('alt') === 'media') {
        if (options.mediaStatus) { json(res, { error: fakeToken }, options.mediaStatus); return; }
        const bytes = objects.get(decodeURIComponent(req.url.pathname.slice(listPath.length + 1)));
        if (!bytes) { json(res, { error: 'test-only not found' }, 404); return; }
        res.end(bytes);
        return;
      }
      json(res, {}, 404);
    });
  }
  const code = async (promise: Promise<unknown>): Promise<string> => {
    const error = await rejected(promise);
    expect(error).toBeInstanceOf(CheckpointReadError);
    expectSanitized(error);
    return (error as CheckpointReadError).code;
  };

  it('lists from the hint upward across pages and reads back the highest retained head, read-only', async () => {
    const objects = new Map<string, Buffer>();
    for (const seq of [1, 2, 5, 12]) objects.set(objectName(seq), retained(seq));
    for (const name of ['checkpoints/notes.txt', 'checkpoints/00000000099.json', 'checkpoints/sub/000000000099.json', 'checkpoints/000000000099.json.tmp']) {
      objects.set(name, Buffer.from('test-only unrelated'));
    }
    const server = await bucketFake(objects, { pageSize: 2 });
    const sink = new GcsCheckpointSink({ bucket, gcsBaseUrl: server.baseUrl, tokens });
    expect(await sink.latest(2)).toEqual({ ...JSON.parse(retained(12).toString()), location: `gs://${bucket}/${objectName(12)}` });
    expect(server.requests.every((req) => req.method === 'GET' && req.bytes.length === 0 && req.headers.authorization === `Bearer ${fakeToken}`)).toBe(true);
    const lists = server.requests.slice(0, -1);
    expect(lists.length).toBeGreaterThan(1);
    lists.forEach((req, index) => {
      expect(req.url.pathname).toBe(listPath);
      expect(Object.fromEntries(req.url.searchParams)).toEqual({
        prefix: 'checkpoints/', startOffset: objectName(2), maxResults: '1000', fields: 'items(name),nextPageToken',
        ...(index === 0 ? {} : { pageToken: String(index * 2) }),
      });
    });
    const media = server.requests.at(-1)!;
    expect(media.url.pathname).toBe(`${listPath}/checkpoints%2F000000000012.json`);
    expect(Object.fromEntries(media.url.searchParams)).toEqual({ alt: 'media' });
  });

  it('retains nothing in an empty bucket, below the hint, or at seq 0, which put refuses', async () => {
    const objects = new Map([[objectName(0), retained(0)]]);
    const server = await bucketFake(objects);
    const sink = new GcsCheckpointSink({ bucket, gcsBaseUrl: server.baseUrl, tokens });
    expect(await sink.latest()).toBeNull();
    objects.set(objectName(3), retained(3));
    expect(await sink.latest(4)).toBeNull();
    expect(await sink.latest(3)).toMatchObject({ seq: 3 });
    expect(server.requests.filter((req) => req.url.searchParams.get('alt') === 'media')).toHaveLength(1);
  });

  it.each([400, 403, 404, 429, 500, 503])('a listing that fails with %s is an outage', async (status) => {
    const server = await fake((_, res) => json(res, { error: fakeToken }, status));
    expect(await code(new GcsCheckpointSink({ bucket, gcsBaseUrl: server.baseUrl, tokens }).latest())).toBe('unavailable');
    expect(server.requests).toHaveLength(1);
  });

  it.each([
    [], 'unexpected', null, { items: {} }, { items: 'x' }, { items: [null] }, { items: [{}] }, { items: [{ name: 5 }] },
    { nextPageToken: '' }, { nextPageToken: 5 }, { nextPageToken: null }, { nextPageToken: 'x'.repeat(4_097) },
  ])('a listing it cannot parse is an outage %#', async (body) => {
    const server = await bucketFake(new Map(), { list: () => body });
    expect(await code(new GcsCheckpointSink({ bucket, gcsBaseUrl: server.baseUrl, tokens }).latest())).toBe('unavailable');
  });

  it('a listing too long to finish is an outage, not a guess at the newest head', async () => {
    const server = await bucketFake(new Map(), { list: () => ({ items: [{ name: objectName(1) }], nextPageToken: 'test-only-again' }) });
    expect(await code(new GcsCheckpointSink({ bucket, gcsBaseUrl: server.baseUrl, tokens }).latest())).toBe('unavailable');
    expect(server.requests).toHaveLength(1_000);
  });

  it.each([403, 404, 500])('a listed head that cannot be read (%s) is an outage', async (mediaStatus) => {
    const server = await bucketFake(new Map([[objectName(7), retained(7)]]), { mediaStatus });
    expect(await code(new GcsCheckpointSink({ bucket, gcsBaseUrl: server.baseUrl, tokens }).latest())).toBe('unavailable');
  });

  it.each([
    ['oversize', Buffer.from(JSON.stringify({ ...JSON.parse(retained(7).toString()), at: 'x'.repeat(4_096) }))],
    ['not json', Buffer.from('{"seq":7,')],
    ['another seq than its name', retained(6)],
    ['an extra field', retained(7, { location: 'gs://elsewhere' })],
    ['padded base64', retained(7, { signature: Buffer.from('test-only-signature').toString('base64') + '=' })],
    ['an unsignable head', retained(7, { headHash: 'A'.repeat(64) })],
  ])('a retained object with %s is invalid evidence', async (_name, bytes) => {
    const server = await bucketFake(new Map([[objectName(7), bytes]]));
    expect(await code(new GcsCheckpointSink({ bucket, gcsBaseUrl: server.baseUrl, tokens }).latest())).toBe('invalid');
  });

  it.each([-1, 1.5, Number.NaN, 1_000_000_000_000])('refuses the hint %s before any request', async (from) => {
    const server = await bucketFake(new Map());
    expect(await code(new GcsCheckpointSink({ bucket, gcsBaseUrl: server.baseUrl, tokens }).latest(from))).toBe('invalid');
    expect(server.requests).toHaveLength(0);
  });

  it.each(['disconnect', 'timeout', 'redirect'] as const)('sanitizes a %s on the read-back as an outage', async (mode) => {
    const server = await fake((_, res) => {
      if (mode === 'disconnect') { res.destroy(); return; }
      if (mode === 'timeout') return;
      res.writeHead(302, { Location: 'https://storage.googleapis.com/' }).end();
    });
    expect(await code(new GcsCheckpointSink({ bucket, gcsBaseUrl: server.baseUrl, tokens, timeoutMs: 80 }).latest())).toBe('unavailable');
  });
});
