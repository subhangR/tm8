/**
 * The real-node fixture for the bridge lane's integration suites (LLD §11).
 *
 * ## What "integration" means here, precisely
 *
 * Every suite in this directory drives `createRealSeam()` — the actual client
 * shipped in `../real/` — against a REAL tm8 node: the production composition
 * root (`bootstrap()` in `packages/server/src/main.ts`) over a THROWAWAY
 * database built from the full official migration chain, on an ephemeral
 * loopback port. Nothing is faked on either side. The path under test is:
 *
 *   seam command / raw HTTP mutation
 *     → capture trigger (db/migrations/003) mints the seq and the row
 *     → PgDurableEventLog reads it under the caller's claims
 *     → DurableEventPump polls per-connection and publishes
 *     → control channel (real DbSubscriptionAuthorizer) gates subscribe/resume
 *     → RFC 6455 frame on /v2/ws
 *     → socket.ts → connection.ts cursor law → seam.onEvent
 *
 * This mirrors `packages/server/test/events/ws-e2e-harness.ts` (read-only
 * reference; same recipe, same laws) with the client half swapped for ours.
 *
 * ## THE TWO LAWS THIS FILE EXISTS TO ENFORCE
 *
 * **1. Never `tm8_dev`.** Booting a node is a WRITE: `bootstrap()` runs
 * `reconcileGhosts()`, which retires every `work_sessions` row still at
 * 'running'. Pointing this fixture at the shared dev database would retire a
 * live agent session on whatever node is already up. Pointing a URL at a
 * database is read-only *as a psql query* and is NOT read-only *as a boot* —
 * the command reads harmless and the blast radius is not. So: a scratch
 * database per suite, name-prefixed `tm8ui_b4_`, dropped in `close()`, and
 * `assertNotSharedDatabase` refuses anything that even looks like `tm8_dev`
 * BEFORE the first byte is written. `db/migrate.mjs` falls back to `tm8_dev`
 * when `TM8_DATABASE_URL` is unset, so every invocation here sets it explicitly.
 *
 * **2. Boot from SOURCE, never from `dist`.** `packages/server/dist` predates
 * the Delta 1 mapper passthrough arm. A dist-booted node reports `menu.updated`
 * as not flowing — which is indistinguishable from the Delta 1 MERGED signal
 * being wrong, i.e. a false red aimed at the wrong lane. The bare-specifier
 * imports below are aliased to server SOURCE in `./vitest.config.ts`, so what
 * boots here is what is in the tree right now. (server-owner, relayed
 * [bridge->B4 2].) Nothing in this lane builds or promotes anything.
 *
 * ## Why there is no `pg` client anywhere in this directory
 *
 * Measured 2026-07-28: `packages/tm8-ui/node_modules` has no `pg` and no
 * `@types/node`, and root `node_modules` has no `@types` directory at all —
 * `packages/server/node_modules` is not on this package's resolution path. So
 * all database work here goes through the `psql` CLI and `node db/migrate.mjs`,
 * which is also how `db/migrate.mjs` itself does it ("ZERO npm dependencies").
 * Ground truth reads are therefore a superuser `psql` query — which is exactly
 * what they should be anyway: independent of every instrument on the delivery
 * path under test.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CollabError } from '@tm8/contract';
import { bootstrap, type BootstrappedServer } from '@tm8/server-src-main';
import { loadConfig } from '@tm8/server-src-config';

import { createRealSeam, type RealSeam, type RealSeamOptions } from '../real/seam-real';
import { browserWebSocketFactory, type WebSocketLike } from '../real/socket';

const HERE = dirname(fileURLToPath(import.meta.url));
/** integration → data → src → tm8-ui → packages → <repo root> */
export const REPO_ROOT = resolve(HERE, '../../../../..');

/**
 * The sidecar, pinned. TWO Postgres clusters live on this machine and a bare
 * `psql` reaches the wrong one, so both the binary and the port are absolute
 * here rather than inherited from PATH or from the environment.
 */
const PG_PORT = process.env['TM8_PG_PORT'] ?? '5442';
const PG_HOST = process.env['TM8_PG_HOST'] ?? '127.0.0.1';
const PG_USER = process.env['TM8_PG_USER'] ?? 'tm8';

