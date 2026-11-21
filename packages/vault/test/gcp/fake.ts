import { createServer, type IncomingHttpHeaders, type Server, type ServerResponse } from 'node:http';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import type { TokenSource } from '../../src/gcp/token.js';

// Deliberately assembled at runtime; no credential-shaped literal in the tree.
export const fakeToken = ['test-only', 'access', 'token'].join('-');
export const tokens: TokenSource = { getAccessToken: async () => fakeToken };
export const keyName = 'projects/test-project/locations/test-location/keyRings/test-ring/cryptoKeys/test-key';
export const keyVersionName = `${keyName}/cryptoKeyVersions/1`;

export interface FakeRequest {
  method: string;
  url: URL;
  headers: IncomingHttpHeaders;
  bytes: Buffer;
  json(): Record<string, unknown>;
}
type Handler = (request: FakeRequest, response: ServerResponse) => void | Promise<void>;

export interface FakeServer {
  baseUrl: string;
  requests: FakeRequest[];
  handle: Handler;
}

/** Each network test gets a real loopback server and a deny-by-default fetch guard. */
export function loopbackSuite() {
  const servers: Server[] = [];
  const failures: unknown[] = [];
  beforeEach(() => {
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.hostname !== '127.0.0.1') throw new Error('test fetch: non-loopback refused');
      return nativeFetch(input, init);
    });
  });
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    }
    vi.unstubAllGlobals();
    expect(failures.splice(0)).toEqual([]);
  });
  return async function fake(handler: Handler): Promise<FakeServer> {
    const state: FakeServer = { baseUrl: '', requests: [], handle: handler };
    const server = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const bytes = Buffer.concat(chunks);
        const record: FakeRequest = {
          method: request.method ?? '', url: new URL(request.url ?? '/', state.baseUrl), headers: request.headers,
          bytes, json: () => JSON.parse(bytes.toString('utf8')) as Record<string, unknown>,
        };
        state.requests.push(record);
        await state.handle(record, response);
      } catch (error) {
        failures.push(error);
        response.writeHead(500).end('test server failed');
      }
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server unavailable');
    state.baseUrl = `http://127.0.0.1:${address.port}`;
    return state;
  };
}

export function json(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

export async function rejected(promise: Promise<unknown>): Promise<Error> {
  try { await promise; }
  catch (error) {
    expect(error).toBeInstanceOf(Error);
    return error as Error;
  }
  throw new Error('test expected rejection');
}

export function expectSanitized(error: Error, ...extra: string[]): void {
  const properties = Object.fromEntries(Object.getOwnPropertyNames(error).map((name) => [name, Reflect.get(error, name)]));
  const representations = [String(error), error.stack ?? '', JSON.stringify(properties)];
  expect(error).not.toHaveProperty('cause');
  for (const representation of representations) {
    for (const marker of [fakeToken, ...extra]) expect(representation).not.toContain(marker);
  }
}
