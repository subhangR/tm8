/**
 * The HTTP seam: catalog binding, the three response shapes, and the exact
 * failure classification each one produces.
 *
 * Every path in this package comes from `bindPath(<operationName>)`. The test
 * that guards it is the one asserting the URL the client actually requested
 * equals the catalog's own path — a hand-written literal would pass a "did it
 * 200" test and fail this one.
 */
import { describe, expect, it } from 'vitest';
import { getOperation } from '@tm8/contract';
import { Tm8Client, pathParamNames, responseMode } from '../src/client.js';
import { ApiError, ProtocolError, StreamOperationError, TransportError, exitCodeFor } from '../src/errors.js';
import { CliError } from '../src/exit.js';

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function stub(respond: (seen: Seen) => Response): { fetchImpl: typeof fetch; calls: Seen[] } {
  const calls: Seen[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const seen: Seen = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(seen);
    return respond(seen);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const ok = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify({ data, requestId: 'req_env' }), {
    status,
    headers: { 'content-type': 'application/json', 'x-tm8-request-id': 'req_hdr' },
  });

const wireError = (status: number, code: string, details?: unknown): Response =>
  new Response(
    JSON.stringify({ error: { code, message: `nope: ${code}`, requestId: 'req_err', retryable: false, ...(details === undefined ? {} : { details }) } }),
    { status, headers: { 'content-type': 'application/json' } },
  );

const client = (fetchImpl: typeof fetch, token?: string): Tm8Client =>
  new Tm8Client({ baseUrl: 'http://127.0.0.1:4610', fetchImpl, ...(token === undefined ? {} : { token }) });

describe('catalog binding', () => {
  it('requests the catalog path for the operation, with :params bound', async () => {
    const { fetchImpl, calls } = stub(() => ok({ id: 'ent_1' }));
    await client(fetchImpl).invoke('entities.children', { params: { id: 'ent 1/2' } });
    expect(calls[0]?.url).toBe('http://127.0.0.1:4610/v2/entities/ent%201%2F2/children');
    expect(calls[0]?.method).toBe(getOperation('entities.children').method);
  });

  it('a missing :param fails before the network', async () => {
    const { fetchImpl, calls } = stub(() => ok({}));
    await expect(client(fetchImpl).invoke('entities.get')).rejects.toThrowError(/missing param :id/);
    expect(calls).toHaveLength(0);
  });

  it('repeats query keys instead of joining them', async () => {
    const { fetchImpl, calls } = stub(() => ok({}));
    await client(fetchImpl).invoke('edges.list', { query: { type: ['blocks', 'relates_to'], direction: 'outgoing', absent: undefined } });
    expect(calls[0]?.url).toBe('http://127.0.0.1:4610/v2/edges?type=blocks&type=relates_to&direction=outgoing');
  });

  it('sends a bearer only when one exists — Phase 1 has no bearer auth', async () => {
    const { fetchImpl, calls } = stub(() => ok({}));
    await client(fetchImpl).invoke('identity.get');
    expect(calls[0]?.headers.authorization).toBeUndefined();
    await client(fetchImpl, 'tok_123').invoke('identity.get');
    expect(calls[1]?.headers.authorization).toBe('Bearer tok_123');
  });
});

describe('successes that are not 200', () => {
  it('201 from entities.create is a success', async () => {
    const { fetchImpl } = stub(() => ok({ id: 'ent_new' }, 201));
    await expect(client(fetchImpl).invoke('entities.create', { body: { kind: 'task' } })).resolves.toEqual({ id: 'ent_new' });
  });

  it('202 from tracking.refresh is a success', async () => {
    const { fetchImpl } = stub(() => ok({ accepted: 2 }, 202));
    const res = await client(fetchImpl).invokeDetailed('tracking.refresh', { body: {} });
    expect(res).toEqual({ data: { accepted: 2 }, requestId: 'req_env', status: 202 });
  });

  it('204 carries no envelope and is not treated as drift', async () => {
    const { fetchImpl } = stub(() => new Response(null, { status: 204 }));
    await expect(client(fetchImpl).invoke('entities.delete', { params: { id: 'ent_1' } })).resolves.toBeUndefined();
  });
});

describe('the three response shapes', () => {
  it('classifies every shape explicitly', () => {
    expect(responseMode('entities.get')).toBe('envelope');
    expect(responseMode('files.download')).toBe('bytes');
    expect(responseMode('bridge.fetchBlob')).toBe('bytes');
    expect(responseMode('events.subscribe')).toBe('stream');
  });

  it('a WS row is a usage error and puts NOTHING on the wire', async () => {
    const { fetchImpl, calls } = stub(() => ok({}));
    const err = await client(fetchImpl).invoke('events.subscribe').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StreamOperationError);
    expect(exitCodeFor(err)).toBe(2);
    expect((err as CliError).hint).toContain('event watch');
    expect(calls).toHaveLength(0);
  });

  it('a bytes row refuses the envelope path, and an envelope row refuses download()', async () => {
    const { fetchImpl } = stub(() => ok({}));
    await expect(client(fetchImpl).invoke('files.download', { params: { fileEntityId: 'f_1' } })).rejects.toThrowError(/raw bytes/);
    await expect(client(fetchImpl).download('entities.get', { params: { id: 'ent_1' } })).rejects.toThrowError(/JSON envelope/);
  });

  it('download() returns the bytes untouched', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const { fetchImpl } = stub(() => new Response(png, { status: 200, headers: { 'content-type': 'image/png', 'x-tm8-request-id': 'req_blob' } }));
    const res = await client(fetchImpl).download('files.download', { params: { fileEntityId: 'f_1' } });
    expect([...res.bytes]).toEqual([...png]);
    expect(res.contentType).toBe('image/png');
    expect(res.requestId).toBe('req_blob');
  });

  it('a failed download is still a typed contract error — that is how reserved rows answer', async () => {
    const { fetchImpl } = stub(() => wireError(501, 'not_implemented'));
    const err = await client(fetchImpl).download('bridge.fetchBlob', { params: { fileEntityId: 'f_1' } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('not_implemented');
    expect(exitCodeFor(err)).toBe(8);
  });
});

describe('failure classification', () => {
  it('a DEV-8 body becomes a typed ApiError carrying reason and requestId', async () => {
    const { fetchImpl } = stub(() => wireError(403, 'forbidden', { reason: 'use_message_send' }));
    const err = await client(fetchImpl).invoke('execution.prompt', { params: { id: 'ws_1' }, body: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).reason).toBe('use_message_send');
    expect((err as ApiError).requestId).toBe('req_err');
    expect((err as ApiError).operation).toBe('execution.prompt');
    expect(exitCodeFor(err)).toBe(4);
  });

  it('a 200 without the DEV-6 envelope is a protocol failure (10), not a silent success', async () => {
    const { fetchImpl } = stub(() => new Response(JSON.stringify({ whoops: true }), { status: 200 }));
    const err = await client(fetchImpl).invoke('identity.get').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProtocolError);
    expect(exitCodeFor(err)).toBe(10);
  });

  it('a non-contract error body is a protocol failure (10) — never a guessed taxonomy code', async () => {
    const { fetchImpl } = stub(() => new Response('<html>500</html>', { status: 500 }));
    const err = await client(fetchImpl).invoke('identity.get').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProtocolError);
    expect(exitCodeFor(err)).toBe(10);
    expect((err as ProtocolError).message).toContain('identity.get');
  });

  it('but a non-contract 503 is still retryable (7)', async () => {
    const { fetchImpl } = stub(() => new Response('<html>lb</html>', { status: 503 }));
    expect(exitCodeFor(await client(fetchImpl).invoke('identity.get').catch((e: unknown) => e))).toBe(7);
  });

  it('an unreachable Server is retryable transport (7) and names the base url', async () => {
    const fetchImpl = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    const err = await client(fetchImpl).invoke('identity.get').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect(exitCodeFor(err)).toBe(7);
    expect((err as TransportError).message).toContain('http://127.0.0.1:4610');
  });
});

describe('pathParamNames', () => {
  it('reads the params off the catalog rather than a hand-list', () => {
    expect(pathParamNames('spaces.invites.revoke')).toEqual(['spaceId', 'inviteId']);
    expect(pathParamNames('identity.get')).toEqual([]);
  });
});
