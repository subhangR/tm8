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
import { resolve as pathResolve } from 'node:path';
import { CollabError, FILE_MAX_SIZE_BYTES_DEFAULT } from '@tm8/contract';
import { CredentialSessionLauncher, NODE_BOOT_ID } from '@tm8/execution';
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
  createLivenessBroadcaster,
} from './events/index.js';
import { createExecutionRuntime, createLoopExecutorPort } from './facade/execution-handlers.js';
import type { ExecutionRuntime } from './facade/execution-handlers.js';
import { createDefaultScheduler, type Scheduler } from './scheduler/index.js';
import { commandEnvelope } from './facade/context.js';
import { createW2ExecutionDelivery, verifyDeliveryPrincipal } from './facade/services/w2/execution.js';
import { HandlerRegistry, registerFacadeHandlers } from './facade/index.js';
import { createW2BlobStore } from './files/w2-blob-store.js';
import { createDeletedFileBlobPurgeJob, createFileUploadSweepJob } from './scheduler/jobs/file-uploads.js';
import { createClipboardStore } from './files/clipboard-store.js';
import { createLoopbackOwnerResolver } from './identity/loopback.js';
import { createTrackingObserverJob } from './tracking/observer.js';
import { createCommitRecorderJob } from './tracking/commit-recorder.js';
import { createSessionIdentityResolver } from './http/identity-resolver.js';
import { createForgeWatcherJob } from './tracking/loops.js';
import {
  dispatchSessionMessages,
  type DispatchableRoute,
  type MessageDeliveryPort,
} from './facade/services/w2/message-dispatch.js';
import {
  loadConfig,
  resolveClipboardDir,
  resolveServerDataDir,
  type ServerConfig,
} from './http/config.js';
import { createArtifactPreviewHandler, createArtifactPreviewServer } from './http/artifact-preview.js';
import { createFacadeServer, type FacadeServer, type UpgradeTarget } from './http/server.js';
import type { IdentityResolver, RequestIdentity } from './http/types.js';
import { autoOwnerResolver } from './http/security.js';
import { announceNodeClaim } from './identity/node-claim-boot.js';
import { createStaticHandler } from './http/static.js';
import { createRemoteServerProxy } from './http/remote-proxy.js';
import { createW2FileUploadRoute } from './http/w2-file-upload.js';
import { createClipboardUploadRoute } from './http/clipboard-upload.js';
import { createVoiceWebhookRoute } from './http/voice-webhook.js';
import { InMemoryVoiceRosterStore } from './voice/roster.js';
import {
  createPtyAttachAuthorizer,
  createPtyAuditLogger,
  createPtyWsServer,
  isPtyUpgrade,
  type PtyAttachAuthorizer,
} from './pty/index.js';
import { readTm8SessionCookie } from './http/session-cookie.js';
import { WsAdmissionController } from './http/ws-admission.js';
import {
  ChatOrchestrator,
  ChatTurnPublisher,
  composeChatBootstrap,
  type AgentRuntime,
  type ResolveChatLaunchConfig,
} from './chat/index.js';

export interface ChatBootstrapOptions {
  readonly runtime: AgentRuntime;
  readonly resolveLaunchConfig: ResolveChatLaunchConfig;
  readonly onError?: (error: unknown) => void;
}

/**
 * Factory form: bootstrap owns db/dataDir construction, so a production
 * caller cannot build the chat block up front. main() passes
 * `composeChatBootstrap`; the factory runs only once a database exists.
 */
export type ChatBootstrapFactory = (ctx: {
  db: Db;
  dataDir: string;
  baseUrl: string;
}) => ChatBootstrapOptions;

export interface BootstrapOptions {
  readonly config?: ServerConfig;
  /** Provider runtime block or factory; absent stays 501. */
  readonly chat?: ChatBootstrapOptions | ChatBootstrapFactory;
  /**
   * Start the R26 scheduler and its periodic jobs.
   *
   * DEFAULT FALSE, and that default is the point. `bootstrap()` is called by
   * every production-parity test harness in the suite, each of which creates a
   * server against a scratch database and then drops it. A scheduler started
   * there is never stopped by anyone — it keeps polling a database that no
   * longer exists, for the lifetime of the test PROCESS, interfering with every
   * later test in the same worker. (Measured: four `w3/agentic` files started
   * failing when the observer was started unconditionally.)
   *
   * Background work belongs to a process that owns its own lifetime and can
   * shut it down. That is `main()`, which passes true and stops it on signal.
   */
  readonly startBackgroundJobs?: boolean;
  /**
   * Handlers to mount. Empty by default — see facade/registry.ts for why an
   * empty registry is the current acceptance criterion rather than a gap.
   */
  readonly registry?: HandlerRegistry;
}

