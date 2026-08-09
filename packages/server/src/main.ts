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
import type { IncomingMessage } from 'node:http';
import { CollabError, FILE_MAX_SIZE_BYTES_DEFAULT } from '@tm8/contract';
import { ensureLaunchResources } from './bootstrap/launch-resources.js';

import { createDb } from './db/index.js';
import type { Db, DbClaims } from './db/types.js';
import {
  createControlChannel,
  createDurableEventPump,
  createWsServer,
  DbSubscriptionAuthorizer,
  InMemoryPresenceStore,
  InMemorySeqSource,
  PgDurableEventLog,
  PgDurableSeqSource,
  registerEventHandlers,
  SubscriptionRegistry,
  WorkspaceEventPublisher,
} from './events/index.js';
import { createExecutionRuntime, createLoopExecutorPort } from './facade/execution-handlers.js';
import { createDefaultScheduler, type Scheduler } from './scheduler/index.js';
import { commandEnvelope } from './facade/context.js';
import { createW2ExecutionDelivery, verifyDeliveryPrincipal } from './facade/services/w2/execution.js';
import { HandlerRegistry, registerFacadeHandlers } from './facade/index.js';
import { createW2BlobStore } from './files/w2-blob-store.js';
import { createClipboardStore } from './files/clipboard-store.js';
import { createLoopbackOwnerResolver } from './identity/loopback.js';
import { TOKEN_PREFIX } from './identity/crypto.js';
import { resolveBearerIdentity } from './identity/pg-auth.js';
import {
  loadConfig,
  resolveClipboardDir,
  resolveServerDataDir,
  type ServerConfig,
} from './http/config.js';
import { createArtifactPreviewServer } from './http/artifact-preview.js';
import { createFacadeServer, type FacadeServer, type UpgradeTarget } from './http/server.js';
import type { IdentityResolver, RequestIdentity } from './http/types.js';
import { autoOwnerResolver } from './http/security.js';
import { createStaticHandler } from './http/static.js';
import { createRemoteServerProxy } from './http/remote-proxy.js';
import { createW2FileUploadRoute } from './http/w2-file-upload.js';
import { createClipboardUploadRoute } from './http/clipboard-upload.js';
import { createVoiceWebhookRoute } from './http/voice-webhook.js';
import { InMemoryVoiceRosterStore } from './voice/roster.js';
import { createPtyWsServer, isPtyUpgrade, type PtyAttachAuthorizer } from './pty/index.js';

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
  /**
   * Shutdown handle for the W2 B2 delivery pool, when one was configured.
   *
   * Deliberately narrowed to `close` alone. The wiring object also carries
   * `messageDelivery`, and exposing that here would make the delivery identity
   * reachable from anything holding a `BootstrappedServer` — which is every
   * test that boots a node. The pool, the port and the principal stay private
   * to the delivery service; this hands out the ability to CLOSE it and
   * nothing else.
   */
  readonly delivery: { close(): Promise<void> } | undefined;
  /**
   * The artifact-preview listener (design §9, second origin), when the node
   * is configured with one AND has a database to resolve capabilities
   * against. Narrowed to `url` + `close` for the same reason `delivery` is.
   */
  readonly preview: { readonly url: string; close(): Promise<void> } | undefined;
  /**
   * The R26 job runner, when this node has both a database and an execution
   * block. Narrowed to `stop` because the composition root owns its lifetime
   * and nothing else may register jobs onto it after boot.
   */
  readonly scheduler: Scheduler | undefined;
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
  const db = config.databaseUrl
    // `!== false`, not `=== true`: an absent field means "not overridden", and
    // must inherit the ON default rather than read as off.
    ? createDb(config.databaseUrl, {
        idempotencyEnabled: config.idempotencyEnabled !== false,
        ...(config.dbPoolMax !== undefined ? { max: config.dbPoolMax } : {}),
      })
    : undefined;
  const dataDir = config.dataDir ?? resolveServerDataDir();
  const fileMaxSizeBytes = config.fileMaxSizeBytes ?? FILE_MAX_SIZE_BYTES_DEFAULT;
  const owner = db ? createLoopbackOwnerResolver(db) : undefined;
  const blobStore = db ? createW2BlobStore({ dataDir, maxSizeBytes: fileMaxSizeBytes }) : undefined;
  // Node-local by construction: the directory hangs off THIS node's dataDir, so
  // a path minted here is only ever handed to a PTY this node owns.
  const clipboardStore = db
    ? createClipboardStore({
        clipboardDir: config.clipboardDir ?? resolveClipboardDir(process.env, dataDir),
        ...(config.clipboardMaxBytes !== undefined ? { maxBytes: config.clipboardMaxBytes } : {}),
        ...(config.clipboardRetentionDays !== undefined
          ? { retentionDays: config.clipboardRetentionDays }
          : {}),
      })
    : undefined;

  /**
   * ONE identity path for every transport. A valid tm8 session is resolved
   * independently of transport; every non-session request passes through the
   * guarded local-only owner arm before the database owner is attached.
   */
  const identityResolver: IdentityResolver | undefined = db
    ? async (headers, context) => {
        const header = headers.authorization;
        const raw = typeof header === 'string' ? header.replace(/^Bearer\s+/i, '').trim() : '';
        if (raw.startsWith(TOKEN_PREFIX)) {
          const session = await resolveBearerIdentity(db, raw);
          return {
            kind: 'bearer',
            identityId: session.identityId,
            nodeAdmin: session.isNodeAdmin,
            accountId: session.accountId,
            sessionId: session.sessionId,
            ...(session.workSessionId ? { workSessionId: session.workSessionId } : {}),
            token: raw,
            ...(session.actingAsTeamMemberId ? { actorId: session.actingAsTeamMemberId } : {}),
          };
        }

        const fallback = await autoOwnerResolver(headers, context);
        if (fallback.kind === 'anonymous') return fallback;
        const resolved = await owner!();
        return { kind: 'auto-owner', identityId: resolved.identityId };
      }
    : undefined;

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
  const execution = db ? createExecutionRuntime({ db, config, dataDir, owner }) : undefined;

  if (db && config.launchBootstrap) {
    const seeded = await ensureLaunchResources({
      db,
      owner: await owner!(),
      projectDir: config.launchProjectDir ?? process.cwd(),
    });
    if (seeded.spaces > 0) {
      console.log(
        `  launch bootstrap: ${seeded.spaces} space(s), project ${seeded.projectId}, ` +
          `${seeded.teammatesCreated} teammate(s) created, ${seeded.teammatesUpdated} repaired`,
      );
    }
  }

  // Ephemeral presence (DEV-4): in-process, no table, dies with the process.
  // Declared before the registration block because `presence.get` is only
  // mounted when a presence source exists — see registerEventHandlers.
  const presence = new InMemoryPresenceStore();

  // Voice-channel roster (voice plan §2). Ephemeral for the same reason
  // presence is, but sourced from LiveKit webhooks rather than from client
  // claims — see voice/roster.ts on why they are two stores and not one.
  const voiceRoster = new InMemoryVoiceRosterStore();

  /**
   * W2 B2's live delivery, and THE ONE PLACE A SECOND DATABASE IDENTITY IS
   * DECIDED ON.
   *
   * `TM8_DELIVERY_DATABASE_URL` must authenticate as `tm8_delivery_worker`.
   * Absent it, delivery is simply not wired and the node behaves exactly as it
   * did before — a stored message is still stored, it is just never pushed at a
   * live terminal. That is the honest degraded mode: `tm8_app` provably cannot
   * assume this role, so there is no fallback to invent.
   */
  const deliveryUrl = process.env['TM8_DELIVERY_DATABASE_URL'];
  // Fails the BOOT on a wrong-role URL — above the deliberately empty catch at
  // messages-handoffs.ts:351 that swallows delivery failures. A lazy check would
  // be discarded there and the node would boot clean while silently delivering
  // nothing. This runs before `server.listen()`, so the node never serves.
  if (execution && deliveryUrl) await verifyDeliveryPrincipal(deliveryUrl);
  const delivery =
    execution && deliveryUrl
      ? createW2ExecutionDelivery({
          connectionString: deliveryUrl,
          pty: execution.pty,
          promptSettlement: execution.promptSettlement,
        })
      : undefined;

  if (db) {
    registerFacadeHandlers(registry, {
      db,
      config,
      owner,
      files: { blobStore: blobStore!, maxSizeBytes: fileMaxSizeBytes },
      ...(delivery ? { messageDelivery: delivery.messageDelivery } : {}),
      resolveAuthoredFromWorkSessionId: async (ctx) => {
        const claimed = commandEnvelope(ctx).workSessionId ?? null;
        const pinned = ctx.identity.kind === 'bearer'
          ? ctx.identity.workSessionId ?? null
          : null;
        if (pinned && claimed && pinned !== claimed) {
          throw new CollabError(
            'forbidden',
            'workSessionId does not match the authenticated agent session',
            { details: { reason: 'work_session_identity_mismatch' } },
          );
        }
        return pinned ?? claimed;
      },
    });
    registerEventHandlers(registry, { db, config, presence });
    // The delivery seam again, and narrow for the same reason it is narrow
    // above: `execution.dispatch` pushes a trusted envelope at a dispatcher's
    // terminal, which only the delivery role may do. Absent, a dispatch still
    // stores its request on the task and answers `undelivered`.
    execution?.register(
      registry,
      delivery ? { dispatchDelivery: delivery.messageDelivery } : {},
    );
  }

  const subscriptions = new SubscriptionRegistry();
  // NOT a stand-in for the durable sequence — that misreading is why this
  // comment was rewritten. The durable per-Space seq is a committed table row
  // (`public.space_event_seq`, 003:282) minted by the capture trigger inside
  // the mutating transaction, and the server only ever READS it. What the
  // publisher needs an in-memory counter for is the EPHEMERAL presence channel,
  // whose seq is channel-local by contract (DEV-4, contract §5) and is required
  // to reset on restart. `InMemorySeqSource` is an alias for `PresenceSeqSource`
  // (seq.ts:82); the old text told the next implementer to replace exactly the
  // thing that is already correct.
  const events = new WorkspaceEventPublisher(new InMemorySeqSource(), subscriptions);

  // The live event path. Before this, `publishDurable` had no production caller
  // at all, so no durable event reached a socket however well the log worked.
  const eventLog = db ? new PgDurableEventLog(db) : undefined;
  const wsClaimsFor = async (identity: RequestIdentity): Promise<DbClaims> => {
    if (!identity.identityId || identity.kind === 'anonymous') {
      throw new CollabError('unauthenticated', 'authentication is required');
    }
    return { identityId: identity.identityId, nodeAdmin: identity.nodeAdmin === true };
  };

  const pump = db && eventLog
    ? createDurableEventPump({
        registry: subscriptions,
        publisher: events,
        log: eventLog,
        claimsFor: wsClaimsFor,
        onError: (message) => console.warn(`event pump: ${message}`),
      })
    : undefined;

  /**
   * The durable high-water mark, read AS THE CALLER.
   *
   * This is `PgDurableSeqSource`'s first production caller. It is what lets a
   * fresh `subscribe` start at NOW instead of replaying the retained log, and
   * it is deliberately a per-request bound read: `space_event_seq` became
   * member-readable in db/migrations/035 (grant AND policy), so there is no
   * privileged or identity-less path here. `latest` returns null when the mark
   * cannot be established, and the control channel leaves such a subscription
   * unseeded rather than guessing zero.
   */
  const highWaterMark = db
    ? async (identity: RequestIdentity, spaceId: string): Promise<number | null> =>
        db.tx(await wsClaimsFor(identity), (q) => new PgDurableSeqSource(q).latest(spaceId))
    : undefined;

  const control = db && eventLog
    ? createControlChannel({
        registry: subscriptions,
        // The REAL authorizer, invoked on every subscribe and every resume.
        // There is no allow-all implementation left in the tree to fall back to.
        authorizer: new DbSubscriptionAuthorizer(db, wsClaimsFor),
        log: eventLog,
        claimsFor: wsClaimsFor,
        presence,
        ...(pump ? { cursors: pump } : {}),
        ...(highWaterMark ? { highWaterMark } : {}),
        onError: (message) => console.warn(`ws control frame: ${message}`),
      })
    : undefined;

  /** Browser sockets carry a pass in the grant URL because they cannot set headers. */
  const resolveSocketIdentity = async (req: IncomingMessage): Promise<RequestIdentity> => {
    const url = new URL(req.url ?? '/', 'http://tm8.invalid');
    const token = url.searchParams.get('token');
    const headers = token
      ? { ...req.headers, authorization: `Bearer ${token}` }
      : req.headers;
    const resolver = identityResolver ?? autoOwnerResolver;
    const identity = await resolver(headers, {
      remoteAddress: req.socket.remoteAddress,
      disableAutoOwner: config.disableAutoOwner === true,
    });
    if (identity.kind === 'anonymous') {
      throw new CollabError('unauthenticated', 'authentication is required');
    }
    return identity;
  };

  const ws = createWsServer({
    registry: subscriptions,
    authorize: resolveSocketIdentity,
    ...(control ? { onClientMessage: (conn, text) => void control.handle(conn, text) } : {}),
    onDisconnect: (connId) => {
      presence.dropConnection(connId);
      pump?.forget(connId);
    },
  });
  pump?.start();

  /**
   * The LIVE terminal socket, sharing the WS path with the event stream.
   *
   * Both sockets upgrade at `events.subscribe`'s catalog path; they are told
   * apart by the `sessionId` query param, which is exactly what the
   * `execution.streams.attach` grant hands the client
   * (`/v2/ws?sessionId=<id>`). Dispatching here keeps events/ws-server.ts
   * untouched and avoids inventing a second, off-contract path — tm8's WS path
   * is catalog-derived and must not be written as a literal.
   *
   * It is handed `execution.pty` — the SAME PtyHostService the spawn handlers
   * write to. A second host would have its own session map and every attach
   * would find no live PTY.
   */
  /**
   * PTY attach authorization (Identity v2 Stage 1, trap 5).
   *
   * Identity: browsers cannot set headers on a WebSocket, so a bearer caller
   * appends `&token=tm8s_…` to the grant URL; header auth works for
   * non-browser clients; no credential resolves to the loopback auto-owner,
   * exactly like every HTTP request (T-L7 — one resolver, one arm).
   *
   * Authorization: the caller must be able to SEE the work_session entity —
   * one RLS-governed read under their own claims as `tm8_app`. Membership of
   * the owning space is precisely what `entity_readable` encodes, so there
   * is no second authorization vocabulary here. Not-visible and nonexistent
   * are both 404: an outsider learns nothing about which ids are real.
   */
  const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const ptyAuthorize: PtyAttachAuthorizer | undefined = db
    ? async (req, sessionId) => {
        if (!UUID_SHAPE.test(sessionId)) {
          return { ok: false, status: 404, message: 'no such session' };
        }
        let identity: RequestIdentity;
        try {
          identity = await resolveSocketIdentity(req);
        } catch {
          return { ok: false, status: 401, message: 'authentication required' };
        }
        if (!identity.identityId) {
          return { ok: false, status: 401, message: 'authentication required' };
        }
        const visible = await db.query(
          { identityId: identity.identityId },
          'select 1 from public.entities where id = $1 and deleted_at is null',
          [sessionId],
        );
        if (visible.length === 0) return { ok: false, status: 404, message: 'no such session' };
        return { ok: true };
      }
    : undefined;

  const ptyWs = execution
    ? createPtyWsServer({
        pty: execution.pty,
        ...(ptyAuthorize ? { authorize: ptyAuthorize } : {}),
      })
    : undefined;
  const upgrades: UpgradeTarget = ptyWs
    ? {
        handleUpgrade: (req, socket, head) =>
          isPtyUpgrade(req)
            ? ptyWs.handleUpgrade(req, socket, head)
            : ws.handleUpgrade(req, socket, head),
        closeAll: () => {
          ptyWs.closeAll();
          ws.closeAll();
        },
      }
    : ws;

  const rawUpload = db && blobStore
    ? createW2FileUploadRoute({ deps: { db, config, owner: owner! }, blobStore })
    : undefined;

  const clipboardUpload = db && clipboardStore
    ? createClipboardUploadRoute({ deps: { db, config, owner: owner! }, store: clipboardStore })
    : undefined;

  const remoteServerProxy = db && owner
    ? createRemoteServerProxy(async (name) => {
        const nodeOwner = await owner();
        const rows = await db.query<{ base_url: string }>(
          {
            identityId: nodeOwner.identityId,
            nodeAdmin: nodeOwner.isNodeAdmin,
          },
          `select base_url from public.server_connections where lower(name) = lower($1)`,
          [name],
        );
        return rows[0]?.base_url ?? null;
      })
    : undefined;

  /**
   * The LiveKit webhook, and the FIRST PRODUCTION CALLER `publishPresence` has
   * ever had.
   *
   * Everything the ephemeral channel needs was already built — the seq source,
   * the validated envelope, the separate presence fan-out — and none of it was
   * wired to anything: `publishPresence` appeared exactly once in
   * `packages/server/src`, at its own definition, and every caller was a test.
   * Voice is what connects it. Nothing about presence changes here.
   *
   * The room→space lookup runs under the NODE OWNER's claims, not a caller's:
   * there is no request identity on a server-to-server callback, and the
   * webhook has already been proven to come from the SFU by its signature.
   */
  const voiceWebhook = config.livekit && db && owner
    ? createVoiceWebhookRoute({
        livekit: config.livekit,
        roster: voiceRoster,
        spaceOf: async (voiceChannelId) => {
          const nodeOwner = await owner();
          const rows = await db.query<{ space_id: string }>(
            { identityId: nodeOwner.identityId, nodeAdmin: nodeOwner.isNodeAdmin },
            `select space_id from public.voice_channels where entity_id = $1`,
            [voiceChannelId],
          );
          return rows[0]?.space_id;
        },
        publish: async (spaceId, voiceChannelId, participants) => {
          // No `spaceId` in the body: it is an envelope key, and
          // `publishPresence` stamps it along with the channel-local seq.
          // Passing it here would be the one place the two could disagree.
          await events.publishPresence(spaceId, {
            type: 'voice.participants.changed',
            voiceChannelId,
            participants: [...participants],
          });
        },
        log: (message) => console.warn(message),
      })
    : undefined;

  const server = createFacadeServer({
    config,
    registry,
    upgrades,
    // `select 1` through the SAME claim-binding pool the reads use — the only
    // probe that goes red when the pool is exhausted, which is the one outage
    // /health has actually failed to report.
    ...(db ? { healthProbe: async () => { await db.query({ nodeAdmin: false }, 'select 1'); } } : {}),
    ...(identityResolver ? { identityResolver } : {}),
    ...(rawUpload ? { fileUploadRoute: rawUpload } : {}),
    ...(clipboardUpload ? { clipboardUploadRoute: clipboardUpload } : {}),
    ...(voiceWebhook ? { voiceWebhookRoute: voiceWebhook } : {}),
    ...(remoteServerProxy ? { remoteServerProxy } : {}),
    ...(config.uiDir ? { staticHandler: createStaticHandler(config.uiDir) } : {}),
  });

  const { url } = await server.listen();

  // Retention, on boot and never on the request path: an expired date-bucket is
  // a directory removal, so this is cheap, and doing it here means a node that
  // is up keeps its handoff directory bounded without a scheduler.
  if (clipboardStore) {
    void clipboardStore
      .sweepExpired()
      .then((removed) => {
        if (removed > 0) console.log(`clipboard: swept ${removed} expired date bucket(s)`);
      })
      .catch((error: unknown) => {
        console.warn(`clipboard: retention sweep failed: ${String(error)}`);
      });
  }

  /**
   * The SECOND listener (design §9.2/§9.3): untrusted bundle content, on its
   * own origin, sharing no middleware with the app pipeline above. Started
   * only when the config carries a preview origin — loadConfig has already
   * refused to produce one that collides with the app origin — and only when
   * a database exists to resolve capabilities against: a preview listener
   * that can authenticate nothing should not be listening.
   */
  let preview: BootstrappedServer['preview'];
  if (config.preview && db && blobStore && owner) {
    const previewServer = createArtifactPreviewServer({
      preview: {
        ...config.preview,
        // An ephemeral APP port is the test harnesses' fingerprint (loadConfig
        // refuses 0 from an operator; tests substitute it after validation).
        // The preview listener follows suit so parallel harness boots never
        // race each other for 4613.
        port: config.port === 0 ? 0 : config.preview.port,
      },
      bindHost: config.host,
      db,
      blobStore,
      owner,
    });
    const listening = await previewServer.listen();
    preview = { url: listening.url, close: () => previewServer.close() };
    // Ride the composed server's close: every existing caller — harnesses
    // included — tears down with `server.close()` and must not leak the
    // second listener for not knowing it exists.
    const composedClose = server.close.bind(server);
    (server as { close: FacadeServer['close'] }).close = async () => {
      await previewServer.close().catch(() => undefined);
      await composedClose();
    };
  }

  /**
   * The R26 scheduler — CONSTRUCTED AND STARTED HERE, and until this commit
   * nowhere at all.
   *
   * `createDefaultScheduler` existed with backup and four retention jobs, and
   * every reference to it in the tree was a doc comment: no production path
   * ever built a `Scheduler`, so no scheduled job on this node has ever run.
   * The loop executor would have inherited exactly that fate — a `loop` kind, a
   * migration, a door and an executor, all reachable only from tests.
   *
   * NO SIDECAR IS PASSED, deliberately. Attaching one would register the daily
   * `pg_dump` and start taking backups on nodes that have never taken one,
   * which is a real operational change well outside this feature's remit and
   * belongs to whoever owns backups. The retention jobs registered alongside
   * are the W1 stubs: each reports `skipped` with a reason and touches nothing.
   *
   * AFTER listen(), like ghost reconciliation: a scheduled job must never be
   * able to delay or prevent the node accepting connections.
   */
  let scheduler: Scheduler | undefined;
  if (db && execution && owner) {
    const port = createLoopExecutorPort({
      db,
      pty: execution.pty,
      spawnService: execution.spawnService,
      resolveOwner: owner,
    });
    scheduler = createDefaultScheduler({ loops: { db, port } });
    scheduler.start();
  }

  /**
   * Retire the sessions this node left behind when it last died.
   *
   * A PTY lives in THIS process, so every restart kills its agents — but their
   * `work_sessions` rows stay at 'running', because the exit transition is
   * written by a sink that never runs for a process killed with its host. Those
   * ghosts show in the UI as live agents and each one burns a slot against the
   * 8-session concurrency cap permanently: a handful of dev restarts is enough
   * to make spawning fail with `session concurrency cap reached`.
   *
   * AFTER listen(), deliberately: this is cleanup, not a precondition, and it
   * must never be able to delay or prevent the node accepting connections. It
   * never rejects, so there is nothing to catch.
   */
  if (execution) {
    const retired = await execution.reconcileGhosts();
    if (retired > 0) {
      console.log(`  reconciled: retired ${retired} ghost session(s) left by a previous run`);
    }
  }

  return { server, subscriptions, events, url, db, delivery, preview, scheduler };
}

