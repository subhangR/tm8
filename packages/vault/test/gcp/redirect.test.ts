import { describe, expect, it } from 'vitest';
import { GcsCheckpointError, GcsCheckpointSink } from '../../src/gcp/gcs.js';
import { GcpTransportError, request } from '../../src/gcp/http.js';
import { expectSanitized, fakeToken, json, keyVersionName, loopbackSuite, rejected, tokens } from './fake.js';

/**
 * A redirect ends the request. The bearer is never re-sent, not even to the
 * same origin, and a redirect target never sees a connection. The adapter
 * suites redirect to real Google host names, which the test fetch guard
 * refuses on its own, so only this file shows the client itself refuses.
 */
describe('GCP transport redirects', () => {
  const fake = loopbackSuite();
  const statuses = [301, 302, 303, 307, 308] as const;

  it.each(statuses)('refuses a %s to another origin without contacting it', async (status) => {
    const target = await fake((_, res) => json(res, {}));
    const origin = await fake((_, res) => { res.writeHead(status, { Location: `${target.baseUrl}/landing` }).end(); });
    const error = await rejected(request({ url: `${origin.baseUrl}/v1/x`, method: 'POST', timeoutMs: 2_000, tokens, body: '{}' }));
    expect(error).toBeInstanceOf(GcpTransportError);
    expectSanitized(error, target.baseUrl);
    expect(origin.requests).toHaveLength(1);
    expect(origin.requests[0]!.headers.authorization).toBe(`Bearer ${fakeToken}`);
    expect(target.requests).toHaveLength(0);
  });

  it.each(statuses)('refuses a same-origin %s without re-sending the bearer', async (status) => {
    const origin = await fake((req, res) => {
      if (req.url.pathname === '/v1/x') { res.writeHead(status, { Location: '/elsewhere' }).end(); return; }
      json(res, {});
    });
    const error = await rejected(request({ url: `${origin.baseUrl}/v1/x`, method: 'GET', timeoutMs: 2_000, tokens }));
    expect(error).toBeInstanceOf(GcpTransportError);
    expect(origin.requests.map((recorded) => recorded.url.pathname)).toEqual(['/v1/x']);
  });

  it('a redirected checkpoint upload and health read fail closed and never reach the target', async () => {
    const target = await fake((_, res) => json(res, {}));
    const origin = await fake((_, res) => { res.writeHead(307, { Location: `${target.baseUrl}/upload` }).end(); });
    const sink = new GcsCheckpointSink({ bucket: 'test-only-checkpoint-bucket', gcsBaseUrl: origin.baseUrl, tokens, timeoutMs: 2_000 });
    const error = await rejected(sink.put({ seq: 1, headHash: 'a'.repeat(64), at: '2026-11-21T00:00:00.000Z',
      keyId: keyVersionName, signature: Buffer.from('test-only-signature').toString('base64') }));
    expect(error).toBeInstanceOf(GcsCheckpointError);
    expectSanitized(error, target.baseUrl);
    expect(await sink.health()).toEqual({ ok: false, retention: 'unknown' });
    expect(origin.requests).toHaveLength(2);
    expect(target.requests).toHaveLength(0);
  });
});
