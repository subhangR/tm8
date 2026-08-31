/**
 * DRAFT — destined for packages/server/test/events/ws-e2e-harness.ts
 * (held in scratchpad while the tree is frozen; do not run from here)
 *
 * The reusable DB→WebSocket end-to-end fixture for the tm8 server.
 *
 * ## What "end-to-end" means here
 *
 * `startWsE2eNode` boots the REAL composition root (`bootstrap()` in
 * src/main.ts) against a THROWAWAY scratch database built from the full
 * official migration chain. Nothing is faked and nothing is re-wired: the
 * path under test is the production one —
 *
 *   write RPC / HTTP mutation
 *     → capture trigger (db/migrations/003) mints the seq and the row
 *     → PgDurableEventLog reads it under the caller's claims (RLS in force)
 *     → DurableEventPump polls per-connection and publishes
 *     → control channel (REAL DbSubscriptionAuthorizer) gates subscribe/resume
 *     → RFC 6455 frame on /v2/ws
 *
 * ## Why a scratch database is not optional
 *
 * Booting a node is a WRITE: `bootstrap()` runs `reconcileGhosts()`, which
 * retires every `work_sessions` row still at 'running'. Pointing this helper
 * at tm8_dev would retire live agent sessions on whatever node is already up.
 * The scratch database is created per suite and dropped in `close()`.
 *
 * ## Reuse (bridge-coordinator team)
 *
 * The fixture recipe this file encodes, in order:
 *   1. `startWsE2eNode(label)` — scratch DB + full chain + real bootstrap()
 *      with echo-agent execution (no API key, PTY plumbing real).
 *   2. HTTP as the loopback owner for anything the owner does (spaces, tasks,
 *      messages, spawn) — `node.request(...)`.
 *   3. `node.rpcDb` (runs as tm8_app, claims per call) for anything that
 *      needs a SECOND identity: `upsert_user_profile` as identity B, owner
 *      `create_invite`, B `redeem_invite` — see `addSpaceMember`.
 *   4. A recipient-targeted event: `post_message` with
 *      `p_mentions = [{entityId: <member>}]` → internal.notify →
 *      `workspace_events.recipient_member_id` (003:366-378).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { Pool, type QueryResultRow } from 'pg';

import { bootstrap, type BootstrappedServer } from '../../src/main.js';
import { loadConfig } from '../../src/http/config.js';
import type { DbClaims } from '../../src/db/types.js';
import type { RequestIdentity } from '../../src/http/types.js';
import {
  createControlChannel,
  createDurableEventPump,
  createWsServer,
  DbSubscriptionAuthorizer,
  InMemorySeqSource,
  PgDurableEventLog,
  PgDurableSeqSource,
  SubscriptionRegistry,
  WorkspaceEventPublisher,
  type DurableEventPump,
} from '../../src/events/index.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from '../db/w1-pg.js';
import { createTestDb, type TestDb } from './pg-harness.js';

/** `internal.command_result` shape (007:49) — enough of it for fixtures. */
export interface CommandResult {
  entity: { id: string };
}

export interface WsE2eNode {
  readonly baseUrl: string;
  /** ws:// form of baseUrl + the catalog WS path. */
  readonly wsUrl: string;
  readonly database: W1ScratchDatabase;
  readonly production: BootstrappedServer;
  /** tm8_app-role access with per-call claims — RLS in force. */
  readonly rpcDb: TestDb;
  readonly dataDir: string;
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<{
    status: number;
    data: T | undefined;
    error: { code: string; message: string } | undefined;
  }>;
  close(): Promise<void>;
}

/**
 * Boot the production composition on an ephemeral loopback port over a fresh
 * scratch database. Mirrors test/w3/public-harness.ts, plus `rpcDb` and the
 * ws URL, minus the W3-specific envelope assertions.
 */
/**
 * `TM8_AGENT_CMD` has to be on `process.env`, not merely in the config below.
 *
 * `loadConfig` does not carry it — it is documented as an OPERATOR OVERRIDE read
 * from the environment, and `SpawnService` reads it from `options.env ?? process.env`
 * (`SpawnService.ts:188`), which `registerExecutionHandlers` never populates. So
 * the `TM8_AGENT_CMD: 'echo-agent'` handed to `loadConfig` below was inert, and
 * A6c's "REAL echo-agent PTY attach" was in fact spawning `claude` and passing
 * only on a machine that happened to have it installed. On a bare runner the same
 * spawn answered 404 `agent CLI 'claude' was not found`.
 *
 * Set at module scope and never restored: every consumer of this harness exists to
 * exercise PTY plumbing without a model or a key, which is precisely what
 * echo-agent is for.
 */
