/**
 * GHOST ROWS — a session credential containment kills must END in the graph.
 *
 * The finding (SC-7 e2e lane): the SC-3 space-credential delete, the member
 * Disconnect and SC-6's member removal each killed an agent's PTY with a bare
 * `PtyHostService.kill`. `kill()` finalizes the PTY entry synchronously, so the
 * late node-pty `onExit` returns at its identity check and `handlePtyExit`
 * never runs — nothing wrote the row. It read `running` forever: counted
 * against the concurrency cap, and refusing a resume as "is 'running'" instead
 * of for the credential that was taken away.
 *
 * Everything here is the PRODUCTION composition over a real PostgreSQL:
 * `createExecutionRuntime` builds the real `PtyHostService` (its
 * `onSessionStatus` wired to `SpawnService.handlePtyExit`), the real
 * `SpawnService` and the real `DbGraphPort`; the containment callers are the
 * real services handed `runtime.spawnService`, as `main.ts` hands it. Each
 * session is a real login-shell PTY started by `SpawnService.startShell` —
 * so its launcher's claims are captured exactly as a spawn captures them —
 * whose row a fixture then gives an agent's shape and a space credential
 * (206's `record_session_manifest`, under the launcher's claims).
 *
 * Names carry the task's acceptance criterion (gh-N) they evidence.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { CredentialSessionLauncher } from '@tm8/execution';

import { resetCredentialKeyCache } from '../../src/credentials/credential-key.js';
import { SpaceCredentialMemberContainment } from '../../src/credentials/space-credential-containment.js';
import { DbSpaceCredentialStore } from '../../src/credentials/space-credential-store.js';
import { createDb } from '../../src/db/index.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import { createExecutionRuntime, type ExecutionRuntime } from '../../src/facade/execution-handlers.js';
import { W2CredentialCatalogService } from '../../src/facade/services/w2/credential-catalog.js';
import { SpaceCredentialCatalogService } from '../../src/facade/services/w2/space-credential-catalog.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const OWN = 'gh-owner';
const A = 'gh-a';
const B = 'gh-b';

let database: W1ScratchDatabase;
let db: Db;
let dataDir: string;
let store: DbSpaceCredentialStore;
let runtime: ExecutionRuntime;
let spaceCatalog: SpaceCredentialCatalogService;
let disconnect: W2CredentialCatalogService;
let memberRemoval: SpaceCredentialMemberContainment;
const ids: Record<string, string> = {};
const accounts: Record<string, string> = {};
/** Every session a test started; afterEach kills whatever is still up. */
const started: string[] = [];
let priorAgentCmd: string | undefined;

const claims = (identityId: string): DbClaims =>
  ({ identityId, nodeAdmin: false, requestId: randomUUID(), authKind: 'browser' }) as DbClaims;
const nodeAdmin = (): DbClaims => ({ ...claims(OWN), nodeAdmin: true }) as DbClaims;

const quiet = { debug() {}, info() {}, warn() {}, error() {} };

type Client = import('pg').PoolClient;

async function asOwner<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

