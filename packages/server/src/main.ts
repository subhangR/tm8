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
import {
  createWsServer,
  InMemorySeqSource,
  registerEventHandlers,
  SubscriptionRegistry,
  WorkspaceEventPublisher,
} from './events/index.js';
import { createExecutionRuntime } from './facade/execution-handlers.js';
import { HandlerRegistry, registerFacadeHandlers } from './facade/index.js';
import { resolveLoopbackOwner } from './identity/loopback.js';
import { loadConfig, type ServerConfig } from './http/config.js';
import { createFacadeServer, type FacadeServer } from './http/server.js';
import type { IdentityResolver } from './http/types.js';
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

  /**
   * The execution block builds its OWN PtyHostService and hands it back.
   *
   * It has to. `PtyHostService` takes `onSessionStatus` only at construction,
   * and that sink must close over the SpawnService holding the spawner's
   * claims — `work_session_transition` → `require_space_member` →
   * `require_identity` has no node-admin bypass (002_identity.sql:297). A host
   * constructed here and passed in could not carry that sink, so a PTY exiting
   * would raise 42501, the transition would be dropped, and the work_session
   * would sit at 'running' forever: a ghost the UI paints as a live agent and
   * the concurrency cap counts against every future spawn. Silent, and it
   * compounds. Hence `createExecutionRuntime` rather than a symmetrical
   * `registerExecutionHandlers` here.
   */
  const execution = db ? createExecutionRuntime({ db, config }) : undefined;

  if (db) {
    registerFacadeHandlers(registry, { db, config });
    registerEventHandlers(registry, { db, config });
    execution?.register(registry);
  }

  const subscriptions = new SubscriptionRegistry();
  // The in-memory seq source is a SKELETON stand-in. At W2 it is replaced by
  // the per-space monotonic counter on `workspace_events` (AM-2 §3) — one
  // interface, one file, no reshaping of anything downstream.
  const events = new WorkspaceEventPublisher(new InMemorySeqSource(), subscriptions);
  const ws = createWsServer({ registry: subscriptions });

  /**
   * ONE identity path for every handler.
   *
   * The frame's default resolver reports `auto-owner` with no identityId,
   * because the skeleton had no database to look one up in. The facade block
   * grew its own owner resolver over `Db` — which was fine while it was the
   * only consumer, and wrong the moment a second block read `ctx.identity`:
   * the execution handlers correctly derived their claims from the request
   * context, got an undefined identityId, and every spawn died with
   * `28000 no identity bound to this transaction`. Neither lane was at fault;
   * the composition root was, for leaving two paths where there should be one.
   *
   * Resolving it here means `ctx.identity` carries the real owner for every
   * handler in the process, and any future block gets it for free.
   */
  const identityResolver: IdentityResolver | undefined = db
    ? async () => {
        const owner = await resolveLoopbackOwner(db);
        return { kind: 'auto-owner', identityId: owner.identityId };
      }
    : undefined;

  const server = createFacadeServer({
    config,
    registry,
    upgrades: ws,
    ...(identityResolver ? { identityResolver } : {}),
    ...(config.uiDir ? { staticHandler: createStaticHandler(config.uiDir) } : {}),
    // The browser session terminal reads a live PTY's sanitized scrollback here.
    // getReplay is the same offset-replay seam attach() uses, minus the live
    // subscription — a poll, not a stream, which needs no WS proxy and cannot
    // corrupt the scrollback ring. Absent on a database-less node.
    ...(execution
      ? {
          ptyOutput: (sessionId: string, offset: number) => {
            const r = execution.pty.getReplay(sessionId, offset);
            return r ? { base: r.base, gap: r.gap, next: r.next, data: r.data } : null;
          },
        }
      : {}),
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