export interface BootstrappedServer {
  readonly server: FacadeServer;
  /**
   * Present only when `startBackgroundJobs` was set. Whoever asked for it owns
   * stopping it — a started scheduler with no owner is the defect the option's
   * own docblock describes.
   */
  readonly scheduler?: Scheduler | undefined;
  readonly subscriptions: SubscriptionRegistry;
  readonly events: WorkspaceEventPublisher;
  readonly url: string;
  /**
   * The execution block, when this node has one. Exposed so whoever owns the
   * process lifetime can call `recordShutdown` before exiting — the reason a
   * session died is only knowable first-hand from the process it died with,
   * and after that only inferable (171).
   */
  readonly execution?: ExecutionRuntime | undefined;
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
   * The SECOND-ORIGIN artifact-preview listener (design §9), only when the
   * node is explicitly configured with one (TM8_PREVIEW_HOST/PORT) AND has a
   * database to resolve capabilities against. In the same-origin default the
   * renderer is a `/p/` route on the app socket and this stays undefined.
   * Narrowed to `url` + `close` for the same reason `delivery` is.
   */
  readonly preview: { readonly url: string; readonly port: number; close(): Promise<void> } | undefined;
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
   * ONE identity path for every transport — the rule lives in
   * `http/identity-resolver.ts` so a test can reach it; this is the wiring.
   */
  const identityResolver: IdentityResolver | undefined = db
    ? createSessionIdentityResolver({ db, owner: owner! })
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
  /**
   * HOISTED ABOVE THE EXECUTION BLOCK, and only because of the liveness push.
   *
   * The fan-out registry and the publisher are pure constructions — neither
   * takes a db, a config or anything that is not built yet — but the execution
   * runtime now needs a publisher to push `execution.liveness_changed` through,
   * and it is built here. Constructing them later and back-patching would mean
   * a window at boot in which a spawning session's transitions go nowhere,
   * which is precisely the class of silent gap the push exists to close.
   *
   * Their original declaration sites below are gone, not duplicated.
   */
  const subscriptions = new SubscriptionRegistry();
  // NOT a stand-in for the durable sequence — that misreading is why this
  // comment was rewritten. The durable per-Space seq is a committed table row
  // (`public.space_event_seq`, 003:282) minted by the capture trigger inside
  // the mutating transaction, and the server only ever READS it. What the
  // publisher needs an in-memory counter for is the EPHEMERAL channels, whose
  // seq is channel-local by contract (DEV-4, contract §5) and is required to
  // reset on restart. `InMemorySeqSource` is an alias for `PresenceSeqSource`
  // (seq.ts:82); the old text told the next implementer to replace exactly the
  // thing that is already correct.
  const events = new WorkspaceEventPublisher(new InMemorySeqSource(), subscriptions);

  /**
   * The liveness PUSH (T-L10: the graph announces, the socket delivers).
   *
   * `NODE_BOOT_ID` rides every event so a client can tell "this node restarted
   * and every PTY you knew about is gone" from "one session ended". Note what
   * is NOT wired: there is no boot-time push. A restart drops every socket, and
   * the client's reconnect path already forces a fresh liveness read — so the
   * one transition this cannot push is also the one that cannot be missed.
   */
  const livenessBroadcast = createLivenessBroadcaster({
    publisher: events,
    nodeBootId: NODE_BOOT_ID,
    onError: (message) => console.warn(`liveness push: ${message}`),
  });