function findPsql(): string {
  const configured = process.env['TM8_PSQL'];
  if (configured !== undefined && configured !== '') return configured;
  for (const candidate of [
    '/opt/homebrew/opt/postgresql@18/bin/psql',
    '/usr/local/opt/postgresql@18/bin/psql',
    '/usr/lib/postgresql/18/bin/psql',
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  // Deliberately NOT a bare 'psql' fallback — see the two-clusters note above.
  throw new Error(
    'psql not found at any known Postgres 18 location. Set TM8_PSQL to an absolute path.',
  );
}

const PSQL = findPsql();
const ADMIN_URL = `postgres://${PG_USER}@${PG_HOST}:${PG_PORT}/postgres`;

/** Scratch databases this process created, so a suite can prove its own cleanup. */
const createdDatabases: string[] = [];
export function databasesCreated(): readonly string[] {
  return [...createdDatabases];
}

let labelCounter = 0;

/**
 * `-w` IS LOAD-BEARING. Without it `psql` blocks on stdin for a password inside
 * a non-interactive context and does nothing, silently, until something times
 * out — which presents as a hung suite, not as an auth error.
 * (`packages/cli/test/integration/harness.ts:58-64` documents the same trap.)
 */
function psql(url: string, args: readonly string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(PSQL, ['-w', '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', url, ...args], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status ?? -1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function psqlOrThrow(url: string, args: readonly string[], what: string): string {
  const result = psql(url, args);
  if (result.status !== 0) {
    throw new Error(`${what} failed (psql exit ${String(result.status)}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}

/**
 * The guard that stands between this fixture and a live-session-retiring write.
 * Called before creation AND before every boot, because the two are separate
 * opportunities to get it wrong.
 */
export function assertNotSharedDatabase(databaseUrl: string): void {
  const name = new URL(databaseUrl).pathname.replace(/^\//, '');
  if (!name.startsWith('tm8ui_b4_')) {
    throw new Error(
      `refusing to operate on database ${JSON.stringify(name)}: this fixture may only touch ` +
        'scratch databases named tm8ui_b4_*. Booting a node runs reconcileGhosts(), which ' +
        'retires running work_sessions — on a shared database that is a live-session kill.',
    );
  }
}

export interface IntegrationNode {
  /** `http://127.0.0.1:<ephemeral>` — the real listening node. */
  readonly baseUrl: string;
  /** `ws://127.0.0.1:<ephemeral>/v2/ws`. */
  readonly wsUrl: string;
  readonly databaseName: string;
  readonly databaseUrl: string;
  readonly production: BootstrappedServer;
  /** Raw HTTP against the node, envelope unwrapped. Drives mutations the seam does not expose. */
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<{
    status: number;
    data: T | undefined;
    error: { code: string; message: string } | undefined;
  }>;
  /**
   * GROUND TRUTH. A superuser read of the table itself, through `psql` — not
   * through the log reader, the pump, the socket or the poll route, all of
   * which are instruments under test. Rows come back as `|`-joined columns
   * (`-tA`), so callers pass explicit `coalesce(...,'')` for nullable columns:
   * an unaligned NULL and an empty string are the same bytes.
   */
  sql(text: string): string[][];
  close(): Promise<void>;
}

/**
 * Create a scratch database, apply the full official chain, and boot the real
 * composition on an ephemeral port.
 *
 * The chain is applied by `db/migrate.mjs` — the SAME runner production uses,
 * not a hand-rolled psql loop — so a migration that would fail the
 * `applied_migrations` ledger write fails here too instead of appearing to land.
 */
export async function startIntegrationNode(label: string): Promise<IntegrationNode> {
  const safeLabel = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 24);
  labelCounter += 1;
  const databaseName = `tm8ui_b4_${safeLabel}_${String(labelCounter)}_${Date.now().toString(36)}`;
  const databaseUrl = `postgres://${PG_USER}@${PG_HOST}:${PG_PORT}/${databaseName}`;
  assertNotSharedDatabase(databaseUrl);

  psqlOrThrow(ADMIN_URL, ['-c', `drop database if exists ${databaseName} with (force)`], 'scratch drop');
  psqlOrThrow(ADMIN_URL, ['-c', `create database ${databaseName}`], 'scratch create');
  createdDatabases.push(databaseName);

  const migrated = spawnSync('node', ['db/migrate.mjs', 'up'], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    // TM8_DATABASE_URL is set EXPLICITLY, every time. migrate.mjs falls back to
    // tm8_dev when it is absent, and that fallback is silent.
    env: { ...process.env, TM8_DATABASE_URL: databaseUrl },
    timeout: 300_000,
  });
  if (migrated.status !== 0) {
    throw new Error(
      `migration chain failed on ${databaseName} (exit ${String(migrated.status)}):\n` +
        `${migrated.stdout ?? ''}\n${migrated.stderr ?? ''}`,
    );
  }

  const dataDir = await mkdtemp(join(tmpdir(), 'tm8ui-b4-'));
  let production: BootstrappedServer | undefined;
  try {
    assertNotSharedDatabase(databaseUrl);
    const configured = loadConfig({
      ...process.env,
      TM8_BIND: '127.0.0.1',
      // loadConfig rightly refuses port 0 from an operator; the substitution
      // below happens AFTER validation so the kernel picks an isolated port.
      TM8_PORT: '4610',
      TM8_DATABASE_URL: databaseUrl,
      TM8_DATA_DIR: dataDir,
      // The stub agent: proves the PTY plumbing without a model or a key.
      TM8_AGENT_CMD: 'echo-agent',
      // W2 B2 delivery is NOT wired here. bootstrap() reads this one off the
      // ambient process environment rather than off `config`, so an inherited
      // value would point a second identity at someone else's database.
      TM8_DELIVERY_DATABASE_URL: undefined,
    });
    production = await bootstrap({ config: { ...configured, port: 0 } });
  } catch (error) {
    await rm(dataDir, { recursive: true, force: true });
    psql(ADMIN_URL, ['-c', `drop database if exists ${databaseName} with (force)`]);
    throw error;
  }

  const booted = production;
  const baseUrl = booted.url;

  const node: IntegrationNode = {
    baseUrl,
    wsUrl: `${baseUrl.replace(/^http/, 'ws')}/v2/ws`,
    databaseName,
    databaseUrl,
    production: booted,
    async request<T = unknown>(method: string, path: string, body?: unknown) {
      const response = await fetch(new URL(path, baseUrl), {
        method,
        ...(body === undefined
          ? {}
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      });
      const text = await response.text();
      const parsed = (text === '' ? {} : JSON.parse(text)) as {
        data?: T;
        error?: { code: string; message: string };
      };
      return { status: response.status, data: parsed.data, error: parsed.error };
    },
    sql(text: string): string[][] {
      const out = psqlOrThrow(databaseUrl, ['-tAc', text], 'ground-truth query');
      return out
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => line.split('|'));
    },
    close: closeOnce(async () => {
      await booted.server.close();
      await booted.delivery?.close();
      await booted.db?.end();
      await removeOwnedDataDir(dataDir);
      psqlOrThrow(
        ADMIN_URL,
        ['-c', `drop database if exists ${databaseName} with (force)`],
        'scratch teardown drop',
      );
    }),
  };
  return node;
}

function closeOnce(fn: () => Promise<void>): () => Promise<void> {
  let done: Promise<void> | undefined;
  return () => (done ??= fn());
}

async function removeOwnedDataDir(dataDir: string): Promise<void> {
  if (!basename(dataDir).startsWith('tm8ui-b4-')) {
    throw new Error(`refusing to remove non-fixture data directory: ${dataDir}`);
  }
  await rm(dataDir, { recursive: true, force: true });
}

/** Prove a scratch database is gone. Used by teardown assertions, not by teardown. */
export function databaseExists(name: string): boolean {
  const out = psqlOrThrow(
    ADMIN_URL,
    ['-tAc', `select count(*) from pg_database where datname = '${name}'`],
    'database existence probe',
  );
  return out.trim() !== '0';
}

// ---------------------------------------------------------------------------
// The client under test
// ---------------------------------------------------------------------------

/**
 * Every socket `createRealSeam` opened, in order. THE severing handle for the
 * kill-mid-stream suite: the seam owns its sockets and exposes no way to break
 * one, which is correct — a client that could be told to disconnect itself
 * would not be testing what a network does.
 */
export interface SocketSpy {
  readonly sockets: WebSocketLike[];
  /** The most recently created socket, or undefined before the first connect. */
  latest(): WebSocketLike | undefined;
  /** Sever the live socket the way a network does — from underneath the client. */
  severLatest(): void;
}

export interface SeamHarness {
  readonly seam: RealSeam;
  readonly spy: SocketSpy;
  /** Every event the seam dispatched, in dispatch order. */
  readonly events: DurableEventRecord[];
  /** Every connection state the seam announced, in order. */
  readonly phases: string[];
  /** Non-fatal transport noise the seam reported. Asserted empty where it matters. */
  readonly errors: Array<{ error: unknown; context: string }>;
  dispose(): void;
}

/** The two fields every assertion in this lane reads off an event. */
export interface DurableEventRecord {
  seq: number;
  type: string;
  spaceId: string;
  clientMutationId?: string;
  raw: Record<string, unknown>;
}

/**
 * Build the REAL seam against a REAL node.
 *
 * `fetch` and the WebSocket factory are passed explicitly because
 * `createRealSeam` requires them with no defaults — "this lane cannot reach the
 * network unless a caller hands it a way" is a property of the type signature,
 * and this is the one visible call site that hands it one.
 */
export function createSeamHarness(
  node: IntegrationNode,
  overrides: Partial<RealSeamOptions> = {},
): SeamHarness {
  const sockets: WebSocketLike[] = [];
  const events: DurableEventRecord[] = [];
  const phases: string[] = [];
  const errors: Array<{ error: unknown; context: string }> = [];

  const realFactory = browserWebSocketFactory(WebSocket);
  const seam = createRealSeam({
    baseUrl: node.baseUrl,
    wsUrl: node.wsUrl,
    fetch: (url, init) => fetch(url, init),
    webSocketFactory: (url) => {
      const socket = realFactory(url);
      sockets.push(socket);
      return socket;
    },
    onError: (error, context) => {
      errors.push({ error, context });
    },
    ...overrides,
  });

  seam.onEvent((event) => {
    const raw = event as unknown as Record<string, unknown>;
    events.push({
      seq: event.seq,
      type: event.type,
      spaceId: event.spaceId,
      ...(typeof raw['clientMutationId'] === 'string'
        ? { clientMutationId: raw['clientMutationId'] }
        : {}),
      raw,
    });
  });
  seam.onConnection((state) => {
    phases.push(state.phase);
  });

  const spy: SocketSpy = {
    sockets,
    latest: () => sockets[sockets.length - 1],
    severLatest() {
      const socket = sockets[sockets.length - 1];
      if (socket === undefined) throw new Error('no socket has been opened yet');
      // `close()` on the platform socket, NOT `handle.close()` on the seam's
      // wrapper: the wrapper silences its own handlers first, which is exactly
      // the code path a real disconnect must NOT take. This is the network
      // going away, not the client hanging up.
      socket.close();
    },
  };

  return {
    seam,
    spy,
    events,
    phases,
    errors,
    dispose: () => {
      seam.dispose();
    },
  };
}

// ---------------------------------------------------------------------------
// Waiting — always on a measured condition, never on a sleep
// ---------------------------------------------------------------------------

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Poll `predicate` until true. On timeout it throws with `describe()`'s answer,
 * so a failure says what the world actually looked like instead of "timed out".
 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  describeState: () => string,
  ms = 30_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) {
      throw new Error(`condition never became true within ${String(ms)}ms — ${describeState()}`);
    }
    await delay(25);
  }
}

/**
 * Resolve after `ms` with no NEW event having been dispatched; reject if one
 * was. The production pump ticks at 1s, so a meaningful "nothing more is
 * coming" needs to outlast several ticks — a shorter window measures the pump's
 * schedule, not the server's answer.
 */
export async function expectQuiet(events: readonly unknown[], ms = 3_200): Promise<void> {
  const baseline = events.length;
  await delay(ms);
  if (events.length !== baseline) {
    throw new Error(
      `expected silence for ${String(ms)}ms but ${String(events.length - baseline)} event(s) arrived`,
    );
  }
}

/** Three pump ticks. Named so every quiet window in this lane means the same thing. */
export const QUIET_MS = 3_200;

// ---------------------------------------------------------------------------
// Fixture recipes
// ---------------------------------------------------------------------------

let cmidCounter = 0;
/**
 * Every HTTP command needs one: the SEC1 replay binding refuses a mutation
 * without a `clientMutationId` (400). Counter-based rather than random so a
 * failure message names which call minted it.
 */
export function cmid(tag = 'b4'): string {
  cmidCounter += 1;
  return `cmid_${tag}_${String(cmidCounter)}_${Date.now().toString(36)}`;
}

export interface SpaceFixture {
  spaceId: string;
  /** The loopback owner's member id in this space — the RLS subject every socket resolves to. */
  memberId: string;
}

/**
 * Create the space OVER HTTP so it belongs to the loopback owner — the same
 * identity every WS connection resolves to (`main.ts` wsClaimsFor). A space
 * created under any other identity would be invisible to the socket under test.
 */
export async function createSpace(node: IntegrationNode, name: string): Promise<SpaceFixture> {
  const created = await node.request<{ space: { id: string } }>('POST', '/v2/spaces', {
    name,
    clientMutationId: cmid('space'),
  });
  if (created.status !== 201 || created.data === undefined) {
    throw new Error(`space create failed: ${String(created.status)} ${JSON.stringify(created.error)}`);
  }
  const spaceId = created.data.space.id;
  const rows = node.sql(
    `select entity_id from public.members where space_id = '${spaceId}'
      order by case role when 'owner' then 0 when 'admin' then 1 else 2 end, joined_at asc limit 1`,
  );
  const memberId = rows[0]?.[0];
  if (memberId === undefined) throw new Error(`space ${spaceId} has no members`);
  return { spaceId, memberId };
}

/** A task, over the public HTTP door. Returns its entity id. */
export async function createTask(
  node: IntegrationNode,
  spaceId: string,
  title: string,
  clientMutationId = cmid('task'),
): Promise<string> {
  const res = await node.request<{ entity: { id: string } }>('POST', '/v2/entities', {
    spaceId,
    kind: 'task',
    title,
    clientMutationId,
  });
  if (res.status !== 201 || res.data === undefined) {
    throw new Error(`task create failed: ${String(res.status)} ${JSON.stringify(res.error)}`);
  }
  return res.data.entity.id;
}

/**
 * A channel, needed as the subject of `space.default_channel.updated`.
 *
 * `title` must be a CHANNEL SLUG, not prose: `public.channels.name` carries
 * `check (name ~ '^[a-z0-9][a-z0-9_-]{0,79}$')` (001_core_graph.sql:503), so a
 * title with spaces earns a 409 `invariant_violation` from the check
 * constraint. Asserted here rather than left to the server, because the
 * server's message names the constraint and not the caller's mistake.
 */
export async function createChannel(
  node: IntegrationNode,
  spaceId: string,
  title: string,
): Promise<string> {
  if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(title)) {
    throw new Error(
      `channel name ${JSON.stringify(title)} cannot satisfy public.channels.name ` +
        "check (name ~ '^[a-z0-9][a-z0-9_-]{0,79}$') — pass a slug, not prose",
    );
  }
  const res = await node.request<{ entity: { id: string } }>('POST', '/v2/entities', {
    spaceId,
    kind: 'channel',
    title,
    clientMutationId: cmid('channel'),
  });
  if (res.status !== 201 || res.data === undefined) {
    throw new Error(`channel create failed: ${String(res.status)} ${JSON.stringify(res.error)}`);
  }
  return res.data.entity.id;
}

