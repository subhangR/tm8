/**
 * DEV-6 — the wire envelope. Success responses are `{ data, requestId }`;
 * error responses are the DEV-8 wire error body; nothing else ever comes back.
 */
import { describe, expect, it } from 'vitest';
import { WireErrorBodySchema } from '@tm8/contract';
import { rawRequest } from '../src/client.js';

describe('envelope (DEV-6)', () => {
  it('reads return { data, requestId } with JSON content-type', async () => {
    const res = await rawRequest('GET', '/v2/spaces');
    expect(res.status, `GET /v2/spaces answered ${res.status}`).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = res.body as Record<string, unknown>;
    expect(body).toBeTypeOf('object');
    expect('data' in body, 'missing data field').toBe(true);
    expect(typeof body.requestId, 'missing requestId').toBe('string');
    // nextCursor lives inside data.page on list shapes — never on the envelope
    expect('nextCursor' in body).toBe(false);
  });

  it('identity read is enveloped too', async () => {
    const res = await rawRequest('GET', '/v2/identity');
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect('data' in body).toBe(true);
    expect(typeof body.requestId).toBe('string');
  });

  it('every error is the contract wire error body — unknown route', async () => {
    const res = await rawRequest('GET', '/v2/definitely-not-a-route');
    expect(res.status).toBe(404);
    const parsed = WireErrorBodySchema.safeParse(res.body);
    expect(parsed.success, `error body drift: ${JSON.stringify(res.body)}`).toBe(true);
    if (parsed.success) expect(parsed.data.error.code).toBe('not_found');
  });

  it('malformed JSON body → 400 invalid_input in the wire shape', async () => {
    const res = await rawRequest('POST', '/v2/entities', undefined, { rawBody: '{not json' });
    expect(res.status).toBe(400);
    const parsed = WireErrorBodySchema.safeParse(res.body);
    expect(parsed.success, `error body drift: ${JSON.stringify(res.body)}`).toBe(true);
    if (parsed.success) expect(parsed.data.error.code).toBe('invalid_input');
  });
});
