/**
 * SC-2 — the launch path against a REAL PostgreSQL with migration 206: the
 * real `DbSpaceCredentialPort` feeding the real `resolveSessionCredentials`,
 * the real `record_session_manifest` writer, and the real repoint RPC, each
 * under the caller's claims as `tm8_app`.
 *
 * `packages/execution/test/space-credential-spawn.test.ts` pins that
 * SpawnService calls these in the right ORDER around the PTY; this file pins
 * that each step, run against 206, gives the answer that order relies on.
 *
 * Cast (space S): OWN owner, ADM admin, A and B members, B owns teammate TB,
 * OUT a member of space T only. Every identity case is C1's shape: A launches
 * (or resumes) a session created by B's teammate, and the result follows A.
 * Test names carry the acceptance criterion (t2-N) they evidence.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  materializeSpaceApiKeyHome,
  resolveLaunchConfig,
  resolveSessionCredentials,
  SpawnError,
  type AgentCredentialHome,
  type ResolvedLaunchConfig,
  type SessionLaunchPosture,
  type SpawnContext,
  type SpawnRequest,
} from '@tm8/execution';

import { resetCredentialKeyCache } from '../../src/credentials/credential-key.js';
import { DbSpaceCredentialPort } from '../../src/credentials/space-credential-port.js';
import { DbSpaceCredentialStore } from '../../src/credentials/space-credential-store.js';
import { createDb } from '../../src/db/index.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const OWN = 'sc2-owner';
const ADM = 'sc2-admin';
const A = 'sc2-a';
const B = 'sc2-b';
const OUT = 'sc2-out';

let database: W1ScratchDatabase;
let db: Db;
let dataDir: string;
let store: DbSpaceCredentialStore;
let port: DbSpaceCredentialPort;
const ids: Record<string, string> = {};
const accounts: Record<string, string> = {};

const claims = (identityId: string, authKind = 'browser'): DbClaims =>
  ({ identityId, nodeAdmin: false, requestId: randomUUID(), authKind }) as DbClaims;
/** An agent's claims: its root human launcher's identity, agent auth kind. */
const agent = (identityId: string): DbClaims => claims(identityId, 'agent');

type Client = import('pg').PoolClient;

async function asOwner<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

