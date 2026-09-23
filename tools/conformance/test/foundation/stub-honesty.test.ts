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
  it('recognizes all 165 HTTP catalog bindings as 501, never 404', async () => {
    const http = OPERATIONS.filter(({ method }) => method !== 'WS');
    // 162 -> 165 (W4/132): the three spaces.taskWorkflows routes.
    // 171 -> 195 (2026-09-03): the 24 HTTP containers.* rows. MEASURED.
    // 195 -> 196 (187): execution.sessions.share mounts one POST route.
    // 195 -> 196 (2026-09-19, Changes surface phase 1): execution.gitStage. MEASURED.
    // 196 -> 197 (2026-09-19, Changes screen Phase 1 INTEGRATED WITH main): main's execution.sessions.share and this
    // branch's execution.gitStage BOTH land, so this moves twice. Git merged
    // the number line silently — only the comment beside it conflicted. MEASURED on the merged tree from this assertion's own failing run.
    // 2026-09-23 (filesystem skills INTEGRATED WITH main): skills.scan/list/show/preview, all v1 HTTP (3 GET/read, 1 POST/command). MEASURED on the merged tree.
    // 2026-09-23 F4 (#648): skills.roots/create/edit/equip/unequip, all mounted v1 HTTP. MEASURED on the merged tree.
    // 206 -> 207 (Jev lane F): launch.suggest. MEASURED.
    expect(http).toHaveLength(207);

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