/*
 * AND IT HAS TO BE A PATH, NOT THE BARE NAME. `echo-agent` was set here as a
 * word, and `resolveAgentBinary` (packages/execution/src/spawn/manifest.ts)
 * treats a name with no `/` as a PATH LOOKUP — it walks `$PATH` for a file
 * called exactly `echo-agent`. Nothing in this repository ever puts one there:
 * the file is `packages/execution/harness/echo-agent.mjs`, it is not
 * executable (0644), it is not named `echo-agent`, no package.json declares a
 * `bin` for it, and `tools/ci/check.sh` installs nothing. So on a runner the
 * lookup returns null and the spawn never produces an agent — which is what
 * the nine `expected 503 to be 201` failures on main are.
 *
 * That is the SAME defect this block's own comment already records one layer
 * up: the config value was inert, so A6c's "REAL echo-agent PTY attach" was
 * really spawning `claude`. The fix then set the env var and stopped there,
 * leaving a name that resolves only on a machine where somebody happened to
 * have put an `echo-agent` on PATH by hand.
 *
 * `resolveAgentBinary` documents the escape explicitly — "a caller-supplied
 * path is not a PATH lookup at all, and must not be rewritten into one" — and
 * the command is split on spaces with `[0]` taken as the binary, so `node`
 * resolves from PATH and the script rides as its argument. That needs no
 * execute bit and no install step, and it points at the file in THIS checkout
 * rather than whatever a machine happens to have.
 */
process.env['TM8_AGENT_CMD'] =
  `node ${fileURLToPath(new URL('../../../execution/harness/echo-agent.mjs', import.meta.url))}`;

