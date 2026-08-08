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

  // 30s -> 120s. `harness.close()` ends with `database.destroy()`, which DROPS a
  // scratch database, and a drop is exactly the operation that slows down under
  // the parallel load this suite runs in — w2-execution.pg.test.ts measured the
  // same thing and raised its own teardown budget for it. All twenty w3 suites
  // shared this 30s, so whichever one lost the race reported `Hook timed out in
  // 30000ms` and the identity of the loser rotated between runs. A larger budget
  // costs nothing when teardown is fast.
  afterAll(async () => {
    await harness?.close();
  }, 120_000);

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
      // The pin was ALREADY red at 124 when this lane arrived (the four auth.*
      // rows landed without moving it); 125 adds `execution.launch`.
      // 125 -> 126: projects.directories.list, the onboarding GET. Two other
      // pins on the same number were moved with it and this one was not —
      // test/w2/rolling-public.integration.test.ts:660 and
      // test/w3/g15-public.test.ts:70 have read 126 since that commit.
      operations: 126,
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
    // Already red at 122 when this lane arrived (auth.*); 123 adds execution.launch.
    // 123 -> 124: projects.directories.list. Same commit, same omission as the
    // `operations` pin above; rolling-public.integration.test.ts:660 already
    // reads `implemented: 124`.
    expect(body.implemented).toBe(124);
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