const newId = async (c: Client): Promise<string> =>
  (await c.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;

/** A work session in S created by B's teammate TB — never by the launcher. */
async function sessionForTB(status = 'spawning'): Promise<string> {
  return asOwner(async (c) => {
    const id = await newId(c);
    await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'work_session', 0, $3)`, [id, ids.S, ids.TB]);
    await c.query(`insert into public.work_sessions(entity_id, title, status, session_kind, workdir_mode) values ($1, 'fixture', $2, 'agent', 'scratch')`, [id, status]);
    return id;
  });
}

async function setSessionStatus(sessionId: string, status: string): Promise<void> {
  await asOwner(async (c) => {
    await c.query(`select set_config('tm8.work_session_transition', 'on', true)`);
    await c.query('update public.work_sessions set status = $2 where entity_id = $1', [sessionId, status]);
  });
}

async function recorded(sessionId: string): Promise<Array<{ provider: string; space_credential_id: string; launcher_account_id: string | null }>> {
  return asOwner(async (c) => (await c.query(
    'select provider, space_credential_id, launcher_account_id from public.session_space_credentials where work_session_id = $1 order by provider',
    [sessionId],
  )).rows);
}

const CONTEXT: () => SpawnContext = () => ({
  spaceId: ids.S!,
  project: null,
  teamMember: {
    id: ids.TB!, name: 'TB', role: 'fixture', identity: 'fixture', memories: [], model: 'opus',
    agentTool: 'claude-code', mode: 'worker', permissionMode: null, avatar: null, capabilities: {}, commandPermissions: {},
  },
  tasks: [],
});

function launch(request: Partial<SpawnRequest> = {}, inherited?: SessionLaunchPosture | null): ResolvedLaunchConfig {
  return resolveLaunchConfig({ spaceId: ids.S!, teamMemberId: ids.TB!, ...request }, CONTEXT(), {}, inherited);
}

/** The real resolution against the real port; the member rung is a fixture. */
async function resolve(
  who: DbClaims,
  sessionId: string,
  l: ResolvedLaunchConfig,
  opts: { resume?: boolean; memberHome?: AgentCredentialHome | null } = {},
) {
  return resolveSessionCredentials(
    { auth: who, spaceId: ids.S!, launch: l, resume: opts.resume ?? false },
    {
      spaceCredentials: port,
      async resolveMemberHome(source) {
        const home = opts.memberHome ?? null;
        if (source === 'member' && !home) throw new SpawnError('nothing connected', 'conflict');
        return home;
      },
      async resolveMemberGitHub() {
        return null;
      },
      materializeApiKeyHome: (input) => materializeSpaceApiKeyHome({ dataDir, sessionId, ...input }),
    },
  );
}

/** What SpawnService hands record_session_manifest, reduced to what 206 reads. */
async function recordManifest(who: DbClaims, sessionId: string, l: ResolvedLaunchConfig): Promise<unknown> {
  const manifest = {
    launch: {
      credentialSources: l.credentialSources,
      spaceCredentialIds: l.spaceCredentialIds ?? {},
      effectiveCredentialSources: l.effectiveCredentialSources ?? {},
    },
  };
  return db.rpc(who, 'record_session_manifest', [sessionId, JSON.stringify(manifest)]);
}

/** The posture a child or a resume reads back (the loader in execution-handlers). */
function postureOf(l: ResolvedLaunchConfig): SessionLaunchPosture {
  return { credentialSources: l.credentialSources, spaceCredentialIds: l.spaceCredentialIds ?? {} } as SessionLaunchPosture;
}

async function newAnthropicKey(who = A, isDefaultWanted = false) {
  const secret = `sk-ant-api03-${randomUUID().replaceAll('-', '')}`;
  const credential = await store.create(claims(who), { spaceId: ids.S!, provider: 'anthropic', shape: 'api_key', label: `k ${randomUUID()}`, secret });
  if (isDefaultWanted && !credential.isDefault) await store.setDefault(claims(who), credential.id);
  return { credential, secret };
}

async function refusal(promise: Promise<unknown>): Promise<SpawnError> {
  const error = await promise.then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(SpawnError);
  return error as SpawnError;
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'tm8-sc2-spawn-'));
  resetCredentialKeyCache();
  database = await createW1ScratchDatabase('space_credential_spawn');
  database.apply(migrationFiles());
  db = createDb(database.url);
  store = new DbSpaceCredentialStore({ db, dataDir });
  port = new DbSpaceCredentialPort({ db, store, dataDir });
  await asOwner(async (c) => {
    for (const identity of [OWN, ADM, A, B, OUT]) {
      await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, $1)`, [identity]);
      const { rows } = await c.query<{ id: string }>(
        `insert into public.accounts(identity_id, username, display_name, is_node_admin, is_owner)
         values ($1, $1, $1, false, $2) returning id::text`,
        [identity, identity === OWN],
      );
      accounts[identity] = rows[0]!.id;
    }
    ids.S = await newId(c);
    ids.T = await newId(c);
    await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'S', $3), ($2, 'T', $4)`, [ids.S, ids.T, OWN, OUT]);
    const memberships: Array<[string, string, string]> = [
      [ids.S, OWN, 'owner'], [ids.S, ADM, 'admin'], [ids.S, A, 'member'], [ids.S, B, 'member'],
      [ids.T, OUT, 'owner'], [ids.T, A, 'member'],
    ];
    for (const [space, identity, role] of memberships) {
      const member = ids[`member:${space === ids.S ? 'S' : 'T'}:${identity}`] = await newId(c);
      await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'member', 0, $1)`, [member, space]);
      await c.query(
        `insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, $4, $3)`,
        [member, space, identity, role],
      );
    }
    ids.TB = await newId(c);
    await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'member', 0, $3)`, [
      ids.TB, ids.S, ids['member:S:' + B],
    ]);
  });
  // The space default anthropic key, created by B.
  ids.DEFAULT = (await newAnthropicKey(B, true)).credential.id;
}, 300_000);

afterEach(async () => {
  await store.setSpacePolicy(claims(OWN), ids.S!, 'anthropic', null);
  await store.setNodePolicy(claims(OWN), 'anthropic', null);
});

afterAll(async () => {
  await db?.end();
  await database?.destroy();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  resetCredentialKeyCache();
});

describe('C1/C2 — the launcher is the caller, never the persona owner', () => {
  it("t2-10: A launches B's teammate on the space default; resolution, membership and launcher_account_id follow A", async () => {
    const sessionId = await sessionForTB();
    const r = await resolve(claims(A), sessionId, launch());
    expect(r.launch.spaceCredentialIds).toEqual({ anthropic: ids.DEFAULT });
    await recordManifest(claims(A), sessionId, r.launch);
    expect(await recorded(sessionId)).toEqual([
      { provider: 'anthropic', space_credential_id: ids.DEFAULT, launcher_account_id: accounts[A] },
    ]);
  });

  it("t2-10 / A3: A's agent spawns a child for B's teammate, explicitly choosing a space key; the launcher is A", async () => {
    const { credential } = await newAnthropicKey(A);
    const parent = await sessionForTB();
    const parentLaunch = (await resolve(agent(A), parent, launch({
      credentialSources: { anthropic: 'space' },
      spaceCredentialIds: { anthropic: credential.id },
    }))).launch;
    await recordManifest(agent(A), parent, parentLaunch);
    expect((await recorded(parent))[0]?.launcher_account_id).toBe(accounts[A]);

    // The child inherits the EXACT id, not the space default.
    const child = await sessionForTB();
    const childLaunch = (await resolve(agent(A), child, launch({ parentSessionId: parent }, postureOf(parentLaunch)))).launch;
    await recordManifest(agent(A), child, childLaunch);
    expect(await recorded(child)).toEqual([
      { provider: 'anthropic', space_credential_id: credential.id, launcher_account_id: accounts[A] },
    ]);
  });

  it('t2-1: a pinned id from another space is refused by the real reader (A is a member of both spaces)', async () => {
    const secret = `sk-ant-api03-${randomUUID().replaceAll('-', '')}`;
    const inT = await store.create(claims(A), { spaceId: ids.T!, provider: 'anthropic', shape: 'api_key', label: 'in T', secret });
    const sessionId = await sessionForTB();
    const e = await refusal(resolve(claims(A), sessionId, launch({
      credentialSources: { anthropic: 'space' },
      spaceCredentialIds: { anthropic: inT.id },
    })));
    expect(e.message).toContain(`space credential ${inT.id} is not a anthropic credential of this space`);
    expect(e.message).not.toContain(secret);
  });
});

describe('M7 — a delete interleaved with the launch leaves no live session on it (t2-8)', () => {
  it('delete between read and record: the locked writer refuses, so no PTY is ever started', async () => {
    const { credential } = await newAnthropicKey(A);
    const sessionId = await sessionForTB();
    const r = await resolve(claims(A), sessionId, launch({
      credentialSources: { anthropic: 'space' },
      spaceCredentialIds: { anthropic: credential.id },
    }));
    await store.revoke(claims(A), credential.id);
    await expect(recordManifest(claims(A), sessionId, r.launch)).rejects.toThrow();
    expect(await recorded(sessionId)).toEqual([]);
  });

  it('delete between record and PTY start: the post-spawn re-check sees it gone, so the session is killed', async () => {
    const { credential } = await newAnthropicKey(A);
    const sessionId = await sessionForTB();
    const r = await resolve(claims(A), sessionId, launch({
      credentialSources: { anthropic: 'space' },
      spaceCredentialIds: { anthropic: credential.id },
    }));
    await recordManifest(claims(A), sessionId, r.launch);
    // Control: before the delete the re-check passes.
    expect(await port.activeIds(claims(A), r.spaceCredentialIds)).toEqual(new Set([credential.id]));
    const revoked = await store.revoke(claims(A), credential.id);
    expect(revoked.revoked).toBe(true);
    // The re-check SpawnService runs after spawnIfAbsent (M7).
    expect(await port.activeIds(claims(A), r.spaceCredentialIds)).toEqual(new Set());
  });
});

describe('C3 — resume authorises the resumer, then re-points the launcher to them', () => {
  async function launchedByA(): Promise<{ sessionId: string; l: ResolvedLaunchConfig }> {
    const sessionId = await sessionForTB();
    const l = (await resolve(claims(A), sessionId, launch({ credentialSources: { anthropic: 'space' } }))).launch;
    await recordManifest(claims(A), sessionId, l);
    await setSessionStatus(sessionId, 'exited');
    return { sessionId, l };
  }

  it('t2-11: A spawns on a space credential, B resumes; B passes the gate and the recorded launcher becomes B', async () => {
    const { sessionId, l } = await launchedByA();
    expect((await recorded(sessionId))[0]?.launcher_account_id).toBe(accounts[A]);
    const resumed = await resolve(claims(B), sessionId, launch({}, postureOf(l)), { resume: true });
    expect(resumed.launch.spaceCredentialIds).toEqual({ anthropic: ids.DEFAULT });
    const repoint = await port.repointSession(claims(B), sessionId);
    expect(repoint).toEqual({ ok: true, credentials: [{ provider: 'anthropic', spaceCredentialId: ids.DEFAULT }] });
    expect(await recorded(sessionId)).toEqual([
      { provider: 'anthropic', space_credential_id: ids.DEFAULT, launcher_account_id: accounts[B] },
    ]);
  });

  it('t2-2: a non-member resumer is refused by the gate — resolution under their claims — and nothing is re-pointed', async () => {
    const { sessionId, l } = await launchedByA();
    const e = await refusal(resolve(claims(OUT), sessionId, launch({}, postureOf(l)), { resume: true }));
    expect(e.code).toBe('forbidden');
    expect(e.message).toContain('you are not a member of this space');
    expect((await recorded(sessionId))[0]?.launcher_account_id).toBe(accounts[A]);
  });

  it('a resume on a deleted credential refuses at the gate, and 206 would refuse the re-point too', async () => {
    const { credential } = await newAnthropicKey(A);
    const sessionId = await sessionForTB();
    const l = (await resolve(claims(A), sessionId, launch({
      credentialSources: { anthropic: 'space' },
      spaceCredentialIds: { anthropic: credential.id },
    }))).launch;
    await recordManifest(claims(A), sessionId, l);
    await setSessionStatus(sessionId, 'exited');
    await store.revoke(claims(A), credential.id);
    const e = await refusal(resolve(claims(B), sessionId, launch({}, postureOf(l)), { resume: true }));
    expect(e.message).toContain('has been deleted');
    expect(await port.repointSession(claims(B), sessionId)).toEqual({ ok: false, reason: 'inactive' });
    expect((await recorded(sessionId))[0]?.launcher_account_id).toBe(accounts[A]);
  });
});

describe('A8 — a manifest re-recorded without a space source', () => {
  it('leaves the ssc row in place; a resume off that manifest never reaches it, and read_for_spawn still fails closed on it', async () => {
    const { credential } = await newAnthropicKey(A);
    const sessionId = await sessionForTB();
    const onSpace = (await resolve(claims(A), sessionId, launch({
      credentialSources: { anthropic: 'space' },
      spaceCredentialIds: { anthropic: credential.id },
    }))).launch;
    await recordManifest(claims(A), sessionId, onSpace);
    const onNode = launch({ credentialSources: { anthropic: 'node' } });
    await recordManifest(claims(A), sessionId, onNode);
    // The row is NOT removed by the re-record — nothing may rely on it going.
    expect((await recorded(sessionId)).map((r) => r.space_credential_id)).toEqual([credential.id]);
    await setSessionStatus(sessionId, 'exited');
    await store.revoke(claims(A), credential.id);
    // Resume resolves off the manifest: no space id, so SpawnService never
    // calls the repoint RPC (it returns before it when there is none).
    const resumed = await resolve(claims(B), sessionId, launch({}, postureOf(onNode)), { resume: true });
    expect(resumed.spaceCredentialIds).toEqual([]);
    expect(resumed.launch.spaceCredentialIds ?? {}).toEqual({});
    // And the leftover row cannot be used: the revoked credential reads as unusable.
    const read = await port.read(claims(A), ids.S!, 'anthropic', credential.id);
    expect(read.ok).toBe(false);
  });
});

describe('D5 policy through the real resolution path (enforced only in TypeScript)', () => {
  const MEMBER_HOME: AgentCredentialHome = { provider: 'anthropic', homeDir: '/m', configDir: '/m/anthropic' };

  it("space policy 'require space' skips A's connected member credential and lands on the space default", async () => {
    await store.setSpacePolicy(claims(ADM), ids.S!, 'anthropic', ['space']);
    const sessionId = await sessionForTB();
    const r = await resolve(claims(A), sessionId, launch(), { memberHome: MEMBER_HOME });
    expect(r.launch.effectiveCredentialSources?.anthropic).toBe('space');
    expect(r.credentialHome?.space?.credentialId).toBe(ids.DEFAULT);
    const e = await refusal(resolve(claims(A), sessionId, launch({ credentialSources: { anthropic: 'member' } }), { memberHome: MEMBER_HOME }));
    expect(e.message).toBe("credentialSources.anthropic 'member' is not allowed: a space admin allows only 'space' for anthropic in this space");
  });

  it("node policy 'forbid node' refuses an explicit node source, and auto with no member or space source", async () => {
    await store.setNodePolicy(claims(OWN), 'anthropic', false);
    const sessionId = await sessionForTB();
    const e = await refusal(resolve(claims(A), sessionId, launch({ credentialSources: { anthropic: 'node' } })));
    expect(e.message).toContain('the node admin has forbidden node anthropic credentials on this node');
    await store.setSpacePolicy(claims(ADM), ids.S!, 'anthropic', ['member', 'node']);
    const e2 = await refusal(resolve(claims(A), sessionId, launch()));
    expect(e2.message).toContain('no anthropic credential is usable for this launch');
  });
});