export async function startWsE2eNode(
  label: string,
  opts: {
    readonly startBackgroundJobs?: boolean;
    /**
     * Wire the REAL message-delivery runtime, so a message posted to a live
     * session actually reaches its terminal.
     *
     * OFF BY DEFAULT, and opt-in rather than automatic because it costs a
     * second connection pool and a boot-time principal verification that most
     * suites here have no use for.
     *
     * WHY IT EXISTS AT ALL: without it `main.ts` leaves `messageDelivery`
     * undefined (it is gated on `execution && TM8_DELIVERY_DATABASE_URL`), so
     * `messages.post` stores, routes, and dispatches NOTHING — and every
     * assertion an e2e suite could make about steering a worker would pass
     * against a node that cannot steer one. That gap is why the 2026-08-21
     * delivery defect had no e2e coverage to fail.
     */
    readonly deliveryRuntime?: boolean;
  } = {},
): Promise<WsE2eNode> {
  const database = await createW1ScratchDatabase(`wse2e_${label}`);
  const dataDir = await mkdtemp(join(tmpdir(), 'tm8-wse2e-'));
  let production: BootstrappedServer | undefined;
  let rpcDb: TestDb | undefined;
  // `main.ts` reads this one off `process.env` directly rather than from the
  // validated config, so it has to be set around the bootstrap call and put
  // back afterwards — the variable is process-wide and other suites share it.
  const priorDeliveryUrl = process.env['TM8_DELIVERY_DATABASE_URL'];

  try {
    database.apply(migrationFiles());
    if (opts.deliveryRuntime === true) {
      const deliveryUrl = new URL(database.url);
      deliveryUrl.username = 'tm8_delivery_worker';
      deliveryUrl.password = '';
      process.env['TM8_DELIVERY_DATABASE_URL'] = deliveryUrl.toString();
    } else {
      delete process.env['TM8_DELIVERY_DATABASE_URL'];
    }
    const configured = loadConfig({
      ...process.env,
      TM8_BIND: '127.0.0.1',
      TM8_PORT: '4610',
      TM8_DATABASE_URL: database.url,
      TM8_DATA_DIR: dataDir,
      // The stub agent: proves the PTY plumbing without a model or a key.
      TM8_AGENT_CMD: 'echo-agent',
    });
    // loadConfig rightly refuses port 0 from an operator; tests substitute it
    // after validation so the kernel picks an isolated ephemeral port.
    production = await bootstrap({
      config: { ...configured, port: 0 },
      ...(opts.startBackgroundJobs === true ? { startBackgroundJobs: true } : {}),
    });
    rpcDb = createTestDb(database.url);
  } catch (error) {
    await rpcDb?.end();
    await production?.server.close();
    await production?.db?.end();
    await database.destroy();
    await removeOwnedDataDir(dataDir);
    throw error;
  } finally {
    // Restore whatever the process had, so one suite's delivery node cannot
    // point the next suite's boot at a dropped scratch database.
    if (priorDeliveryUrl === undefined) delete process.env['TM8_DELIVERY_DATABASE_URL'];
    else process.env['TM8_DELIVERY_DATABASE_URL'] = priorDeliveryUrl;
  }

  const baseUrl = production.url;
  const node: WsE2eNode = {
    baseUrl,
    wsUrl: `${baseUrl.replace('http', 'ws')}/v2/ws`,
    database,
    production,
    rpcDb,
    dataDir,
    async request<T = unknown>(method: string, path: string, body?: unknown) {
      const response = await fetch(new URL(path, baseUrl), {
        method,
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
      const parsed = (await response.json()) as {
        data?: T;
        error?: { code: string; message: string };
      };
      return { status: response.status, data: parsed.data, error: parsed.error };
    },
    close: closeOnce(async () => {
      await production!.server.close();
      await production!.delivery?.close();
      await production!.db?.end();
      await rpcDb!.end();
      await database.destroy();
      await removeOwnedDataDir(dataDir);
    }),
  };
  return node;
}

function closeOnce(fn: () => Promise<void>): () => Promise<void> {
  let done: Promise<void> | undefined;
  return () => (done ??= fn());
}

async function removeOwnedDataDir(dataDir: string): Promise<void> {
  if (!basename(dataDir).startsWith('tm8-wse2e-')) {
    throw new Error(`refusing to remove non-e2e data directory: ${dataDir}`);
  }
  await rm(dataDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Fixture recipes
// ---------------------------------------------------------------------------

/** Claims for one RPC call, shaped exactly as the server builds them. */
export function claimsFor(identityId: string): {
  identityId: string;
  nodeAdmin: boolean;
  requestId: string;
} {
  return { identityId, nodeAdmin: false, requestId: `req_${randomUUID()}` };
}

/**
 * Create a NEW identity and admit it to `spaceId` as a member, through the
 * public invite path (owner mints, newcomer redeems) — the same path a real
 * second browser would take. Returns the new member's ids.
 *
 * `ownerIdentityId` must belong to a space admin (the space creator is one).
 */
export async function addSpaceMember(
  rpcDb: TestDb,
  spaceId: string,
  ownerIdentityId: string,
  displayName: string,
): Promise<{ identityId: string; memberId: string }> {
  const identityId = `identity_${randomUUID()}`;
  await rpcDb.rpc(claimsFor(identityId), 'public.upsert_user_profile', [displayName, null, null]);
  const created = await rpcDb.rpc<{ invite: { code: string } }>(
    claimsFor(ownerIdentityId),
    'public.create_invite',
    [spaceId, 1, null, null, `cmid_${randomUUID()}`],
  );
  await rpcDb.rpc(claimsFor(identityId), 'public.redeem_invite', [
    created.invite.code,
    `cmid_${randomUUID()}`,
  ]);
  const members = await rpcDb.query<{ entity_id: string }>(
    claimsFor(identityId),
    'select entity_id from public.members where space_id = $1 and identity_id = $2',
    [spaceId, identityId],
  );
  const memberId = members[0]?.entity_id;
  if (memberId === undefined) throw new Error('invite redemption did not mint a member');
  return { identityId, memberId };
}

/**
 * The identity + member behind a space's owning member — needed to run RPCs
 * "as the owner" when the space was created over HTTP (where the loopback
 * owner's identity id never appears in a response body).
 */
export async function ownerOfSpace(
  database: W1ScratchDatabase,
  spaceId: string,
): Promise<{ identityId: string; memberId: string }> {
  const rows = await database.query<{ entity_id: string; identity_id: string }>(
    `select entity_id, identity_id from public.members
      where space_id = $1
      order by case role when 'owner' then 0 when 'admin' then 1 else 2 end, joined_at asc
      limit 1`,
    [spaceId],
  );
  const first = rows[0];
  if (first === undefined) throw new Error(`space ${spaceId} has no members`);
  return { identityId: first.identity_id, memberId: first.entity_id };
}

/**
 * Post a message through the BOUND command door, `w2_post_message_batch`.
 *
 * NOT `public.post_message`: 019:1321 revokes EXECUTE on it from `tm8_app`
 * permanently (032 SITE 7 documents the two-door replay binding), so a direct
 * call answers `permission denied` — the exact pre-existing red disposed in
 * the baseline. The batch door is the one the facade messages handler uses,
 * is executable by `tm8_app`, and its stored mention shape
 * (`[{entityId, kind, display}]`, 019:132-137) still feeds the
 * `fan_out_message_mentions` trigger, so recipient-targeted notifications
 * mint exactly as before.
 */
export async function postMessage(
  rpcDb: TestDb,
  authorIdentityId: string,
  authorMemberId: string,
  anchorId: string,
  body: string,
  mentionedMemberIds: readonly string[] = [],
): Promise<void> {
  await rpcDb.rpc(claimsFor(authorIdentityId), 'public.w2_post_message_batch', [
    [anchorId],
    body,
    null,
    [...mentionedMemberIds],
    [],
    null,
    authorMemberId,
    `cmid_${randomUUID()}`,
  ]);
}

/**
 * Post a message mentioning `memberId` — produces BOTH a space-wide
 * `message.created` and a recipient-targeted `notification.created` whose
 * `workspace_events.recipient_member_id` is `memberId`. The pair is exactly
 * the two-feed interleaving the pump and RLS must keep apart.
 */
export async function postMentioning(
  rpcDb: TestDb,
  authorIdentityId: string,
  authorMemberId: string,
  anchorId: string,
  mentionedMemberId: string,
  body: string,
): Promise<void> {
  await postMessage(rpcDb, authorIdentityId, authorMemberId, anchorId, body, [mentionedMemberId]);
}

// ---------------------------------------------------------------------------
// WebSocket client helpers (node's global WebSocket — a real RFC 6455 client)
// ---------------------------------------------------------------------------

export interface FrameCollector {
  /** Every text frame received so far, parsed. */
  readonly all: unknown[];
  /** Resolve when a frame matching `pred` arrives (checks history first). */
  next(pred: (frame: unknown) => boolean, ms?: number): Promise<unknown>;
  /** Resolve after `ms` with NO new frame having arrived; reject if one does. */
  expectQuiet(ms: number): Promise<void>;
  /** Frames received after index `from`. */
  since(from: number): unknown[];
}

export function connectWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws), { once: true });
    ws.addEventListener('error', () => reject(new Error(`ws connection failed: ${url}`)), {
      once: true,
    });
  });
}

