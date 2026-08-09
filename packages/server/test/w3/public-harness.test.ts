import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  errorCode,
  startW3PublicServer,
  type W3PublicServer,
} from './public-harness.js';

describe.sequential('W3 production-Server public harness', () => {
  let harness: W3PublicServer;

  beforeAll(async () => {
    harness = await startW3PublicServer('harness');
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  }, 30_000);

  it('starts the real database-backed production composition', async () => {
    const response = await fetch(`${harness.baseUrl}/health`);
    const body = await response.json() as {
      ok: boolean;
      server: string;
      operations: number;
      implemented: number;
    };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      server: 'tm8-server',
      // The pin was ALREADY red at 124 when this lane arrived: the four auth.*
      // rows and `execution.launch` landed without moving it, so main MEASURED
      // 126 against a pin of 124. `execution.transcript` makes it 127.
      // 127 -> 129 (2026-08-09): files.browse + files.read. This counts HTTP
      // ROUTES, so it trails OPERATIONS.length by the single WS row.
      operations: 129,
    });
    // Re-pinned at I02 (tranche-v2, G02 composed): 62 -> 73. Exact literal by
    // design so it keeps catching the next drift; never a range or a live value.
    // Re-pinned at tranche-v3 + 035: 62 -> 73 -> 98. Exact literal by design.
    // Re-pinned at A21 (D2, execution.liveness): 98 -> 99.
    // 99 is PRODUCTION's number: main.ts always constructs an
    // InMemoryPresenceStore and passes it, so `presence.get` is mounted here.
    // A registry built WITHOUT a presence source reports 98, which is a real
    // number about a configuration production does not use.
    // 114 -> 118 (2026-08-01): execution.resume, spaces.counts,
    // execution.journal, identity.profile.update.
    // Already red at 122 when this lane arrived: auth.* and execution.launch
    // landed without moving it, so main MEASURED 124 against a pin of 122.
    // `execution.transcript` makes it 125.
    // 125 -> 127 (2026-08-09): files.browse + files.read, both mounted.
    expect(body.implemented).toBe(127);
    expect(harness.production.server.registry.size).toBe(body.implemented);
    expect(harness.production.db).toBeDefined();
  });

  it('keeps reserved and unknown routes honestly distinct', async () => {
    const reserved = await harness.request('GET', '/v2/search?q=w3');
    expect(reserved.status).toBe(501);
    expect(errorCode(reserved)).toBe('not_implemented');

    const bridge = await harness.request(
      'GET',
      '/v2/bridge/blobs/00000000-0000-7000-8000-000000000001',
    );
    expect(bridge.status).toBe(501);
    expect(errorCode(bridge)).toBe('not_implemented');

    const unknown = await harness.request('GET', '/v2/not-a-catalog-route');
    expect(unknown.status).toBe(404);
    expect(errorCode(unknown)).toBe('not_found');
  });
});
