/**
 * Bootstrap — assembles the frame and starts listening.
 *
 * This is the whole server today: a catalog-driven HTTP frame with an EMPTY
 * handler registry, a WS scaffold on `/v2/ws`, and a static seam for the
 * built UI bundle. It answers an honest `501 not_implemented` for every
 * operation, which is exactly what a node with no graph engine should say.
 *
 * W2 changes one line here — the registry gains handlers — and nothing else
 * about the frame moves.
 */
import { createDb } from './db/index.js';
import type { Db } from './db/types.js';
import { createWsServer, InMemorySeqSource, SubscriptionRegistry, WorkspaceEventPublisher } from './events/index.js';
import { HandlerRegistry } from './facade/index.js';
import { loadConfig, type ServerConfig } from './http/config.js';
import { createFacadeServer, type FacadeServer } from './http/server.js';
import { createStaticHandler } from './http/static.js';

export interface BootstrapOptions {
  readonly config?: ServerConfig;
  /**
   * Handlers to mount. Empty by default — see facade/registry.ts for why an
   * empty registry is the current acceptance criterion rather than a gap.
   */
  readonly registry?: HandlerRegistry;
}

export interface BootstrappedServer {
  readonly server: FacadeServer;
  readonly subscriptions: SubscriptionRegistry;
  readonly events: WorkspaceEventPublisher;
  readonly url: string;
  /**
   * The graph connection, when one was configured. Undefined on a
   * database-less node — see the guard in `bootstrap`. Callers that own the
   * process lifetime must `await db.end()` at shutdown.
   */
  readonly db: Db | undefined;
}

export async function bootstrap(opts: BootstrapOptions = {}): Promise<BootstrappedServer> {
  const config = opts.config ?? loadConfig();
  const registry = opts.registry ?? new HandlerRegistry();

  /**
   * The composition root, and the only place lanes are joined.
   *
   * Each block owns a directory and EXPORTS a `register*Handlers`; none of
   * them import each other and none of them construct a pool. That is what
   * keeps four concurrent lanes from editing the same file — and it is why
   * this is the one function that knows the whole server exists.
   *
   * No database configured means no handlers registered, which means every
   * operation keeps answering an honest 501 (DEV-13). That is deliberate: a
   * node with nowhere to read from should say it has not implemented the
   * operation, rather than boot successfully and then fail per-request with a
   * connection error that looks like an outage.
   */
  const db = config.databaseUrl ? createDb(config.databaseUrl) : undefined;
  if (db) {
    // Lane register functions land here as each block exports one:
    //   registerFacadeHandlers(registry, { db, config })      — facade slice
    //   registerEventHandlers(registry, { db, config })       — events.poll
    //   registerExecutionHandlers(registry, { db, pty, config }) — spawn/prompt
  }

  const subscriptions = new SubscriptionRegistry();
  // The in-memory seq source is a SKELETON stand-in. At W2 it is replaced by
  // the per-space monotonic counter on `workspace_events` (AM-2 §3) — one
  // interface, one file, no reshaping of anything downstream.
  const events = new WorkspaceEventPublisher(new InMemorySeqSource(), subscriptions);
  const ws = createWsServer({ registry: subscriptions });

  const server = createFacadeServer({
    config,
    registry,
    upgrades: ws,
    ...(config.uiDir ? { staticHandler: createStaticHandler(config.uiDir) } : {}),
  });

  const { url } = await server.listen();
  return { server, subscriptions, events, url, db };
}

export async function main(): Promise<void> {
  try {
    const { server, url, db } = await bootstrap();
    const { registry, router } = server;
    console.log(`tm8-server listening on ${url}`);
    console.log(
      `  catalog: ${router.mounted().length} HTTP operations mounted · ` +
        `${registry.size} implemented · the rest answer 501 not_implemented (DEV-13)`,
    );
    console.log(`  graph: ${db ? 'connected' : 'NOT CONFIGURED (set TM8_DATABASE_URL) — all operations answer 501'}`);
    console.log(`  ws: /v2/ws  ·  health: ${url}/health`);

    // Close the pool as well as the listener. A pool left open holds the
    // process alive past the point the operator asked it to stop, which reads
    // as a hang rather than as the clean exit it nearly was.
    const shutdown = (signal: string): void => {
      console.log(`\n${signal} — shutting down`);
      void server
        .close()
        .then(() => db?.end())
        .then(
          () => process.exit(0),
          () => process.exit(1),
        );
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  } catch (err) {
    // A config refusal (S1: non-loopback without token auth) lands here and
    // must be loud — a server that silently declines to start is worse than
    // one that never started.
    console.error(`tm8-server failed to start: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
