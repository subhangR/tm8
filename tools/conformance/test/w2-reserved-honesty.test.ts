import { OPERATIONS, RESERVED_OPERATIONS, V1_OPERATIONS } from '@tm8/contract';
import { describe, expect, it } from 'vitest';

import {
  readHandlerSourceInventory,
  readRouterSourceInventory,
} from '../src/foundations/source-inventory.js';

describe('W2.G15 current reserved and residual honesty accounting', () => {
  it('derives the exact catalog, reserved, WS, mounted, and residual sets from source', async () => {
    const [handlers, routes] = await Promise.all([
      readHandlerSourceInventory(),
      readRouterSourceInventory(),
    ]);
    const registerableV1Http = OPERATIONS.filter(
      ({ method, status }) => method !== 'WS' && status === 'v1',
    );
    const mounted = new Set(handlers.all);
    const residual = registerableV1Http.filter(({ name }) => !mounted.has(name));
    const invalidMounted = handlers.all.filter((name) => {
      const operation = OPERATIONS.find((candidate) => candidate.name === name);
      return operation?.method === 'WS' || operation?.status !== 'v1';
    });
    const overlap = residual.filter(({ name }) => mounted.has(name));

    console.info(
      `[W2.G15 residual] mounted=${mounted.size} residual=${residual.length} `
        + residual.map(({ name }) => name).join(','),
    );

    expect(OPERATIONS).toHaveLength(106);
    expect(V1_OPERATIONS).toHaveLength(104);
    expect(RESERVED_OPERATIONS.map(({ name }) => name)).toEqual([
      'search.query',
      'bridge.fetchBlob',
    ]);
    expect(routes.http).toHaveLength(105);
    expect(routes.ws.map(({ name }) => name)).toEqual(['events.subscribe']);
    expect(registerableV1Http).toHaveLength(103);

    expect(handlers.all).toEqual([...new Set(handlers.all)].sort());
    expect(
      invalidMounted,
      `mounted handlers outside registerable v1 HTTP: ${invalidMounted.join(',')}`,
    ).toEqual([]);
    expect(overlap, `mounted/residual overlap: ${overlap.map(({ name }) => name).join(',')}`)
      .toEqual([]);
    expect(
      [...handlers.all, ...residual.map(({ name }) => name)].sort(),
      `residual v1 HTTP (${residual.length}): ${residual.map(({ name }) => name).join(',')}`,
    ).toEqual(registerableV1Http.map(({ name }) => name).sort());

    expect(mounted.has('search.query')).toBe(false);
    expect(mounted.has('bridge.fetchBlob')).toBe(false);
    expect(mounted.has('events.subscribe')).toBe(false);
    expect(routes.http.map(({ name }) => name).sort()).toEqual(
      OPERATIONS.filter(({ method }) => method !== 'WS').map(({ name }) => name).sort(),
    );
  });
});
