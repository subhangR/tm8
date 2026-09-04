import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  MOUNTED_OPERATIONS,
  OPERATIONS,
  RESERVED_OPERATIONS,
  V1_OPERATIONS,
  WireErrorBodySchema,
  bindPath,
  type OperationBinding,
  type OperationName,
} from '@tm8/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z, type ZodTypeAny } from 'zod';

import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import { registerEventHandlers } from '../../src/events/handlers.js';
import { createExecutionRuntime } from '../../src/facade/execution-handlers.js';
import { INPUT_SCHEMAS, registerFacadeHandlers } from '../../src/facade/index.js';
import { HandlerRegistry } from '../../src/facade/registry.js';
import { createW2BlobStore } from '../../src/files/w2-blob-store.js';
import type { ServerConfig } from '../../src/http/config.js';
import { createFacadeServer, type FacadeServer } from '../../src/http/server.js';

const ROUTE_PARAM = '00000000-0000-7000-8000-000000000015';

class InventoryDb implements Db {
  async tx<T>(_claims: DbClaims, fn: (q: Querier) => Promise<T>): Promise<T> {
    return fn({
      query: async <R>(): Promise<R[]> => [],
      rpc: async <T>(): Promise<T> => ({}) as T,
    });
  }

  async query<R>(): Promise<R[]> {
    return [];
  }

  async rpc<T>(): Promise<T> {
    return {} as T;
  }

  async end(): Promise<void> {}
}

function pathFor(operation: OperationBinding): string {
  const params = Object.fromEntries(
    [...operation.path.matchAll(/:([A-Za-z][A-Za-z0-9]*)/g)]
      .map((match) => [match[1]!, ROUTE_PARAM]),
  );
  return bindPath(operation.name as OperationName, params);
}

function registerProductionHandlers(
  registry: HandlerRegistry,
  db: Db,
  config: ServerConfig,
  dataDir: string,
): void {
  const blobStore = createW2BlobStore({ dataDir, maxSizeBytes: 4096 });
  registerFacadeHandlers(registry, {
    db,
    config,
    files: { blobStore, maxSizeBytes: 4096 },
  });
  registerEventHandlers(registry, { db, config });
  createExecutionRuntime({ db, config, dataDir }).register(registry);
}

