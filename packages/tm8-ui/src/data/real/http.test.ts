/**
 * http.ts — envelope unwrap, error mapping, transport honesty (LLD §5).
 *
 * ZERO NETWORK: every test injects its own `fetch`. `createHttpClient({})` with
 * no fetch is asserted to REFUSE rather than reach for a global, which is the
 * positive control for that claim.
 */
import { describe, expect, it } from 'vitest';
import { CollabError, bindPath } from '@tm8/contract';
import { createHttpClient } from './http';
import { fakeFetch } from './test-support';

describe('http: catalog-derived URLs', () => {
  it('takes the method and the path template from OPERATIONS, not from a literal', async () => {
    const f = fakeFetch(() => ({ data: { ok: true } }));
    const http = createHttpClient({ fetch: f.fetch });

    await http.call('entities.patch', { params: { id: 'e-1' }, body: { expectedVersion: 3 } });

    expect(f.last().method).toBe('PATCH');
    // The control: the same path, derived the other way.
    expect(f.last().url).toBe(bindPath('entities.patch', { id: 'e-1' }));
    expect(f.last().url).toBe('/v2/entities/e-1');
    expect(f.last().body).toEqual({ expectedVersion: 3 });
  });

  it('percent-encodes path params through bindPath', async () => {
    const f = fakeFetch(() => ({ data: [] }));
    const http = createHttpClient({ fetch: f.fetch });
    await http.call('entityKinds.list', { params: { spaceId: 'a/b c' } });
    expect(f.last().url).toBe('/v2/spaces/a%2Fb%20c/entity-kinds');
  });

  it('prefixes an injected base URL and never a trailing slash', async () => {
    const f = fakeFetch(() => ({ data: {} }));
    const http = createHttpClient({ fetch: f.fetch, baseUrl: 'http://example.test/' });
    await http.call('identity.get');
    expect(f.last().url).toBe('http://example.test/v2/identity');
  });

  it('drops undefined query keys entirely (strict server parsers 400 on phantom keys)', async () => {
    const f = fakeFetch(() => ({ data: { items: [], nextCursor: null } }));
    const http = createHttpClient({ fetch: f.fetch });
    await http.call('entities.children', { params: { id: 'e-1' }, query: { cursor: undefined, limit: 25 } });
    expect(f.last().url).toBe('/v2/entities/e-1/children?limit=25');
    expect(f.last().url).not.toContain('undefined');
  });

  it('sends no body at all when none is given (not an empty object)', async () => {
    const f = fakeFetch(() => ({ data: {} }));
    const http = createHttpClient({ fetch: f.fetch });
    await http.call('identity.get');
    expect(f.last().body).toBeUndefined();
  });
});

describe('http: envelope unwrap', () => {
  it('returns data and never leaks the envelope', async () => {
    const f = fakeFetch(() => ({ data: { identityId: 'i-1', username: 'ada' } }));
    const http = createHttpClient({ fetch: f.fetch });
    const out = await http.call<{ identityId: string }>('identity.get');
    expect(out).toEqual({ identityId: 'i-1', username: 'ada' });
    expect(out).not.toHaveProperty('requestId');
    expect(out).not.toHaveProperty('data');
  });
});