const newId = async (c: Client): Promise<string> =>
  (await c.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;

async function setStatus(c: Client, sessionId: string, status: string): Promise<void> {
  await c.query(`select set_config('tm8.work_session_transition', 'on', true)`);
  await c.query('update public.work_sessions set status = $2 where entity_id = $1', [sessionId, status]);
}

interface Row {
  status: string;
  ended_kind: string | null;
  ended_reason: string | null;
  error: string | null;
  version: string;
}

async function row(sessionId: string): Promise<Row> {
  return asOwner(async (c) => (await c.query<Row>(
    `select ws.status, ws.ended_kind, ws.ended_reason, ws.error, e.version::text
       from public.work_sessions ws join public.entities e on e.id = ws.entity_id
      where ws.entity_id = $1`,
    [sessionId],
  )).rows[0]!);
}

/** 083's cap count: live AGENT sessions node-wide. */
async function liveAgentCount(): Promise<number> {
  return asOwner(async (c) => (await c.query<{ n: number }>(
    'select internal.live_work_session_count(null) n',
  )).rows[0]!.n);
}

/** The real node-pty process behind a live session (to await its real exit). */
function procOf(sessionId: string): { pid: number; kill: (signal?: string) => void; onExit: (fn: () => void) => unknown } {
  const entry = (runtime.pty as unknown as { sessions: Map<string, { proc: never }> }).sessions.get(sessionId);
  if (!entry) throw new Error(`no live PTY for ${sessionId}`);
  return entry.proc;
}

/** Resolves when node-pty delivers this process's exit event — the late onExit. */
function exitEvent(sessionId: string): Promise<void> {
  const proc = procOf(sessionId);
  return new Promise((resolve) => { proc.onExit(() => resolve()); });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * A LIVE agent session launched by `launcher`: a real PTY under
 * `SpawnService`, whose row carries A's teammate TA, claude-code, a native
 * session id (so a resume can reach credential resolution), and — when given —
 * the space credentials 206 records at launch, under the launcher's claims.
 */
async function liveAgentSession(
  launcher: string,
  spaceCredentialIds: Record<string, string> = {},
): Promise<string> {
  const shell = await runtime.spawnService.startShell(claims(launcher), { spaceId: ids.S!, projectId: null });
  const sessionId = shell.sessionId;
  started.push(sessionId);
  await asOwner(async (c) => {
    await setStatus(c, sessionId, 'spawning');
    await c.query(
      `update public.work_sessions
          set session_kind = 'agent', agent_tool = 'claude-code', native_session_id = $2, mode = 'worker'
        where entity_id = $1`,
      [sessionId, randomUUID()],
    );
    await c.query(
      `insert into public.edges(space_id, src_id, dst_id, type, created_by) values ($3, $1, $2, 'relates_to', $4)`,
      [sessionId, ids.TA, ids.S, ids[`member:${launcher}`]],
    );
  });
  const sources = Object.fromEntries(Object.keys(spaceCredentialIds).map((p) => [p, 'space']));
  await db.rpc(claims(launcher), 'record_session_manifest', [sessionId, JSON.stringify({
    launch: { credentialSources: sources, spaceCredentialIds, effectiveCredentialSources: sources },
  })]);
  await asOwner(async (c) => setStatus(c, sessionId, 'running'));
  expect(runtime.pty.hasSession(sessionId)).toBe(true);
  expect((await row(sessionId)).status).toBe('running');
  return sessionId;
}

async function anthropicKey(who = A): Promise<string> {
  const secret = `sk-ant-api03-${randomUUID().replaceAll('-', '')}`;
  return (await store.create(claims(who), {
    spaceId: ids.S!, provider: 'anthropic', shape: 'api_key', label: `k ${randomUUID()}`, secret,
  })).id;
}

/** Counts `work_session_transition` writes per session, on the real graph port. */
function countTransitions(): { of: (sessionId: string) => number; restore: () => void } {
  const spy = vi.spyOn(runtime.graph, 'transition');
  return {
    of: (sessionId) => spy.mock.calls.filter(([, input]) => (input as { sessionId: string }).sessionId === sessionId).length,
    restore: () => spy.mockRestore(),
  };
}

beforeAll(async () => {
  priorAgentCmd = process.env['TM8_AGENT_CMD'];
  // A resume must get past the operator-wrapper refusal to reach credentials.
  delete process.env['TM8_AGENT_CMD'];
  dataDir = await mkdtemp(join(tmpdir(), 'tm8-ghost-rows-'));
  resetCredentialKeyCache();
  database = await createW1ScratchDatabase('credential_containment_ending');
  database.apply(migrationFiles());
  db = createDb(database.url);
  store = new DbSpaceCredentialStore({ db, dataDir });
  await asOwner(async (c) => {
    for (const identity of [OWN, A, B]) {
      await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, $1)`, [identity]);
      const { rows } = await c.query<{ id: string }>(
        `insert into public.accounts(identity_id, username, display_name, is_node_admin, is_owner)
         values ($1, $1, $1, false, $2) returning id::text`,
        [identity, identity === OWN],
      );
      accounts[identity] = rows[0]!.id;
    }
    ids.S = await newId(c);
    await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'S', $2)`, [ids.S, OWN]);
    for (const [identity, role] of [[OWN, 'owner'], [A, 'member'], [B, 'member']] as const) {
      const member = ids[`member:${identity}`] = await newId(c);
      await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'member', 0, $1)`, [member, ids.S]);
      await c.query(
        `insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, $4, $3)`,
        [member, ids.S, identity, role],
      );
    }
    ids.TA = await newId(c);
    await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'team_member', 0, $3)`, [
      ids.TA, ids.S, ids[`member:${A}`],
    ]);
    await c.query(
      `insert into public.team_members(entity_id, owner_member_id, name, role, identity, model, agent_tool)
       values ($1, $2, 'TA', 'worker', 'ghost-rows', 'opus', 'claude-code')`,
      [ids.TA, ids[`member:${A}`]],
    );
  });

  runtime = createExecutionRuntime({
    db,
    config: { host: '127.0.0.1', port: 0 } as never,
    dataDir,
    nodeId: 'ghost-rows-node',
    sessionCap: 100,
    logger: quiet,
  });
  // The production wiring: main.ts hands `execution.spawnService` to the
  // credential handlers as `agentSessions`; login terminals stay on the launcher.
  const terminals = new CredentialSessionLauncher({ pty: runtime.pty });
  spaceCatalog = new SpaceCredentialCatalogService({
    db,
    store,
    probe: async () => ({ ok: true, displayLogin: null }),
    terminals,
    agentSessions: runtime.spawnService,
    env: {},
  });
  disconnect = new W2CredentialCatalogService({
    db,
    terminals,
    agentSessions: runtime.spawnService,
    dataDir,
    removeCredentialFiles: async () => undefined,
  });
  memberRemoval = new SpaceCredentialMemberContainment({ store, agentSessions: runtime.spawnService });
}, 300_000);

