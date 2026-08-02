import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OPERATIONS, WireErrorBodySchema } from '@tm8/contract';
import { startStubServer, stopStubServer } from '../../src/stub-server.js';

let stub: Server;
let baseUrl: string;

beforeAll(async () => {
  stub = await startStubServer(0);
  const address = stub.address();
  if (!address || typeof address === 'string') throw new Error('stub did not expose a TCP address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await stopStubServer(stub);
});

function fixturePath(path: string): string {
  return path.replace(/:[A-Za-z][A-Za-z0-9]*/g, 'foundation-id');
}

describe('W1 stub route and honesty oracle', () => {
  it('recognizes all 126 HTTP catalog bindings as 501, never 404', async () => {
    const http = OPERATIONS.filter(({ method }) => method !== 'WS');
    expect(http).toHaveLength(126);

    for (const operation of http) {
      const response = await fetch(new URL(fixturePath(operation.path), baseUrl), {
        method: operation.method,
      });
      expect(response.status, `${operation.name} must be route-reachable`).toBe(501);
      const parsed = WireErrorBodySchema.safeParse(await response.json());
      expect(parsed.success, `${operation.name} must use the contract error envelope`).toBe(true);
      if (parsed.success) expect(parsed.data.error.code).toBe('not_implemented');
    }
  });

  it('keeps the two reserved operations honest and unknown routes distinct', async () => {
    for (const operation of OPERATIONS.filter(({ status }) => status === 'reserved')) {
      const response = await fetch(new URL(fixturePath(operation.path), baseUrl), {
        method: operation.method,
      });
      expect(response.status).toBe(501);
    }

    const unknown = await fetch(new URL('/v2/not-a-catalog-route', baseUrl));
    expect(unknown.status).toBe(404);
    const parsed = WireErrorBodySchema.safeParse(await unknown.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.error.code).toBe('not_found');
  });
});
