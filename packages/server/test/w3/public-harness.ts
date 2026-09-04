import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import type { QueryResultRow } from 'pg';
import { vi } from 'vitest';

import { bootstrap, type BootstrappedServer } from '../../src/main.js';
import { loadConfig } from '../../src/http/config.js';
import {
  createW1ScratchDatabase,
  migrationFiles,
  type W1ScratchDatabase,
} from '../db/w1-pg.js';

/**
 * THE 10-SECOND HOOK, RAISED ONCE FOR EVERY FILE THAT BOOTS THIS HARNESS.
 *
 * `startW3PublicServer` calls `database.apply(migrationFiles())`, and
 * `w1-pg.ts`'s `apply` runs `spawnSync(psql)` ONCE PER MIGRATION FILE. The cost
 * of a `beforeAll` here is therefore roughly (number of migrations × process
 * spawn), and it grows by one spawn every time anybody adds a migration —
 * measured at ~12.7s for 143 files on a dev box.
 *
 * vitest's `hookTimeout` default is 10s, and none of the ~34 files that import
 * this harness ever raised it. That is why they abort as `Failed Suites` with
 * "Hook timed out in 10000ms" and ZERO failing assertions — a shape that reads
 * like a flake, recurs under load, and gets worse with each migration. It was
 * already firing on `main` (g06) before phase 5's migration 152 added the 143rd
 * spawn and pushed more of the family over.
 *
 * The W5 lane hit exactly this and documented it in as many words —
 * "hookTimeout 10s -> an UNNAMED file-level abort" (`sweep.test.ts`,
 * `activate.test.ts`, `conditional-501.test.ts`) — and fixed it with this same
 * `vi.setConfig`. Those files each set it themselves; setting it HERE covers
 * every current and future importer from one place, because the thing being
 * waited on belongs to the harness rather than to any one test.
 *
 * This raises a CEILING, it does not slow anything down: a hook that finishes
 * in two seconds still finishes in two seconds.
 */
vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

export interface PublicJsonResponse<T = unknown> {
  readonly status: number;
  readonly contentType: string | null;
  readonly requestIdHeader: string | null;
  readonly body: {
    readonly data?: T;
    readonly requestId?: string;
    readonly error?: {
      readonly code: string;
      readonly message: string;
      readonly requestId?: string;
      readonly details?: unknown;
    };
  };
}

export interface W3PublicServer {
  readonly baseUrl: string;
  readonly database: W1ScratchDatabase;
  readonly production: BootstrappedServer;
  readonly dataDir: string;
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<PublicJsonResponse<T>>;
  rows<R extends QueryResultRow = QueryResultRow>(sql: string, params?: readonly unknown[]): Promise<R[]>;
  close(): Promise<void>;
}

/**
 * Start the actual production composition root on an ephemeral loopback port.
 *
 * This helper deliberately does not construct a HandlerRegistry, import a W2
 * registration function, or call a handler. If an operation is absent from
 * `bootstrap()`/`main()` composition, its public response stays the production
 * Server's honest 501 and the W3 gate catches the missing wiring.
 */
export async function startW3PublicServer(label: string): Promise<W3PublicServer> {
  const database = await createW1ScratchDatabase(`w3_${label}`);
  const dataDir = await mkdtemp(join(tmpdir(), 'tm8-w3-'));
  let production: BootstrappedServer | undefined;

  try {
    database.apply(migrationFiles());
    const configured = loadConfig({
      ...process.env,
      TM8_BIND: '127.0.0.1',
      TM8_PORT: '4610',
      TM8_DATABASE_URL: database.url,
      TM8_DATA_DIR: dataDir,
    });
    // `loadConfig` correctly rejects port 0 for operator input. Tests replace
    // the already-validated port afterward so the kernel assigns one isolated
    // ephemeral port without weakening production configuration validation.
    const config = { ...configured, port: 0 };
    production = await bootstrap({ config });
  } catch (error) {
    await database.destroy();
    await removeOwnedDataDir(dataDir);
    throw error;
  }

  let closed = false;
  return {
    baseUrl: production.url,
    database,
    production,
    dataDir,
    async request<T = unknown>(method: string, path: string, body?: unknown): Promise<PublicJsonResponse<T>> {
      const response = await fetch(new URL(path, production.url), {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }),
      });
      const parsed = await response.json() as PublicJsonResponse<T>['body'];
      return {
        status: response.status,
        contentType: response.headers.get('content-type'),
        requestIdHeader: response.headers.get('x-tm8-request-id'),
        body: parsed,
      };
    },
    rows<R extends QueryResultRow = QueryResultRow>(
      sql: string,
      params: readonly unknown[] = [],
    ): Promise<R[]> {
      return database.query<R>(sql, params);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await production.server.close();
      await production.db?.end();
      await database.destroy();
      await removeOwnedDataDir(dataDir);
    },
  };
}

export function successData<T>(response: PublicJsonResponse<T>): T {
  if (response.status < 200 || response.status >= 300 || response.body.error || response.body.data === undefined) {
    throw new Error(`expected success, received ${response.status}: ${JSON.stringify(response.body)}`);
  }
  if (typeof response.body.requestId !== 'string' || response.body.requestId.length === 0) {
    throw new Error(`success envelope omitted requestId: ${JSON.stringify(response.body)}`);
  }
  if (response.requestIdHeader !== response.body.requestId) {
    throw new Error(
      `request ID header/body mismatch: ${String(response.requestIdHeader)} != ${response.body.requestId}`,
    );
  }
  return response.body.data;
}

export function errorCode(response: PublicJsonResponse): string {
  if (!response.body.error) {
    throw new Error(`expected error, received ${response.status}: ${JSON.stringify(response.body)}`);
  }
  const requestId = response.body.error.requestId ?? response.body.requestId;
  if (typeof requestId !== 'string' || requestId.length === 0) {
    throw new Error(`error envelope omitted requestId: ${JSON.stringify(response.body)}`);
  }
  if (response.requestIdHeader !== requestId) {
    throw new Error(`error request ID header/body mismatch: ${String(response.requestIdHeader)} != ${requestId}`);
  }
  return response.body.error.code;
}

async function removeOwnedDataDir(dataDir: string): Promise<void> {
  if (!basename(dataDir).startsWith('tm8-w3-')) {
    throw new Error(`refusing to remove non-W3 data directory: ${dataDir}`);
  }
  await rm(dataDir, { recursive: true, force: true });
}
