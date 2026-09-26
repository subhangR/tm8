/**
 * The HTTP seam: catalog binding, the three response shapes, and the exact
 * failure classification each one produces.
 *
 * Every path in this package comes from `bindPath(<operationName>)`. The test
 * that guards it is the one asserting the URL the client actually requested
 * equals the catalog's own path — a hand-written literal would pass a "did it
 * 200" test and fail this one.
 */
import { describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { getOperation } from '@tm8/contract';
import { Tm8Client, gapRetryKind, pathParamNames, responseMode } from '../src/client.js';
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

  it('names an expired request deadline instead of accusing the Server', async () => {
    const fetchImpl = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as typeof fetch;
    const timedClient = new Tm8Client({
      baseUrl: 'http://127.0.0.1:4610', fetchImpl, timeoutMs: 1,
    });
    const err = await timedClient.invoke('identity.get').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as TransportError).message).toContain('timed out after 1ms');
    expect((err as TransportError).message).toContain('per-request deadline');
    expect((err as TransportError).message).not.toContain('is tm8-server running');
  });

  it('keeps the deadline armed through the body: headers then a stalled body times out', async () => {
    // A REAL socket, not a stub: `fetch` resolves on the headers, and the defect
    // lived in the gap after that — the timer was cleared there and `res.text()`
    // waited on a body that never finished, forever. Only a real server that
    // sends headers and then stalls reaches that state.
    const sockets = new Set<Socket>();
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"data":{"items":[');
    });
    server.on('connection', (s) => { sockets.add(s); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const stalled = new Tm8Client({ baseUrl: `http://127.0.0.1:${port}`, timeoutMs: 300 });
      const t0 = Date.now();
      const err = await stalled
        .invoke('events.poll', { params: { spaceId: '00000000-0000-7000-8000-0000000000a1' } })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TransportError);
      expect(exitCodeFor(err)).toBe(7);
      expect((err as TransportError).message).toContain('timed out after 300ms reading the response body');
      expect(Date.now() - t0).toBeLessThan(5_000);
    } finally {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 10_000);
});

describe('pathParamNames', () => {
  it('reads the params off the catalog rather than a hand-list', () => {
    expect(pathParamNames('spaces.invites.revoke')).toEqual(['spaceId', 'inviteId']);
    expect(pathParamNames('identity.get')).toEqual([]);
  });
});

describe('restart-gap retry (agent calls survive a server restart)', () => {
  // What undici actually throws, not a hand-written Error: the errno rides on
  // `cause.code` under a generic `TypeError('fetch failed')`.
  const fetchFailed = (code: string): TypeError =>
    Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error(`connect ${code} 127.0.0.1:4610`), { code }),
    });

  /** Fails with `code` for the first `failures` calls, then answers. */
  function flaky(failures: number, code: string): { fetchImpl: typeof fetch; calls: () => number } {
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      if (n <= failures) throw fetchFailed(code);
      return ok({ id: 'ent_1' });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls: () => n };
  }

  const gapClient = (fetchImpl: typeof fetch, gapRetryMs: number, slept: number[] = []): Tm8Client =>
    new Tm8Client({
      baseUrl: 'http://127.0.0.1:4610',
      fetchImpl,
      gapRetryMs,
      sleepImpl: async (ms) => { slept.push(ms); },
    });

  it('classifies the refusal a CLOSED PORT really produces, through real fetch', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const err = await fetch(`http://127.0.0.1:${port}/health`).catch((e: unknown) => e);
    expect(gapRetryKind(err)).toBe('refused');
  });

  it('re-sends a COMMAND while the connect is refused, then succeeds, with backoff', async () => {
    const { fetchImpl, calls } = flaky(3, 'ECONNREFUSED');
    const slept: number[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const data = await gapClient(fetchImpl, 60_000, slept).invoke('messages.post', { body: { body: 'hi' } });
      expect(data).toEqual({ id: 'ent_1' });
      expect(calls()).toBe(4);
      expect(slept).toEqual([250, 500, 1_000]);
      // Announced once, not once per attempt.
      expect(stderr.mock.calls.filter(([c]) => String(c).includes('unreachable'))).toHaveLength(1);
    } finally {
      stderr.mockRestore();
    }
  });

  it('never re-sends a command after a RESET: it may already have committed', async () => {
    const { fetchImpl, calls } = flaky(1, 'ECONNRESET');
    const err = await gapClient(fetchImpl, 60_000).invoke('messages.post', { body: { body: 'hi' } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect(calls()).toBe(1);
  });

  it('re-sends a READ after a reset', async () => {
    const { fetchImpl, calls } = flaky(2, 'UND_ERR_SOCKET');
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(gapClient(fetchImpl, 60_000).invoke('identity.get')).resolves.toEqual({ id: 'ent_1' });
      expect(calls()).toBe(3);
    } finally {
      stderr.mockRestore();
    }
  });

  it('a window of 0 (a human at a terminal) fails on the first refusal', async () => {
    const { fetchImpl, calls } = flaky(1, 'ECONNREFUSED');
    const err = await gapClient(fetchImpl, 0).invoke('identity.get').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect(exitCodeFor(err)).toBe(7);
    expect(calls()).toBe(1);
  });

  it('is BOUNDED: a node that never returns fails once the window is spent, and says so', async () => {
    const { fetchImpl, calls } = flaky(Number.POSITIVE_INFINITY, 'ECONNREFUSED');
    // A real clock: the window is wall time, so the sleeps must actually pass.
    const client = new Tm8Client({ baseUrl: 'http://127.0.0.1:4610', fetchImpl, gapRetryMs: 1_000 });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const t0 = Date.now();
      const err = await client.invoke('identity.get').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).message).toContain('after retrying for');
      expect(calls()).toBeGreaterThan(1);
      expect(Date.now() - t0).toBeLessThan(2_500);
    } finally {
      stderr.mockRestore();
    }
  });

  it('carries an agent call across a REAL restart: port closed, then a node comes back on it', async () => {
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const back = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { back: true }, requestId: 'req_back' }));
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const restarted = setTimeout(() => back.listen(port, '127.0.0.1'), 700);
    try {
      const agent = new Tm8Client({ baseUrl: `http://127.0.0.1:${port}`, gapRetryMs: 10_000 });
      await expect(agent.invoke('messages.post', { body: { body: 'during the gap' } })).resolves.toEqual({ back: true });
    } finally {
      clearTimeout(restarted);
      stderr.mockRestore();
      await new Promise<void>((resolve) => back.close(() => resolve()));
    }
  }, 15_000);
});