describe('W2.G15 catalog and production-handler accounting', () => {
  let dataDir: string;
  let server: FacadeServer;
  let baseUrl: string;
  let registry: HandlerRegistry;
  let residual: readonly OperationBinding[];

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'tm8-w2-g15-'));
    const config: ServerConfig = {
      host: '127.0.0.1',
      port: 0,
      uiDir: undefined,
      maxBodyBytes: 1024 * 1024,
      databaseUrl: undefined,
      dataDir,
      fileMaxSizeBytes: 4096,
    };
    const db = new InventoryDb();
    registry = new HandlerRegistry();
    registerProductionHandlers(registry, db, config, dataDir);

    const mounted = new Set(registry.implemented());
    residual = OPERATIONS.filter(
      (operation) => operation.method !== 'WS'
        && operation.status === 'v1'
        && !mounted.has(operation.name as OperationName),
    );
    console.info(
      `[W2.G15 residual] mounted=${mounted.size} residual=${residual.length} `
        + residual.map(({ name }) => name).join(','),
    );

    server = createFacadeServer({
      config,
      registry,
      identityResolver: async () => ({ kind: 'auto-owner', identityId: ROUTE_PARAM }),
    });
    baseUrl = (await server.listen()).url;
  });

  afterAll(async () => {
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  it('keeps the exact 197 = 195 v1 + 2 reserved, 195 mounted HTTP + 1 mounted WS boundary (+25 177)', () => {
    // A21 (execution.liveness), then voice.token.create, are the +1s on every axis they touch.
    // The six artifacts rows (create/publish/revisions.list/preview.start/export/restore) are
    // the latest +6 on OPERATIONS and V1: +4 POST commands, +2 GET reads.
    // 120 -> 121 (2026-08-01): identity.profile.update (Identity v2 Stage 0),
    // one POST command.
    // 121 -> 126 (2026-08-02): auth.signup/login/logout/session.get (Identity v2 Stage 1).
    // 126 -> 127 (2026-08-02): execution.launch, one GET read.
    // 127 -> 128 (2026-08-07): execution.transcript, one GET read.
    // 128 -> 129 (2026-08-09): projects.branches.list, one GET read.
    // 129 -> 131 (2026-08-09): projects.contention + entities.commands.gate.
    // 137 -> 138 (2026-08-09, merge): execution.dispatch.
    // 144 -> 150 (2026-08-12, Git UI landing): the six execution.git* rows —
    // gitStatus/gitDiff (GET reads), gitCheckpoint/gitRollback/gitCommit/
    // gitMerge (POST commands).
    // 157 -> 158 (2026-08-13, forge write): tracking.pr.merge, one POST command.
    expect(OPERATIONS).toHaveLength(197); // +25 (177) containers, MEASURED
    expect(V1_OPERATIONS).toHaveLength(195);
    expect(RESERVED_OPERATIONS.map(({ name }) => name)).toEqual([
      'search.query',
      'bridge.fetchBlob',
    ]);
    // TWO WS ROWS now, one mounted socket: `containers.stream` re-declares
    // `events.subscribe`'s binding under the container family's own name.
    expect(OPERATIONS.filter(({ method }) => method !== 'WS')).toHaveLength(195);
    expect(OPERATIONS.filter(({ method }) => method === 'WS')).toEqual([
      expect.objectContaining({ name: 'events.subscribe', path: '/v2/ws', status: 'v1' }),
      // The alias, and it must declare itself as one: `aliasOf` is what keeps
      // it out of MOUNTED_OPERATIONS and out of the uniqueness assertions. A
      // second WS row WITHOUT it would be a genuine duplicate binding.
      expect.objectContaining({
        name: 'containers.stream', path: '/v2/ws', status: 'v1', aliasOf: 'events.subscribe',
      }),
    ]);
    // 123 -> 124 (2026-08-02): execution.launch again. It is the same +1 as the
    // 126 -> 127 above, and this pin was the one line of the four that did not get
    // bumped with it. The three assertions above FORCE this number: 125 v1 rows
    // minus the single v1 WS row (events.subscribe, asserted immediately above)
    // is 124 — a 123 here contradicts them rather than measuring anything.
    // execution.transcript moved it to 125; projects.branches.list moves it to 126.
    // 141: +3 v1 non-WS (auth.password.change, auth.invite.signup,
    // auth.claim.reissue) — 163 -> 166.
    expect(OPERATIONS.filter(
      ({ method, status }) => method !== 'WS' && status === 'v1',
    )).toHaveLength(193); // 169 -> 193 (177): the container handlers
  });

  it('mechanically partitions every mounted handler and every residual v1 HTTP operation', () => {
    const mounted = registry.implemented();
    const mountedSet = new Set(mounted);
    const registerable = OPERATIONS.filter(
      ({ method, status }) => method !== 'WS' && status === 'v1',
    );
    const invalidMounted = mounted.filter((name) => {
      const operation = OPERATIONS.find((candidate) => candidate.name === name);
      return operation?.method === 'WS' || operation?.status !== 'v1';
    });
    const overlap = residual.filter(({ name }) => mountedSet.has(name as OperationName));
    const combined = [...mounted, ...residual.map(({ name }) => name)].sort();

    expect(
      invalidMounted,
      `mounted handlers outside registerable v1 HTTP: ${invalidMounted.join(',')}`,
    ).toEqual([]);
    expect(overlap, `mounted/residual overlap: ${overlap.map(({ name }) => name).join(',')}`)
      .toEqual([]);
    expect(
      combined,
      `residual v1 HTTP (${residual.length}): ${residual.map(({ name }) => name).join(',')}`,
    ).toEqual(registerable.map(({ name }) => name).sort());
    expect(mountedSet.has('search.query')).toBe(false);
    expect(mountedSet.has('bridge.fetchBlob')).toBe(false);
  });

  it('returns a standard honest 501 for every mechanically derived residual binding', async () => {
    const failures: string[] = [];

    for (const operation of residual) {
      const response = await fetch(`${baseUrl}${pathFor(operation)}`, {
        method: operation.method,
      });
      const parsed = WireErrorBodySchema.safeParse(await response.json());
      if (
        response.status !== 501
        || !parsed.success
        || parsed.data.error.code !== 'not_implemented'
        || !parsed.data.error.message.includes(operation.name)
        || parsed.data.error.requestId !== response.headers.get('x-tm8-request-id')
      ) {
        failures.push(`${operation.name}:${response.status}`);
      }
    }

    expect(
      failures,
      `residual v1 HTTP (${residual.length}): ${residual.map(({ name }) => name).join(',')}`,
    ).toEqual([]);
  });
});