  const execution = db
    ? createExecutionRuntime({ db, config, dataDir, owner, liveness: livenessBroadcast })
    : undefined;

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
  // `subscriptions` is declared above the execution block now — the liveness
  // push needs the publisher that needs this registry. See the note there.
  // Factory callers get the composed context; block callers pass through
  // unchanged (every test harness injects the block form directly).
  const chatBlock: ChatBootstrapOptions | undefined =
    db && opts.chat
      ? typeof opts.chat === 'function'
        ? opts.chat({ db, dataDir, baseUrl: `http://127.0.0.1:${config.port}` })
        : opts.chat
      : undefined;
  const chat = db && chatBlock
    ? new ChatOrchestrator({
        db,
        runtime: chatBlock.runtime,
        publisher: new ChatTurnPublisher(subscriptions),
        resolveLaunchConfig: chatBlock.resolveLaunchConfig,
        ...(chatBlock.onError ? { onError: chatBlock.onError } : {}),
        // F2: only the production (factory) composition gets the boot sweep —
        // block-form test harnesses must never see sweep queries.
        ...(typeof opts.chat === 'function'
          ? { sweepClaims: { identityId: (await owner!()).identityId, nodeAdmin: true } }
          : {}),
      })
    : undefined;
  if (chat && typeof opts.chat === 'function') void chat.reconcileOnBoot();

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

  /**
   * Tier B credentials. Built HERE because it needs the PTY host, and the PTY
   * host is a composition-root object: `createExecutionRuntime` owns it (it
   * takes `onSessionStatus` only at construction), and `delivery` above is
   * handed the very same instance. A second PtyHostService would be a second
   * process registry, so a login terminal started through one would be
   * invisible to the other's kill.
   *
   * Conditional on `execution` for the same reason `delivery` is: with no
   * runtime there is no PTY, and these four operations start real processes.
   * Absent, they are simply not mounted — the honest degraded mode.
   */
  const credentials = execution
    ? { launcher: new CredentialSessionLauncher({ pty: execution.pty }), dataDir }
    : undefined;