export function collect(ws: WebSocket): FrameCollector {
  const all: unknown[] = [];
  const waiters: Array<{ pred: (f: unknown) => boolean; resolve: (f: unknown) => void }> = [];
  ws.addEventListener('message', (ev) => {
    const frame: unknown = JSON.parse(String((ev as MessageEvent).data));
    all.push(frame);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i]!.pred(frame)) {
        waiters[i]!.resolve(frame);
        waiters.splice(i, 1);
      }
    }
  });

  return {
    all,
    next(pred, ms = 15_000) {
      const hit = all.find(pred);
      if (hit !== undefined) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `no matching frame within ${String(ms)}ms; saw ${String(all.length)}: ` +
                JSON.stringify(all.map((f) => (f as { type?: string }).type)),
            ),
          );
        }, ms);
        waiters.push({
          pred,
          resolve: (f) => {
            clearTimeout(timer);
            resolve(f);
          },
        });
      });
    },
    expectQuiet(ms) {
      const baseline = all.length;
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          if (all.length === baseline) resolve();
          else {
            reject(
              new Error(
                `expected silence for ${String(ms)}ms but received: ` +
                  JSON.stringify(all.slice(baseline)),
              ),
            );
          }
        }, ms);
      });
    },
    since(from) {
      return all.slice(from);
    },
  };
}

export function send(ws: WebSocket, frame: unknown): void {
  ws.send(JSON.stringify(frame));
}

/** Wait for the socket's close event. */
export function closed(ws: WebSocket, ms = 10_000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket did not close')), ms);
    ws.addEventListener(
      'close',
      (ev) => {
        clearTimeout(timer);
        const { code, reason } = ev as CloseEvent;
        resolve({ code, reason });
      },
      { once: true },
    );
  });
}