afterEach(async () => {
  vi.restoreAllMocks();
  for (const id of started.splice(0)) runtime.pty.kill(id, false);
});

afterAll(async () => {
  runtime?.pty.shutdownAll();
  await db?.end();
  await database?.destroy();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  resetCredentialKeyCache();
  if (priorAgentCmd === undefined) delete process.env['TM8_AGENT_CMD'];
  else process.env['TM8_AGENT_CMD'] = priorAgentCmd;
});

const DELETED = 'Stopped because the space credential it was running on was deleted.';
const DISCONNECTED = 'Stopped because the credential it was running on was disconnected.';
const REMOVED = 'Stopped because the member who launched it no longer has access to the space credential it was running on.';

describe('gh-1 — a space-credential delete ends the rows of the sessions it kills', () => {
  it('the real SC-3 delete kills the PTY and the row reads exited / stopped_by_operator / the delete', async () => {
    const key = await anthropicKey();
    const sessionId = await liveAgentSession(A, { anthropic: key });

    const result = await spaceCatalog.delete(claims(A), key);

    expect(result.terminatedAgentSessionIds).toEqual([sessionId]);
    expect(result.failures).toEqual([]);
    expect(runtime.pty.hasSession(sessionId)).toBe(false);
    expect(await row(sessionId)).toMatchObject({
      status: 'exited',
      ended_kind: 'stopped_by_operator',
      ended_reason: DELETED,
    });
  });
});

describe('gh-2 — the member Disconnect and SC-6 member removal end the rows too', () => {
  it('Disconnect of the member’s own anthropic credential ends the agent session it ran on', async () => {
    // No space credential: this session ran on the member's own login.
    const sessionId = await liveAgentSession(A);

    const result = await disconnect.delete('anthropic', { identityId: A, claims: claims(A) });

    expect(result.terminatedAgentSessionIds).toEqual([sessionId]);
    expect(result.failures.filter((f) => f.step === 'agentSession')).toEqual([]);
    expect(runtime.pty.hasSession(sessionId)).toBe(false);
    expect(await row(sessionId)).toMatchObject({
      status: 'exited',
      ended_kind: 'stopped_by_operator',
      ended_reason: DISCONNECTED,
    });
  });

  it('member removal, under a NODE ADMIN who is not the launcher, ends the row under the launcher’s claims', async () => {
    const key = await anthropicKey();
    const sessionId = await liveAgentSession(A, { anthropic: key });

    const result = await memberRemoval.killSessionsLaunchedBy(nodeAdmin(), accounts[A]!, null);

    expect(result.terminatedSessionIds).toEqual([sessionId]);
    expect(result.failures).toEqual([]);
    expect(await row(sessionId)).toMatchObject({
      status: 'exited',
      ended_kind: 'stopped_by_operator',
      ended_reason: REMOVED,
    });
  });
});

describe('gh-3 — a contained row stops counting against the cap, and a resume refuses for the credential', () => {
  it('the cap count drops by one, and resume says "has been deleted", not "is \'running\'"', async () => {
    const key = await anthropicKey();
    const sessionId = await liveAgentSession(A, { anthropic: key });
    const before = await liveAgentCount();

    await spaceCatalog.delete(claims(A), key);

    expect(await liveAgentCount()).toBe(before - 1);
    const refused = await runtime.spawnService.resume(claims(A), { sessionId }).then(
      () => null,
      (error: unknown) => error as Error,
    );
    expect(refused).toBeInstanceOf(Error);
    expect(refused!.message).not.toMatch(/is 'running'/);
    expect(refused!.message).toMatch(/has been deleted/);
    // The refused resume left no live session behind it either.
    expect(runtime.pty.hasSession(sessionId)).toBe(false);
    expect(await liveAgentCount()).toBe(before - 1);
  });
});

