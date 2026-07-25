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
}

export async function bootstrap(opts: BootstrapOptions = {}): Promise<BootstrappedServer> {
  const config = opts.config ?? loadConfig();
  const registry = opts.registry ?? new HandlerRegistry();

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
  return { server, subscriptions, events, url };
}

export async function main(): Promise<void> {
  try {
    const { server, url } = await bootstrap();
    const { registry, router } = server;
    console.log(`tm8-server listening on ${url}`);
    console.log(
      `  catalog: ${router.mounted().length} HTTP operations mounted · ` +
        `${registry.size} implemented · the rest answer 501 not_implemented (DEV-13)`,
    );
    console.log(`  ws: /v2/ws  ·  health: ${url}/health`);

    const shutdown = (signal: string): void => {
      console.log(`\n${signal} — shutting down`);
      void server.close().then(
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