  if (db) {
    registerFacadeHandlers(registry, {
      db,
      config,
      owner,
      files: { blobStore: blobStore!, maxSizeBytes: fileMaxSizeBytes },
      folderUploads: {
        blobStore: blobStore!,
        maxSizeBytes: fileMaxSizeBytes,
        // Node-local by construction, like the clipboard directory.
        stateDir: pathResolve(dataDir, 'folder-uploads'),
      },
      ...(credentials ? { credentials } : {}),
      ...(chat ? { chat: { orchestrator: chat, dataDir } } : {}),
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

  // `events` is declared above the execution block now — see the note there.

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

  /** Browser sockets authenticate with the Secure HttpOnly session cookie. */
  const resolveSocketIdentity = async (req: IncomingMessage): Promise<RequestIdentity> => {
    const resolver = identityResolver ?? autoOwnerResolver;
    const identity = await resolver(req.headers, {
      remoteAddress: req.socket.remoteAddress,
      disableAutoOwner: config.disableAutoOwner === true,
    });
    if (identity.kind === 'anonymous') {
      throw new CollabError('unauthenticated', 'authentication is required');
    }
    return identity;
  };

  /**
   * PTY grants are bearer capabilities and therefore work for the CLI without
   * a browser cookie. When a cookie is present, resolve it so the database can
   * additionally require the grant's exact subject identity.
   */
  const resolveOptionalSocketIdentityId = async (req: IncomingMessage): Promise<string | undefined> => {
    if (!readTm8SessionCookie(req.headers) && req.headers.authorization === undefined) return undefined;
    return (await resolveSocketIdentity(req)).identityId;
  };

  const wsAdmission = new WsAdmissionController();
  const ws = createWsServer({
    registry: subscriptions,
    admission: wsAdmission,
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
   * Identity: the short-lived capability is offered in Sec-WebSocket-Protocol
   * and never echoed; an optional Secure cookie binds browser uses to the exact
   * verified identity. Non-browser clients need no long-lived credential on
   * the socket because the one-shot grant already carries that authority.
   *
   * Authorization lives in pty/attach-authz.ts, and the policy is not restated
   * here or anywhere else in TypeScript: it atomically CALLS
   * `public.consume_stream_attach`, binding hash + session + mode + optional
   * browser identity in the same replay-protected database update.
   */
  const ptyAuditLogger = createPtyAuditLogger();
  const ptyAuthorize: PtyAttachAuthorizer | undefined = db
    ? createPtyAttachAuthorizer({
        db,
        resolveIdentityId: resolveOptionalSocketIdentityId,
        logger: ptyAuditLogger,
      })
    : undefined;

  const ptyWs = execution
    ? createPtyWsServer({
        pty: execution.pty,
        admission: wsAdmission,
        ...(ptyAuthorize ? { authorize: ptyAuthorize } : {}),
        logger: ptyAuditLogger,
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

  // Declared before the server so /health can late-bind to it; assigned only
  // when background jobs are enabled below.
  let scheduler: Scheduler | undefined;

  /**
   * The DEFAULT preview deployment (amended 2026-08-16): the renderer mounted
   * as the `/p/` route on the app socket. Same handler, same header set as
   * the second-origin listener below — one code path by design. Only when a
   * database exists to resolve capabilities against: a preview route that can
   * authenticate nothing should not be mounted.
   *
   * Harness caveat: `config.preview.origin` is precomputed from the
   * CONFIGURED port, so an in-process harness that substitutes `port: 0`
   * after validation should substitute its preview config too if it needs
   * `previewUrl` to carry the real ephemeral port.
   */
  const artifactPreviewRoute = config.preview?.sameOrigin && db && blobStore && owner
    ? createArtifactPreviewHandler({ preview: config.preview, db, blobStore, owner })
    : undefined;

  const server = createFacadeServer({
    ...(artifactPreviewRoute ? { artifactPreviewRoute } : {}),
    config,
    registry,
    upgrades,
    jobsStatus: () => scheduler?.status(),
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
   * only in explicit second-origin mode (TM8_PREVIEW_HOST/TM8_PREVIEW_PORT
   * set — the same-origin default mounted the `/p/` route above instead) —
   * loadConfig has already refused a second origin that collides with the
   * app origin — and only when a database exists to resolve capabilities
   * against: a preview listener that can authenticate nothing should not be
   * listening.
   */
  let preview: BootstrappedServer['preview'];
  if (config.preview && !config.preview.sameOrigin && db && blobStore && owner) {
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
    preview = { url: listening.url, port: listening.port, close: () => previewServer.close() };
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
   *
   * (The tracking observer below it is started first only because it is a
   * timer, not a sweep — nothing in either depends on the other.)
   */

  /**
   * The tracking observer — 006's queue finally gets its worker.
   *
   * Started AFTER listen() and on the R26 runner every future periodic job
   * belongs on; a second timer subsystem is the thing `scheduler.ts` exists to
   * prevent. Only this job is registered — backup and retention have their own
   * wiring decisions and are not this change's business.
   *
   * The scheduler's timers are `unref`'d, so it cannot by itself keep the
   * process alive and shutdown needs no new coordination.
   */
  if (db && owner && opts.startBackgroundJobs === true) {
    // Loops (§4.4) join the same runner when this node has an execution block.
    // NO SIDECAR IS PASSED, deliberately: attaching one would register the
    // daily `pg_dump` and silently begin taking backups on nodes that have
    // never taken one — that decision belongs to whoever owns backups. The
    // retention jobs registered alongside are the W1 stubs (each reports
    // `skipped` and touches nothing).
    scheduler = createDefaultScheduler(
      execution
        ? {
            loops: {
              db,
              port: createLoopExecutorPort({
                db,
                pty: execution.pty,
                spawnService: execution.spawnService,
                resolveOwner: owner,
                // The same seam `execution.dispatch` gets. Without it a
                // null-runner loop still STORES its request on the task — the
                // dispatcher finds it on its next wake — but nothing is pushed
                // at a live terminal.
                ...(delivery ? { dispatchDelivery: delivery.messageDelivery } : {}),
              }),
            },
          }
        : {},
    );
    scheduler.register(
      createTrackingObserverJob({
        db,
        claims: async () => {
          // The doors go through `require_space_member`, which has no
          // node-admin bypass, so bare `{ nodeAdmin: true }` would raise 42501
          // on every write. The node's own owner is the honest actor here.
          const o = await owner();
          return {
            identityId: o.identityId,
            nodeAdmin: o.isNodeAdmin,
            requestId: 'tracking-observer',
          };
        },
      }),
    );
    // Tier 4 git×graph: session→commit provenance from local worktrees, same
    // claims posture as the observer above.
    scheduler.register(
      createCommitRecorderJob({
        db,
        claims: async () => {
          const o = await owner();
          return {
            identityId: o.identityId,
            nodeAdmin: o.isNodeAdmin,
            requestId: 'commit-recorder',
          };
        },
      }),
    );
    // Tier 3 forge closed loops: the WATCHER, which is the complement of the
    // queue drainer above. It decides for itself what to poll (the watch
    // list) and turns semantic changes into messages in the owning session.
    // `runOnStart` is false — it makes provider calls, and a node that restarts
    // three times during a deploy should not make three rounds of them.
    scheduler.register(
      createForgeWatcherJob({
        db,
        claims: async () => {
          const o = await owner();
          return {
            identityId: o.identityId,
            nodeAdmin: o.isNodeAdmin,
            requestId: 'forge-watcher',
          };
        },
        // The same delivery machinery the `messages.post` request path uses, so
        // a nudge reaches an agent's terminal by exactly the route a human's
        // message does. Absent when there is no execution runtime: the nudge is
        // still stored, it is simply never injected — the honest degraded mode,
        // and the same one `registerFacadeHandlers` takes above.
        ...(delivery
          ? {
              dispatch: async ({ routes, workSessionId }: {
                routes: unknown;
                workSessionId: string;
              }) => {
                await dispatchSessionMessages({
                  routes: Array.isArray(routes) ? (routes as DispatchableRoute[]) : [],
                  parentsById: new Map(),
                  requestId: `forge-watcher:${workSessionId}`,
                  // The watcher is not a session, so there is no authoring
                  // session and attribution is `recorded_only` — the same value
                  // 019 derives for any writer that is not an agent.
                  sourceWorkSessionId: null,
                  senderAttribution: 'recorded_only',
                  delivery: delivery.messageDelivery as unknown as MessageDeliveryPort,
                });
              },
            }
          : {}),
      }),
    );
    // The file-upload slot sweep — expiry + staged-byte cleanup (094). Only
    // where a blob store exists; the doors are node-admin-only by design.
    if (blobStore) {
      const sweepClaims = (requestId: string) => async () => {
        const o = await owner();
        return { identityId: o.identityId, nodeAdmin: o.isNodeAdmin, requestId };
      };
      scheduler.register(
        createFileUploadSweepJob({ db, blobStore, claims: sweepClaims('file-upload-sweep') }),
      );
      scheduler.register(
        createDeletedFileBlobPurgeJob({ db, blobStore, claims: sweepClaims('file-blob-purge') }),
      );
    }
    scheduler.start();
    console.log('  tracking: observer draining the refresh queue every 60s');
    console.log('  tracking: commit recorder walking active worktrees every 60s');
    console.log('  tracking: forge watcher closing CI/conflict/review loops every 90s');
    if (blobStore) {
      console.log('  files: upload-slot sweep expiring slots and purging staged bytes every 10m');
      console.log('  files: deleted-blob purge reclaiming soft-deleted file bytes daily (30d grace)');
    }
  }

  if (execution) {
    const ghosts = await execution.reconcileGhosts();
    if (ghosts.retired > 0) {
      console.log(`  reconciled: retired ${ghosts.retired} ghost session(s) left by a previous run`);
    }
    // Printed for the same reason the worktree errors below are, and it is the
    // omission of exactly this that hid a node reconciling nothing on every boot:
    // a refusal here leaves rows claiming to be running with no process, which
    // the UI paints as live agents and the concurrency cap counts forever.
    for (const problem of ghosts.errors) {
      console.log(`  ghost reconciliation could not finish: ${problem.message}`);
    }
    // Worktree allocations, same posture, same place in the sequence. Kept
    // separate from the ghost sweep because they answer different questions: a
    // ghost is a stuck row, a stranded allocation is a leaked Git checkout —
    // and the second one costs disk and can be hiding someone's uncommitted
    // work.
    const worktrees = await execution.reconcileWorktrees();
    if (worktrees.repaired.length > 0) {
      console.log(`  reconciled: repaired ${worktrees.repaired.length} worktree allocation(s)`);
      for (const repair of worktrees.repaired) {
        console.log(`    ${repair.worktreeId}: ${repair.observed} → ${repair.action}`);
      }
    }
    // Quarantine is reported LOUDLY and acted on NEVER: these are Git worktrees
    // inside the node's own area that it does not recognise, and the repository
    // may be shared with a human's own (§6.3).
    for (const foreign of worktrees.quarantined) {
      console.log(`  quarantined worktree (untouched): ${foreign.path} — ${foreign.reason}`);
    }
    for (const problem of worktrees.errors) {
      console.log(`  worktree reconciliation could not finish: ${problem.message}`);
    }
  }

  // LAST, and after the listener is up, so the printed URL is one the reader
  // can actually click. A node with no credential on it cannot be signed into
  // at all, and its own output is the only channel to the person who just
  // installed it — see identity/node-claim-boot.ts.
  if (db) {
    await announceNodeClaim({
      db,
      dataDir,
      // The bind address is loopback by S1, so behind a proxy or a tailnet the
      // server's own url is one the claimant cannot open. TM8_PUBLIC_ORIGIN is
      // how an operator says where the node actually answers.
      url: config.publicOrigin ?? url,
      nodeMode: config.nodeMode ?? 'single',
      // The claim ceremony credentials the EXISTING owner row, so the row has
      // to exist before the token is advertised. `owner` is the same memoised
      // loopback bootstrap every other path uses.
      ensureOwner: () => owner!(),
    });
  }

  return { server, subscriptions, events, url, db, delivery, preview, scheduler, execution };
}

export async function main(): Promise<void> {
  try {
    // TRUE only here: this is the one caller that owns the process lifetime and
    // can therefore stop what it starts (see BootstrapOptions.startBackgroundJobs).
    const { server, url, db, delivery, preview, scheduler, execution } = await bootstrap({
      startBackgroundJobs: true,
      // TM8 Chat production composition: ClaudeHeadlessAdapter + the C5-minting
      // launch-config resolver. Without this line the chat ships dead — the
      // orchestrator only exists when a runtime is injected (see compose.ts).
      // TM8_CHAT_SKILLS_DIR, when set, is the tm8-curated Claude Code plugin
      // directory that turns the chat `Skill` tool on; unset ⇒ Skill is offered
      // but resolves nothing (no behaviour change).
      chat: (chatCtx) => composeChatBootstrap({
        ...chatCtx,
        ...(process.env.TM8_CHAT_SKILLS_DIR?.trim()
          ? { skillsPluginDir: process.env.TM8_CHAT_SKILLS_DIR.trim() }
          : {}),
      }),
    });
    const { registry, router } = server;
    console.log(`tm8-server listening on ${url}`);
    console.log(
      `  artifact preview: ${
        preview
          // Both facts, because behind a TLS proxy they differ and each one
          // answers a different question: the first is the URL a browser gets
          // minted, the second is the socket nginx must be pointed at.
          ? `${preview.url} (second origin, design §9; bound ${server.config.host}:${preview.port})`
          : server.config.preview?.sameOrigin && db
            ? `${url}/p/... (same-origin route on the app socket)`
            : 'NOT RUNNING (needs a database and TM8_PREVIEW_ENABLED not 0)'
      }`,
    );
    // The prod version of this is a boot refusal (config.ts). Off prod it is
    // this line, because the failure is otherwise INVISIBLE: the node boots,
    // previews render, and the only thing standing between an agent-authored
    // bundle and the session cookie is one CSP directive.
    if (
      server.config.preview?.sameOrigin
      && server.config.publicOrigin?.startsWith('https:')
    ) {
      console.warn(
        `  WARNING: previews are served SAME-ORIGIN from ${server.config.publicOrigin} — untrusted ` +
          `bundle HTML on the origin that holds the session cookie, contained by the response CSP's ` +
          `sandbox alone. Set TM8_PREVIEW_PUBLIC_ORIGIN to a separate hostname (design §9.2).`,
      );
    }
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
      // FIRST, before anything is torn down: tell every live session why it is
      // about to die (171). This process holds their PTYs, so they die with it
      // either way — but this is the only moment the reason is known
      // first-hand rather than inferred by the next process from an empty PTY
      // map. Without it a deploy is indistinguishable, in the graph, from four
      // agents finishing their work, which is exactly how 2026-08-22 11:04 hid.
      //
      // Bounded and non-throwing by contract (see recordShutdown), and awaited
      // before the listener closes so the writes actually land. TimeoutStopSec
      // on the unit remains the outer bound.
      void Promise.resolve(execution?.recordShutdown(signal))
        .catch(() => undefined)
        .then((annotated) => {
          if (typeof annotated === 'number' && annotated > 0) {
            console.log(`  recorded shutdown reason on ${annotated} live session(s)`);
          }
        })
        .then(() => scheduler?.stop(2_000))
        .catch(() => undefined)
        .then(() => server.close())
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