describe('http: error mapping — the server owns the code', () => {
  it('passes a contract code through VERBATIM (no second vocabulary)', async () => {
    const f = fakeFetch(() => ({
      status: 409,
      error: { code: 'version_conflict', message: 'stale', requestId: 'req_srv_9', retryable: false },
    }));
    const http = createHttpClient({ fetch: f.fetch });

    const err = await http.call('entities.patch', { params: { id: 'e-1' } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CollabError);
    expect((err as CollabError).code).toBe('version_conflict');
    expect((err as CollabError).status).toBe(409);
    expect((err as CollabError).message).toBe('stale');
  });

  it('keeps limit_exceeded as itself — the old UI had to remap it; this one does not', async () => {
    const f = fakeFetch(() => ({
      status: 429,
      error: { code: 'limit_exceeded', message: 'session cap', requestId: 'r', retryable: true },
    }));
    const http = createHttpClient({ fetch: f.fetch });
    const err = await http.call('execution.spawn', { body: {} }).catch((e: unknown) => e);
    expect((err as CollabError).code).toBe('limit_exceeded');
    expect((err as CollabError).retryable).toBe(true);
  });

  it("preserves the SERVER's requestId in details (CollabError mints its own)", async () => {
    const f = fakeFetch(() => ({
      status: 403,
      error: { code: 'forbidden', message: 'no', requestId: 'req_srv_42', retryable: false, details: { reason: 'x' } },
    }));
    const http = createHttpClient({ fetch: f.fetch });
    const err = await http.call('identity.get').catch((e: unknown) => e) as CollabError;
    expect(err.details).toEqual({ reason: 'x', serverRequestId: 'req_srv_42' });
    // The control: the client-minted id is NOT the server's.
    expect(err.requestId).not.toBe('req_srv_42');
  });

  it('refuses to invent a code it does not understand', async () => {
    const f = fakeFetch(() => ({
      status: 418,
      error: { code: 'teapot_overflow', message: 'novel', requestId: 'r', retryable: false },
    }));
    const http = createHttpClient({ fetch: f.fetch });
    const err = await http.call('identity.get').catch((e: unknown) => e) as CollabError;
    expect(err.code).toBe('upstream_unavailable');
    expect(err.details).toMatchObject({ serverCode: 'teapot_overflow' });
  });

  it('handles an error body with no error object at all', async () => {
    const f = fakeFetch(() => ({ status: 500, raw: '{"nope":1}' }));
    const http = createHttpClient({ fetch: f.fetch });
    const err = await http.call('identity.get').catch((e: unknown) => e) as CollabError;
    expect(err.code).toBe('upstream_unavailable');
    expect(err.message).toBe('tm8 returned HTTP 500');
    expect(err.details).toMatchObject({ httpStatus: 500 });
  });
});

describe('http: transport signal — reachability, not approval', () => {
  it('a network failure is upstream_unavailable AND flips the signal false', async () => {
    const seen: boolean[] = [];
    const f = fakeFetch(() => ({ networkError: 'ECONNREFUSED' }));
    const http = createHttpClient({ fetch: f.fetch, onTransport: (ok) => seen.push(ok) });

    const err = await http.call('identity.get').catch((e: unknown) => e) as CollabError;
    expect(err.code).toBe('upstream_unavailable');
    expect(seen).toEqual([false]);
  });

  it('a REFUSAL flips the signal TRUE — a 403 proves the node answered', async () => {
    const seen: boolean[] = [];
    const f = fakeFetch(() => ({ status: 403, error: { code: 'forbidden', message: 'no', requestId: 'r', retryable: false } }));
    const http = createHttpClient({ fetch: f.fetch, onTransport: (ok) => seen.push(ok) });

    await http.call('identity.get').catch(() => undefined);
    expect(seen).toEqual([true]);
  });

  it('a non-JSON body is upstream_unavailable, not a parse crash', async () => {
    const f = fakeFetch(() => ({ status: 200, raw: '<html>proxy error</html>' }));
    const http = createHttpClient({ fetch: f.fetch });
    const err = await http.call('identity.get').catch((e: unknown) => e) as CollabError;
    expect(err.code).toBe('upstream_unavailable');
    expect(err.message).toContain('non-JSON');
  });

  it('an empty body yields undefined data rather than throwing', async () => {
    const f = fakeFetch(() => ({ status: 200, raw: '' }));
    const http = createHttpClient({ fetch: f.fetch });
    await expect(http.call('identity.get')).resolves.toBeUndefined();
  });
});

describe('http: zero-network by construction', () => {
  it('refuses plainly when no fetch was injected — it never reaches for a global', async () => {
    const http = createHttpClient({});
    const err = await http.call('identity.get').catch((e: unknown) => e) as CollabError;
    expect(err).toBeInstanceOf(CollabError);
    expect(err.message).toContain('no fetch implementation');
  });
});