describe('gh-4 — one transition, no stomp, terminate unchanged, no secret', () => {
  it('kill first: the late onExit really fires and writes nothing — exactly one transition', async () => {
    const key = await anthropicKey();
    const sessionId = await liveAgentSession(A, { anthropic: key });
    const proc = procOf(sessionId);
    const exited = exitEvent(sessionId);
    const transitions = countTransitions();
    const exitSink = vi.spyOn(runtime.spawnService, 'handlePtyExit');

    await spaceCatalog.delete(claims(A), key);
    const contained = await row(sessionId);

    // The race, reached: the real process dies and node-pty delivers its exit.
    await exited;
    await vi.waitFor(() => expect(alive(proc.pid)).toBe(false));
    await new Promise((r) => setTimeout(r, 250));

    expect(transitions.of(sessionId)).toBe(1);
    expect(exitSink).not.toHaveBeenCalledWith(sessionId, expect.anything(), expect.anything());
    // Byte-for-byte the containment's ending, and no later version.
    expect(await row(sessionId)).toEqual(contained);
    transitions.restore();
  });

  it('exit first: a containment that arrives after the process exited on its own writes nothing', async () => {
    const sessionId = await liveAgentSession(A);
    const exited = exitEvent(sessionId);
    runtime.pty.write(sessionId, 'exit 0\n');
    await exited;
    // The exit's own ending, written by handlePtyExit under the launcher.
    await vi.waitFor(async () => expect(await row(sessionId)).toMatchObject({ status: 'exited', ended_kind: 'completed' }), {
      timeout: 10_000,
    });
    const ended = await row(sessionId);
    const transitions = countTransitions();

    const result = await runtime.spawnService.containCredentialSession(sessionId, 'member_removed');

    expect(result).toEqual({ outcome: 'not_found', recorded: false });
    expect(transitions.of(sessionId)).toBe(0);
    expect(await row(sessionId)).toEqual(ended);
    expect(ended.ended_reason).not.toBe(REMOVED);
    transitions.restore();
  });

  it('a kill that FAILS leaves the row running and names the failure (kill before stamp)', async () => {
    const key = await anthropicKey();
    const sessionId = await liveAgentSession(A, { anthropic: key });
    const proc = procOf(sessionId);
    const realKill = proc.kill.bind(proc);
    proc.kill = () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }); };
    const transitions = countTransitions();
    try {
      const result = await spaceCatalog.delete(claims(A), key);

      expect(result.terminatedAgentSessionIds).toEqual([]);
      expect(result.failures).toEqual([
        { step: 'agentSession', sessionId, reason: 'the PTY host could not kill this agent session' },
      ]);
      expect(transitions.of(sessionId)).toBe(0);
      expect((await row(sessionId)).status).toBe('running');
    } finally {
      transitions.restore();
      realKill();
    }
  });

  it('terminate is unchanged: its own ending, under the caller, distinct from a containment', async () => {
    const sessionId = await liveAgentSession(A);
    const transitions = countTransitions();

    const result = await runtime.spawnService.terminate(claims(A), sessionId);

    expect(result.outcome).toBe('killed');
    expect(transitions.of(sessionId)).toBe(1);
    expect(await row(sessionId)).toMatchObject({
      status: 'exited',
      ended_kind: 'stopped_by_operator',
      ended_reason: 'Stopped by request.',
      error: 'terminated by request — exit code not observed, kill does not wait for the real exit event',
    });
    transitions.restore();
  });

  it('I5: no secret, credential id or label reaches the recorded ending', async () => {
    const secret = `sk-ant-api03-${randomUUID().replaceAll('-', '')}`;
    const label = `label-${randomUUID()}`;
    const key = (await store.create(claims(A), { spaceId: ids.S!, provider: 'anthropic', shape: 'api_key', label, secret })).id;
    const sessionId = await liveAgentSession(A, { anthropic: key });

    await spaceCatalog.delete(claims(A), key);

    const ended = JSON.stringify(await row(sessionId));
    expect(ended).toContain(DELETED);
    for (const leaked of [secret, key, label, 'sk-ant']) expect(ended).not.toContain(leaked);
  });
});
