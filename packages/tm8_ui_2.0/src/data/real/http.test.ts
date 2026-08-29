/**
 * http.ts — envelope unwrap, error mapping, transport honesty (LLD §5).
 *
 * ZERO NETWORK: every test injects its own `fetch`. `createHttpClient({})` with
 * no fetch is asserted to REFUSE rather than reach for a global, which is the
 * positive control for that claim.
 */
import { describe, expect, it } from 'vitest';
import {
  CollabError,
  TM8_CLIENT_HEADER,
  TM8_CLIENT_HEADER_VALUE,
  bindPath,
} from '@tm8/contract';
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

/**
 * The S6 CSRF header. This is a REGRESSION suite: the server has required
 * `X-TM8-Client` on cookie-carrying mutations since the artifacts Phase 0, and
 * no client ever sent it — so the moment a cookie reached the node, every
 * mutation came back 403 ("Launch refused"). A custom header is the defence
 * itself (a cross-site page cannot set one without a preflight, which the node
 * refuses), so presence on the wire is the whole assertion.
 */
describe('http: S6 client header', () => {
  it('sends X-TM8-Client on mutations AND on reads', async () => {
    const f = fakeFetch(() => ({ data: {} }));
    const http = createHttpClient({ fetch: f.fetch });

    await http.call('entities.patch', { params: { id: 'e-1' }, body: { expectedVersion: 1 } });
    expect(f.last().headers).toMatchObject({
      'x-tm8-client': 'tm8-ui',
      'content-type': 'application/json',
    });

    await http.call('identity.get');
    expect(f.last().headers).toMatchObject({ 'x-tm8-client': 'tm8-ui' });
  });

  it('spells the header exactly as the contract does', async () => {
    const f = fakeFetch(() => ({ data: {} }));
    await createHttpClient({ fetch: f.fetch }).call('identity.get');
    const sent = f.last().headers as Record<string, string> | undefined;
    expect(sent?.[TM8_CLIENT_HEADER]).toBe(TM8_CLIENT_HEADER_VALUE);
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

describe('http: server-granted raw upload', () => {
  it('PUTs bytes to the grant URL with the grant in ITS OWN header, never in Authorization', async () => {
    const f = fakeFetch(() => ({ status: 204, raw: '' }));
    const http = createHttpClient({ fetch: f.fetch, baseUrl: 'http://example.test/' });
    const bytes = new Blob(['hello'], { type: 'text/plain' });
    await http.putGrantedBytes('/v2/files/uploads/upload-1/content', 'grant-secret', bytes);
    expect(f.last().method).toBe('PUT');
    expect(f.last().url).toBe('http://example.test/v2/files/uploads/upload-1/content');
    expect(f.last().rawBody).toBe(bytes);
    // The browser will attach `__Host-tm8-session` to this same-origin PUT no
    // matter what we do. A grant in `authorization` therefore arrives as a
    // SECOND, DIFFERENT credential and the node refuses the pair outright —
    // which is how every browser upload came to report "Sign in again before
    // uploading files" to a viewer who was signed in.
    expect(f.last().headers).toEqual({
      'x-tm8-upload-token': 'grant-secret',
      'x-tm8-client': 'tm8-ui',
    });
    expect(f.last().headers.authorization).toBeUndefined();
  });

  it('sends the viewer pass in Authorization so cookie and header name ONE principal', async () => {
    const f = fakeFetch(() => ({ status: 204, raw: '' }));
    const http = createHttpClient({
      fetch: f.fetch,
      baseUrl: 'http://example.test/',
      getAuthToken: () => 'tm8s_session.pass',
    });
    await http.putGrantedBytes('/v2/files/uploads/upload-1/content', 'grant-secret', new Blob(['x']));
    expect(f.last().headers).toEqual({
      authorization: 'Bearer tm8s_session.pass',
      'x-tm8-upload-token': 'grant-secret',
      'x-tm8-client': 'tm8-ui',
    });
  });

  it('omits the S6 header on an absolute grant URL — that store is not our node', async () => {
    const f = fakeFetch(() => ({ status: 204, raw: '' }));
    const http = createHttpClient({
      fetch: f.fetch,
      baseUrl: 'http://example.test/',
      getAuthToken: () => 'tm8s_session.pass',
    });
    await http.putGrantedBytes('https://blobs.example/put/abc', 'grant-secret', new Blob(['x']));
    expect(f.last().url).toBe('https://blobs.example/put/abc');
    // A foreign store has no tm8 identity to preserve and no cookie of ours to
    // collide with: there the grant IS the credential, in the header a
    // presigned PUT expects — and our viewer's pass must NOT be sent offsite.
    expect(f.last().headers).toEqual({ authorization: 'Bearer grant-secret' });
  });

  it('refuses a grant with no bearer token before touching the network', async () => {
    const f = fakeFetch(() => ({ status: 204, raw: '' }));
    const http = createHttpClient({ fetch: f.fetch });
    await expect(http.putGrantedBytes('/v2/files/uploads/u/content', null, new Blob())).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    expect(f.calls).toHaveLength(0);
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
    // `httpStatus` rides along on EVERY served error now — it is how the boot
    // retry tells an answered 503 from an unreachable node, which mint the
    // same CollabError code (and therefore the same `.status`).
    expect(err.details).toEqual({ reason: 'x', serverRequestId: 'req_srv_42', httpStatus: 403 });
    // The control: the client-minted id is NOT the server's.
    expect(err.requestId).not.toBe('req_srv_42');
  });

  it('a served 503 carries httpStatus; an unreachable node does not', async () => {
    // The boot retry's overload backoff keys on exactly this difference —
    // both errors share code `upstream_unavailable` and `.status` 503.
    const served = fakeFetch(() => ({
      status: 503,
      error: { code: 'upstream_unavailable', message: 'pool saturated', requestId: 'r', retryable: true },
    }));
    const answered = await createHttpClient({ fetch: served.fetch })
      .call('identity.get').catch((e: unknown) => e) as CollabError;
    expect(answered.code).toBe('upstream_unavailable');
    expect(answered.details).toMatchObject({ httpStatus: 503 });

    const down = fakeFetch(() => ({ networkError: 'ECONNREFUSED' }));
    const unreachable = await createHttpClient({ fetch: down.fetch })
      .call('identity.get').catch((e: unknown) => e) as CollabError;
    expect(unreachable.code).toBe('upstream_unavailable');
    expect(unreachable.details?.['httpStatus']).toBeUndefined();
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
