/**
 * W5 Duo C — real-Server harness for the schema-valid surface sweep.
 *
 * WHY THIS EXISTS RATHER THAN AN IMPORT of `test/w3/public-harness.ts`: that
 * path is frozen historical evidence. This file is a deliberate re-derivation
 * under this duo's own path, and it differs from the W3 helper in the one way
 * this duo needs — it exposes the live `HandlerRegistry` and `Router`, so a 501
 * seen at the wire can be attributed to the handler or to the router by reading
 * the registry rather than by parsing an error string.
 *
 * It boots the PRODUCTION composition root (`bootstrap()`), not a hand-assembled
 * registry. Nothing here constructs a `HandlerRegistry` or calls a `registerW2*`
 * function: if an operation is absent from the real composition, this harness
 * reports the production Server's honest 501 rather than papering over it.
 *
 * MIGRATIONS APPLIED: the full chain, enumerated by `migrationFiles()` — every
 * file in `db/migrations` matching `/^\d{3}_[a-z0-9_]+\.sql$/`, sorted. Never a
 * hand-listed slice. `appliedMigrations` is returned so the sweep can print
 * exactly what it ran against.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { bootstrap, type BootstrappedServer } from '../../../src/main.js';
import { loadConfig } from '../../../src/http/config.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../../db/w1-pg.js';

export interface SurfaceResponse {
  readonly status: number;
  readonly contentType: string | null;
  /** Error code from the wire envelope, or null for a success/non-JSON body. */
  readonly errorCode: string | null;
  /** Error message verbatim — the router's 501 and a handler's 501 differ here. */
  readonly errorMessage: string | null;
  /**
   * `error.details` verbatim. `server.ts:224` is the ONLY site that attaches
   * `{ issues }` alongside the exact message `request body failed contract
   * validation`, so this field is a third discriminator for a `:166` rejection,
   * independent of both the registry read and the in-process `safeParse`.
   */
  readonly errorDetails: unknown;
  readonly json: unknown;
}

export interface SurfaceServer {
  readonly baseUrl: string;
  readonly production: BootstrappedServer;
  readonly appliedMigrations: readonly string[];
  readonly database: W1ScratchDatabase;
  request(method: string, path: string, body: unknown): Promise<SurfaceResponse>;
  close(): Promise<void>;
}

export async function startSurfaceServer(label: string): Promise<SurfaceServer> {
  const database = await createW1ScratchDatabase(`w5c_${label}`);
  const dataDir = await mkdtemp(join(tmpdir(), 'tm8-w5c-'));
  const applied = migrationFiles();
  let production: BootstrappedServer | undefined;

  try {
    database.apply(applied);
    const configured = loadConfig({
      ...process.env,
      TM8_BIND: '127.0.0.1',
      TM8_PORT: '4610',
      TM8_DATABASE_URL: database.url,
      TM8_DATA_DIR: dataDir,
    });
    // `loadConfig` rejects port 0 for operator input by design; the already
    // validated config is amended afterward so the kernel assigns an isolated
    // ephemeral port without weakening production configuration validation.
    production = await bootstrap({ config: { ...configured, port: 0 } });
  } catch (error) {
    await database.destroy();
    await removeOwnedDataDir(dataDir);
    throw error;
  }

  const server = production;
  let closed = false;

  return {
    baseUrl: server.url,
    production: server,
    appliedMigrations: applied,
    database,

    async request(method, path, body): Promise<SurfaceResponse> {
      const response = await fetch(new URL(path, server.url), {
        method,
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });

      const text = await response.text();
      let json: unknown;
      try {
        json = text.length === 0 ? undefined : JSON.parse(text);
      } catch {
        // `files.download` answers with bytes, not the JSON envelope. A
        // non-JSON body is a legitimate answer here, not a parse failure.
        json = undefined;
      }

      const error = (json as {
        error?: { code?: unknown; message?: unknown; details?: unknown };
      } | undefined)?.error;
      return {
        status: response.status,
        contentType: response.headers.get('content-type'),
        errorCode: typeof error?.code === 'string' ? error.code : null,
        errorMessage: typeof error?.message === 'string' ? error.message : null,
        errorDetails: error?.details,
        json,
      };
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      await server.server.close();
      await server.db?.end();
      await database.destroy();
      await removeOwnedDataDir(dataDir);
    },
  };
}

async function removeOwnedDataDir(dataDir: string): Promise<void> {
  if (!basename(dataDir).startsWith('tm8-w5c-')) {
    throw new Error(`refusing to remove non-W5C data directory: ${dataDir}`);
  }
  await rm(dataDir, { recursive: true, force: true });
}