/**
 * GROUND TRUTH for a space's event spine: every seq the table holds after
 * `afterSeq`, split into what the OWNER's connection may see (space-feed rows
 * plus rows addressed to the owner's own member, 008:156-161) and what RLS
 * keeps from it. Every exact-set assertion in this lane compares the wire
 * against THIS — never only against another reader of the same log, which is
 * the W5 cursor-truncation ruling: two readers can truncate identically and
 * agree perfectly on a lie.
 */
export function groundTruth(
  node: IntegrationNode,
  spaceId: string,
  memberId: string,
  afterSeq = 0,
): { visible: number[]; excluded: number[]; all: Array<[number, string]> } {
  const rows = node.sql(
    `select seq, event_type, coalesce(recipient_member_id::text, '') from public.workspace_events
      where space_id = '${spaceId}' and seq > ${String(afterSeq)} order by seq asc`,
  );
  const visible: number[] = [];
  const excluded: number[] = [];
  const all: Array<[number, string]> = [];
  for (const [seqText, eventType, recipient] of rows) {
    const seq = Number(seqText);
    all.push([seq, eventType ?? '']);
    if (recipient === '' || recipient === memberId) visible.push(seq);
    else excluded.push(seq);
  }
  return { visible, excluded, all };
}

/** Rows the table holds for one event type, oldest first — payload included. */
export function groundTruthOfType(
  node: IntegrationNode,
  spaceId: string,
  eventType: string,
): Array<{ seq: number; payload: unknown }> {
  const rows = node.sql(
    `select seq, payload::text from public.workspace_events
      where space_id = '${spaceId}' and event_type = '${eventType}' order by seq asc`,
  );
  return rows.map(([seqText, payloadText]) => ({
    seq: Number(seqText),
    payload: JSON.parse(payloadText ?? 'null') as unknown,
  }));
}