export async function main(): Promise<void> {
  try {
    const { server, url, db, delivery, preview, scheduler } = await bootstrap();
    const { registry, router } = server;
    console.log(`tm8-server listening on ${url}`);
    console.log(
      `  artifact preview: ${preview ? `${preview.url} (second origin, design §9)` : 'NOT RUNNING (needs a database and TM8_PREVIEW_ENABLED not 0)'}`,
    );
    console.log(
      `  catalog: ${router.mounted().length} HTTP operations mounted · ` +
        `${registry.size} implemented · the rest answer 501 not_implemented (DEV-13)`,
    );
    console.log(`  graph: ${db ? 'connected' : 'NOT CONFIGURED (set TM8_DATABASE_URL) — all operations answer 501'}`);
    console.log(`  delivery: ${delivery ? 'wired' : 'NOT CONFIGURED (set TM8_DELIVERY_DATABASE_URL) — messages are stored but never pushed to a live terminal'}`);
    console.log(
      `  scheduler: ${scheduler ? `${scheduler.status().jobs.length} job(s) running (loops + retention stubs; backup NOT attached)` : 'NOT RUNNING (needs a database and an execution block)'}`,
    );
    console.log(`  ws: /v2/ws  ·  health: ${url}/health`);

    // Close the pool as well as the listener. A pool left open holds the
    // process alive past the point the operator asked it to stop, which reads
    // as a hang rather than as the clean exit it nearly was.
    const shutdown = (signal: string): void => {
      console.log(`\n${signal} — shutting down`);
      void server
        .close()
        .then(() => scheduler?.stop())
        .then(() => preview?.close())
        .then(() => delivery?.close())
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