describe('W2.G15 reserved routes through the real frame', () => {
  let server: FacadeServer;
  let baseUrl: string;
  let registry: HandlerRegistry;

  beforeAll(async () => {
    registry = new HandlerRegistry();
    server = createFacadeServer({
      config: {
        host: '127.0.0.1',
        port: 0,
        uiDir: undefined,
        maxBodyBytes: 1024 * 1024,
        databaseUrl: undefined,
      },
      registry,
      identityResolver: async () => ({ kind: 'auto-owner', identityId: ROUTE_PARAM }),
    });
    baseUrl = (await server.listen()).url;
  });

  afterAll(async () => {
    await server.close();
  });

  it('keeps both reserved bindings catalog-known, non-registerable, and validation-proof 501s', async () => {
    const schemas = INPUT_SCHEMAS as unknown as Record<string, ZodTypeAny | undefined>;

    for (const operation of RESERVED_OPERATIONS) {
      expect(server.router.match(operation.method, pathFor(operation))?.opName).toBe(operation.name);
      expect(registry.has(operation.name as OperationName)).toBe(false);
      expect(() => registry.register(operation.name as OperationName, () => ({}))).toThrow(/reserved/);

      const previous = schemas[operation.name];
      schemas[operation.name] = z.never();
      try {
        const response = await fetch(
          `${baseUrl}${pathFor(operation)}?q=must-not-validate-before-handler-lookup`,
          { method: operation.method },
        );
        expect(response.status, `${operation.name} must never return 200 or 404`).toBe(501);
        const parsed = WireErrorBodySchema.safeParse(await response.json());
        expect(parsed.success, `${operation.name} must use the standard wire error`).toBe(true);
        if (parsed.success) {
          expect(parsed.data.error.code).toBe('not_implemented');
          expect(parsed.data.error.message).toContain(operation.name);
          expect(parsed.data.error.requestId).toBe(response.headers.get('x-tm8-request-id'));
          expect(parsed.data.error.retryable).toBe(false);
        }
      } finally {
        if (previous === undefined) delete schemas[operation.name];
        else schemas[operation.name] = previous;
      }
    }
  });

  it('returns a standard 404 not_found for an unknown HTTP path', async () => {
    const response = await fetch(`${baseUrl}/v2/w2-g15-unknown`);
    expect(response.status).toBe(404);
    const parsed = WireErrorBodySchema.safeParse(await response.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.error.code).toBe('not_found');
      expect(parsed.data.error.requestId).toBe(response.headers.get('x-tm8-request-id'));
      expect(parsed.data.error.retryable).toBe(false);
    }
  });

  it('keeps ONE mounted socket, and both WS rows outside HTTP handlers/routes', () => {
    // TWO WS ROWS, ONE SOCKET. `containers.stream` re-declares
    // `events.subscribe`'s `WS /v2/ws` so the container family's socket is
    // discoverable under its own name; it carries `aliasOf`, is excluded from
    // MOUNTED_OPERATIONS, and mounts nothing. The claim worth pinning is not
    // "there is one WS row" — it is that nothing MOUNTS a second socket.
    const ws = OPERATIONS.filter(({ method }) => method === 'WS');
    expect(ws.map(({ name }) => name)).toEqual(['events.subscribe', 'containers.stream']);
    expect(MOUNTED_OPERATIONS.filter(({ method }) => method === 'WS').map(({ name }) => name))
      .toEqual(['events.subscribe']);
    expect(registry.has('events.subscribe')).toBe(false);
    expect(registry.has('containers.stream')).toBe(false);
    expect(server.router.mounted().every(({ op }) => op.method !== 'WS')).toBe(true);
    expect(server.router.match('GET', '/v2/ws')).toBeUndefined();
    // The router is built from MOUNTED_OPERATIONS, so an alias never produces
    // a second route sharing one method+path.
    expect(server.router.mounted().map(({ op }) => op.name).sort()).toEqual(
      MOUNTED_OPERATIONS.filter(({ method }) => method !== 'WS').map(({ name }) => name).sort(),
    );
  });
});