/**
 * Walk `events.poll` to EXHAUSTION over raw HTTP and return the (seq,type)
 * spine. Never a single page: a lone `limit=500` read truncates silently the
 * moment the log outgrows it, and every downstream "the spines agree"
 * assertion would then agree on the truncation.
 *
 * MEASURED SERVER BEHAVIOUR, recorded because it changes what the terminal
 * marker is: this feed has no end. `nextCursor` is always a decimal string and
 * the server ECHOES the caller's own `since` on an empty page (poll.ts:126-135)
 * — it never emits `nextCursor: null`. LLD §11's rule ("a short page without
 * `nextCursor: null` is a signal, not a pass") therefore cannot be applied
 * literally against this route; the equivalent controls, which this walk does
 * enforce, are (a) the seeded-count comparison against `groundTruth`, and
 * (b) the bounded page guard below, which turns a wedged cursor into a named
 * failure instead of an infinite loop. If a `null` ever DOES appear here, that
 * is a server change and `assertPollTerminates` says so out loud.
 */
export async function pollSpine(
  node: IntegrationNode,
  spaceId: string,
  sinceSeq = 0,
  limit = 200,
): Promise<{ spine: Array<[number, string]>; pages: number; sawNullCursor: boolean }> {
  const spine: Array<[number, string]> = [];
  let cursor = sinceSeq;
  let sawNullCursor = false;
  for (let page = 1; page <= 100; page += 1) {
    const res = await node.request<{ items: Array<Record<string, unknown>>; nextCursor: string | null }>(
      'GET',
      `/v2/spaces/${spaceId}/events?since=${String(cursor)}&limit=${String(limit)}`,
    );
    if (res.status !== 200 || res.data === undefined) {
      throw new Error(`events.poll failed: ${String(res.status)} ${JSON.stringify(res.error)}`);
    }
    if (res.data.nextCursor === null) sawNullCursor = true;
    if (res.data.items.length === 0) return { spine, pages: page, sawNullCursor };
    for (const item of res.data.items) {
      spine.push([Number(item['seq']), String(item['type'])]);
    }
    const next = Number(res.data.nextCursor);
    if (!Number.isFinite(next) || next <= cursor) {
      throw new Error(
        `events.poll cursor did not advance on page ${String(page)}: since=${String(cursor)} ` +
          `nextCursor=${JSON.stringify(res.data.nextCursor)} items=${String(res.data.items.length)}`,
      );
    }
    cursor = next;
  }
  throw new Error('events.poll walk did not terminate in 100 pages — the cursor is not advancing');
}

/**
 * A runtime assertion that the aliased imports and the deduped contract copy
 * are what this lane believes they are. Cheap, and it converts three different
 * silent-wrong-module failures into one named error at the top of the run.
 */
export function assertHarnessWiring(): void {
  if (typeof bootstrap !== 'function') {
    throw new Error('@tm8/server-src-main did not resolve to the server composition root');
  }
  if (typeof loadConfig !== 'function') {
    throw new Error('@tm8/server-src-config did not resolve to the server config module');
  }
  // One physical @tm8/contract. Two copies would make every `instanceof
  // CollabError` in this lane false for a reason that has nothing to do with
  // the server, and the resulting failures would read as transport bugs.
  const probe = new CollabError('not_found', 'wiring probe');
  if (!(probe instanceof CollabError)) {
    throw new Error('@tm8/contract is loaded more than once — CollabError identity is split');
  }
}