/** Poll `predicate` until true or `ms` elapses. */
export async function waitFor(predicate: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error('condition never became true');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** The (seq,type) spine of a list of workspace events — the agreement key. */
export function spine(events: readonly unknown[]): Array<[number, string]> {
  return events
    .filter((e): e is { seq: number; type: string } => {
      const f = e as { seq?: unknown; type?: unknown };
      return typeof f.seq === 'number' && typeof f.type === 'string' && !f.type.startsWith('control.');
    })
    .map((e) => [e.seq, e.type]);
}

// ---------------------------------------------------------------------------
// The composed real event path (multi-identity suites)
// ---------------------------------------------------------------------------

export interface ComposedEventPath {
  registry: SubscriptionRegistry;
  pump: DurableEventPump;
  authorizer: DbSubscriptionAuthorizer;
  /** Every onError from the pump, the authorizer and the control channel. */
  errors: string[];
  /**
   * Every live-cursor seed the control channel performed, in order — the
   * observable "this subscription is NOW live" signal. A `subscribe` frame's
   * high-water seed is asynchronous (it awaits a DB read), so a test that
   * mutates immediately after sending the frame races it: if the seed lands
   * after the mutation commits, the cursor starts PAST the mutation and the
   * frame is legitimately never delivered. Tests therefore wait for the seed
   * they expect instead of guessing at timing.
   */
  seeds: Array<{ connId: string; spaceId: string; seq: number }>;
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => Promise<void>;
  closeAll: () => void;
}

/**
 * EVERY direct construction of the events lane's composition — the exact
 * wiring main.ts performs (main.ts:152-221), with two deliberate deltas:
 *   1. `authorize` reads `?testIdentity=<identityId>` from the upgrade URL,
 *      so each connection carries a real, distinct identity — the ONE thing
 *      `bootstrap()` cannot provide (main.ts:167-170 resolves every socket to
 *      the loopback owner, which makes recipient-targeting unobservable);
 *   2. the pump interval is short, `batch` is injectable and `tick()` is
 *      exposed, so delivery is driven deterministically.
 *
 * W5 DRIFT NOTE: control.ts (createControlChannel, DbSubscriptionAuthorizer)
 * has a live grant. Interface drift lands HERE and only here — every suite
 * imports this factory rather than constructing those types itself.
 */
export function composeRealEventPath(db: TestDb, opts: { batch?: number } = {}): ComposedEventPath {
  const errors: string[] = [];
  const onError = (message: string): void => {
    errors.push(message);
  };

  // main.ts:167-170, minus the owner fallback: these connections ARE their
  // identity, which is the entire point of the multi-identity suites.
  const wsClaimsFor = (identity: RequestIdentity): Promise<DbClaims> => {
    if (identity.identityId === undefined) {
      return Promise.reject(new Error('test connection carries no identity'));
    }
    return Promise.resolve({
      identityId: identity.identityId,
      nodeAdmin: false,
      requestId: `req_${randomUUID()}`,
    });
  };

  const registry = new SubscriptionRegistry();
  const publisher = new WorkspaceEventPublisher(new InMemorySeqSource(), registry);
  const log = new PgDurableEventLog(db);
  const pump = createDurableEventPump({
    registry,
    publisher,
    log,
    claimsFor: wsClaimsFor,
    intervalMs: 50,
    ...(opts.batch === undefined ? {} : { batch: opts.batch }),
    onError,
  });
  const authorizer = new DbSubscriptionAuthorizer(db, wsClaimsFor, { onError });
  const highWaterMark = async (identity: RequestIdentity, spaceId: string): Promise<number | null> =>
    db.tx(await wsClaimsFor(identity), (q) => new PgDurableSeqSource(q).latest(spaceId));
  // The production LiveCursor seam, instrumented: every seed is recorded AND
  // forwarded verbatim. See ComposedEventPath.seeds for why.
  const seeds: Array<{ connId: string; spaceId: string; seq: number }> = [];
  const control = createControlChannel({
    registry,
    authorizer,
    log,
    claimsFor: wsClaimsFor,
    cursors: {
      seed: (connId, spaceId, seq) => {
        seeds.push({ connId, spaceId, seq });
        pump.seed(connId, spaceId, seq);
      },
    },
    highWaterMark,
    onError,
  });
  const ws = createWsServer({
    registry,
    authorize: (req) => {
      const identityId = new URL(req.url ?? '/', 'http://tm8.invalid').searchParams.get('testIdentity');
      if (identityId === null || identityId === '') throw new Error('no test identity');
      return { kind: 'auto-owner', identityId };
    },
    onClientMessage: (conn, text) => void control.handle(conn, text),
    onDisconnect: (connId) => {
      pump.forget(connId);
    },
  });
  return { registry, pump, authorizer, errors, seeds, handleUpgrade: ws.handleUpgrade, closeAll: ws.closeAll };
}

export interface ComposedWsServer {
  readonly wsBase: string;
  close(): Promise<void>;
}

/** Mount a composed event path on a plain loopback HTTP server's upgrade. */
export async function startComposedWsServer(composition: ComposedEventPath): Promise<ComposedWsServer> {
  const httpServer: Server = createServer((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  httpServer.on('upgrade', (req, socket, head) => {
    void composition.handleUpgrade(req, socket as Duplex, head);
  });
  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  const address = httpServer.address();
  if (address === null || typeof address === 'string') throw new Error('no listen address');
  return {
    wsBase: `ws://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        composition.pump.stop();
        composition.closeAll();
        httpServer.close(() => {
          resolve();
        });
      }),
  };
}

// ---------------------------------------------------------------------------
// The REAL client algorithm (what the bridge team ships)
// ---------------------------------------------------------------------------

/**
 * `subscribe` then ALWAYS `resume`, looping until a resume round delivers
 * nothing new — the client pattern the tm8-ui data layer rides:
 *
 *   - subscribe alone starts at the high-water mark and replays nothing;
 *   - resume alone replays but never joins the live fan-out (control.ts
 *     seeds the cursor without registry membership — verified, deliberate);
 *   - resume is capped at MAX_RESUME_BATCH, so one round is not a sync.
 *
 * `settle` is the suite's own quiescence strategy: composed suites drive
 * `pump.tick()` deterministically; bootstrap suites wait out wall-clock pump
 * intervals. Returns the final cursor (max seq applied, or `since` when the
 * space was quiet).
 *
 * `seeds` (composed suites): the harness's instrumented LiveCursor log. With
 * it, each round is SEED-DRIVEN instead of settle-guessed: the control
 * channel seeds the cursor only AFTER a resume finished replaying
 * (control.ts), so "a new seed appeared" is the replay-complete signal and
 * the round cannot be concluded early while the replay is still in flight —
 * the race a settle-only round loses on a fast machine. Requires the space
 * to be non-empty (an empty space's subscribe seeds nothing and the initial
 * wait would starve).
 */
export async function clientSync(
  ws: WebSocket,
  frames: FrameCollector,
  spaceId: string,
  since: number,
  settle: () => Promise<void>,
  seeds?: ReadonlyArray<{ connId: string; spaceId: string; seq: number }>,
): Promise<number> {
  const preSubscribe = seeds?.length ?? 0;
  send(ws, { type: 'subscribe', spaceIds: [spaceId] });
  // Consume the subscribe frame's own high-water seed first, so each resume
  // round's "new seed" is unambiguously the RESUME's.
  if (seeds !== undefined) await waitFor(() => seeds.length > preSubscribe);
  let cursor = since;
  for (let round = 0; round < 50; round += 1) {
    const seedBaseline = seeds?.length ?? 0;
    const before = frames.all.length;
    send(ws, { type: 'resume', spaceId, since: cursor });
    if (seeds !== undefined) {
      await waitFor(() => seeds.length > seedBaseline);
      const seeded = seeds[seeds.length - 1]!.seq;
      // An empty round seeds the caller's own cursor back — caught up.
      if (seeded <= cursor) return cursor;
      // The replay's frames were written before the seed; wait for its tail
      // to arrive client-side, then continue (a >MAX_RESUME_BATCH backlog
      // takes several rounds).
      await frames.next((f) => (f as { seq?: number }).seq === seeded);
      cursor = seeded;
      continue;
    }
    await settle();
    const seqs = spine(frames.since(before)).map(([s]) => s);
    if (seqs.length === 0) return cursor;
    cursor = Math.max(cursor, ...seqs);
  }
  throw new Error('clientSync did not quiesce in 50 rounds — the cursor is not advancing');
}

// ---------------------------------------------------------------------------
// The PRODUCTION-SHAPED Db: claims bound, role NOT dropped
// ---------------------------------------------------------------------------

/**
 * A `Db` that behaves exactly like the production `PgDb` (src/db/client.ts):
 * it BINDS the four claims via set_config and NEVER issues a `set role` — so
 * when the connection string authenticates as the `tm8` superuser
 * (rolsuper=t, rolbypassrls=t — every documented deployment), RLS is
 * bypassed on every plain SELECT.
 *
 * The events-lane `TestDb` (pg-harness.ts) deliberately DOES drop to
 * `tm8_app` per call, which is why suites built on it exercise RLS even
 * where production would not. This factory exists for the tests that must
 * prove behavior on the PRODUCTION shape — e.g. that the authorizer refuses
 * a non-member even on a bypassing pool.
 */
export function createSuperuserShapedDb(connectionString: string): TestDb {
  const pool = new Pool({ connectionString, max: 4 });

  const querier = (client: {
    query: (
      sql: string,
      params?: unknown[],
    ) => Promise<{ rows: unknown[]; fields?: ReadonlyArray<{ name: string }> }>;
  }): { query: <R>(sql: string, params?: readonly unknown[]) => Promise<R[]>; rpc: <T>(fn: string, args?: readonly unknown[]) => Promise<T> } => ({
    async query<R>(sql: string, params: readonly unknown[] = []): Promise<R[]> {
      const res = await client.query(sql, [...params]);
      return res.rows as R[];
    },
    // MIRRORS db/client.ts `makeQuerier` — see the note in events/pg-harness.ts.
    // A `returns table(...)` RPC with zero rows made the old scalar shape throw.
    async rpc<T>(fn: string, args: readonly unknown[] = []): Promise<T> {
      const placeholders = args.map((_, i) => `$${String(i + 1)}`).join(', ');
      const qualified = fn.includes('.') ? fn : `public.${fn}`;
      const res = await client.query(`select * from ${qualified}(${placeholders})`, [...args]);
      if (res.rows.length === 1 && res.fields?.length === 1) {
        const field = res.fields[0];
        return (field ? (res.rows[0] as Record<string, unknown>)[field.name] : undefined) as T;
      }
      return res.rows as unknown as T;
    },
  });

  async function run<T>(claims: DbClaims, fn: (q: ReturnType<typeof querier>) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query('begin');
      // Claims only — NO `set local role`. This absence is the entire point.
      const bindings: Array<[string, string]> = [];
      if (claims.identityId !== undefined) bindings.push(['tm8.identity_id', claims.identityId]);
      if (claims.actorId !== undefined) bindings.push(['tm8.actor_id', claims.actorId]);
      if (claims.nodeAdmin !== undefined) bindings.push(['tm8.node_admin', claims.nodeAdmin ? 'true' : 'false']);
      if (claims.requestId !== undefined) bindings.push(['tm8.request_id', claims.requestId]);
      for (const [name, value] of bindings) {
        await client.query('select set_config($1, $2, true)', [name, value]);
      }
      const out = await fn(querier(client));
      await client.query('commit');
      return out;
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  }

  return {
    tx: (claims, fn) => run(claims, fn as never),
    asOwner: (fn) => run({}, fn as never),
    rpc: (claims, fn, args = []) => run(claims, (q) => q.rpc(fn, args)),
    query: (claims, sql, params = []) => run(claims, (q) => q.query(sql, params)),
    end: () => pool.end(),
  };
}

// ---------------------------------------------------------------------------
// Ground truth (seeded-count control — read the TABLE, not an instrument)
// ---------------------------------------------------------------------------

/**
 * Every seq the space minted after `afterSeq`, split into what `memberId`'s
 * connection may see (space feed + rows addressed to it, 008:156-161) and
 * what it must never see. Superuser read, independent of every instrument on
 * the delivery path — the W5 cursor-truncation ruling: exact sets against
 * THIS, never only against another reader of the same log.
 */
export async function groundTruth(
  database: W1ScratchDatabase,
  spaceId: string,
  afterSeq: number,
  memberId: string,
): Promise<{ visible: number[]; excluded: number[] }> {
  const rows = await database.query<{ seq: string; recipient_member_id: string | null }>(
    `select seq, recipient_member_id from public.workspace_events
      where space_id = $1 and seq > $2 order by seq asc`,
    [spaceId, afterSeq],
  );
  const visible: number[] = [];
  const excluded: number[] = [];
  for (const row of rows) {
    if (row.recipient_member_id === null || row.recipient_member_id === memberId) {
      visible.push(Number(row.seq));
    } else {
      excluded.push(Number(row.seq));
    }
  }
  return { visible, excluded };
}
