/**
 * SC-6 — MEMBER CONTAINMENT against a REAL PostgreSQL with migration 206:
 * `IdentityService.disableAccount` → `SpaceCredentialMemberContainment` → 206's
 * `member_space_credential_sessions`, with rows written by the real
 * `record_session_manifest` and re-pointed by the real
 * `repoint_session_space_credentials`, each under the caller's claims.
 *
 * The PTY host is a fake that answers per session, so the test sees exactly
 * which sessions the containment asked it to kill.
 *
 * Cast (space S): OWN owner (node owner, so node admin), A and B members, B
 * owns teammate TB. A is also a member of space T. Every session is created by
 * B's teammate TB — never by its launcher — so a lookup that followed
 * `created_by` → `owner_member_id` would name B for sessions A launched (C2).
 * Test names carry the acceptance criterion (t6-N) or review note they evidence.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { CredentialsSpaceListViewSchema } from '@tm8/contract';

import { resetCredentialKeyCache } from '../../src/credentials/credential-key.js';
import {
  accountDisableContainment,
  SpaceCredentialMemberContainment,
  type MemberContainmentResult,
} from '../../src/credentials/space-credential-containment.js';
import { DbSpaceCredentialStore, type SpaceCredentialProvider } from '../../src/credentials/space-credential-store.js';
import { createDb } from '../../src/db/index.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import { SpaceCredentialCatalogService } from '../../src/facade/services/w2/space-credential-catalog.js';
import { IdentityServiceImpl, type IdentityRepository } from '../../src/identity/index.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 300_000 });

const OWN = 'sc6-owner';
const A = 'sc6-a';
const B = 'sc6-b';

let database: W1ScratchDatabase;
let db: Db;
let dataDir: string;
let store: DbSpaceCredentialStore;
const ids: Record<string, string> = {};
const accounts: Record<string, string> = {};
/** Every session a test made live; afterEach ends them so tests stay independent. */
const live: string[] = [];

const claims = (identityId: string, authKind = 'browser'): DbClaims =>
  ({ identityId, nodeAdmin: false, requestId: randomUUID(), authKind }) as DbClaims;
const agent = (identityId: string): DbClaims => claims(identityId, 'agent');
/** The acting node admin the disable composition binds. */
const nodeAdmin = (): DbClaims => ({ ...claims(OWN), nodeAdmin: true }) as DbClaims;

type Client = import('pg').PoolClient;

async function asOwner<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

const newId = async (c: Client): Promise<string> =>
  (await c.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;

/**
 * A spawning work session created by B's teammate TB (in S) or by A's member
 * row (in T). 206 records a space credential only while spawning; `launchOn`
 * then moves it to running, as the PTY starting would.
 */
async function session(space: 'S' | 'T' = 'S'): Promise<string> {
  const id = await asOwner(async (c) => {
    const sessionId = await newId(c);
    const createdBy = space === 'S' ? ids.TB : ids['member:T:' + A];
    await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'work_session', 0, $3)`, [sessionId, ids[space], createdBy]);
    await c.query(`insert into public.work_sessions(entity_id, title, status, session_kind, workdir_mode) values ($1, 'fixture', 'spawning', 'agent', 'scratch')`, [sessionId]);
    return sessionId;
  });
  live.push(id);
  return id;
}

async function setSessionStatus(sessionId: string, status: string): Promise<void> {
  await asOwner(async (c) => {
    await c.query(`select set_config('tm8.work_session_transition', 'on', true)`);
    await c.query('update public.work_sessions set status = $2 where entity_id = $1', [sessionId, status]);
  });
}

/** What SpawnService hands record_session_manifest, reduced to what 206 reads. */
async function launchOn(who: DbClaims, sessionId: string, spaceCredentialIds: Partial<Record<SpaceCredentialProvider, string>>): Promise<void> {
  const credentialSources = Object.fromEntries(Object.keys(spaceCredentialIds).map((p) => [p, 'space']));
  await db.rpc(who, 'record_session_manifest', [sessionId, JSON.stringify({
    launch: { credentialSources, spaceCredentialIds, effectiveCredentialSources: credentialSources },
  })]);
  await setSessionStatus(sessionId, 'running');
}

/** A session on member credentials: a manifest, and no session_space_credentials row. */
async function launchOnMember(who: DbClaims, sessionId: string): Promise<void> {
  await db.rpc(who, 'record_session_manifest', [sessionId, JSON.stringify({
    launch: { credentialSources: { anthropic: 'member' }, spaceCredentialIds: {}, effectiveCredentialSources: { anthropic: 'member' } },
  })]);
  await setSessionStatus(sessionId, 'running');
}

async function launcherOf(sessionId: string): Promise<string[]> {
  return asOwner(async (c) => (await c.query<{ launcher_account_id: string }>(
    'select launcher_account_id::text from public.session_space_credentials where work_session_id = $1 order by provider',
    [sessionId],
  )).rows.map((r) => r.launcher_account_id));
}

async function anthropicKey(space: 'S' | 'T', who = A): Promise<{ id: string; secret: string }> {
  const secret = `sk-ant-api03-${randomUUID().replaceAll('-', '')}`;
  const credential = await store.create(claims(who), { spaceId: ids[space]!, provider: 'anthropic', shape: 'api_key', label: `k ${randomUUID()}`, secret });
  return { id: credential.id, secret };
}

/**
 * The PTY host: every session answers 'killed' unless told otherwise. Records
 * each terminate, so "killed once" and "never asked" are both visible.
 */
function fakeTerminals(answers: Record<string, 'killed' | 'not_found' | 'error'> = {}) {
  const asked: string[] = [];
  return {
    asked,
    // The containment port (`SpawnService.containCredentialSession`); the real
    // kill-and-record is proven in credential-containment-ending.pg.test.ts.
    async containCredentialSession(sessionId: string) {
      asked.push(sessionId);
      const outcome = answers[sessionId] ?? 'killed';
      return { outcome, recorded: outcome === 'killed' };
    },
  };
}

/**
 * The production shape: IdentityServiceImpl.disableAccount over the REAL
 * set_account_disabled under the node admin's claims, and the containment
 * wired through `accountDisableContainment`. The repository is the two calls
 * disable makes; the auth-session revoke is a no-op stub here (the
 * identity suite pins its order).
 */
function disableService(terminals: ReturnType<typeof fakeTerminals>) {
  const results: MemberContainmentResult[] = [];
  const containment = accountDisableContainment(
    new SpaceCredentialMemberContainment({ store, agentSessions: terminals }),
    nodeAdmin,
  );
  const repository = {
    async setAccountDisabled(accountId: string, disabled: boolean) {
      await db.rpc(nodeAdmin(), 'set_account_disabled', [accountId, disabled]);
      return { id: accountId, status: disabled ? 'disabled' : 'active' };
    },
    async revokeAccountSessions() {
      return 0;
    },
  } as unknown as IdentityRepository;
  const service = new IdentityServiceImpl({
    repository,
    spaceCredentialContainment: {
      async killSessionsLaunchedBy(accountId) {
        const result = await containment.killSessionsLaunchedBy(accountId);
        results.push(result);
        return result;
      },
    },
  });
  return {
    results,
    async disable(identity: string): Promise<MemberContainmentResult> {
      await service.disableAccount(accounts[identity]!);
      return results.at(-1)!;
    },
  };
}

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'tm8-sc6-containment-'));
  resetCredentialKeyCache();
  database = await createW1ScratchDatabase('space_credential_member_containment');
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
    ids.T = await newId(c);
    await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'S', $3), ($2, 'T', $3)`, [ids.S, ids.T, OWN]);
    const memberships: Array<['S' | 'T', string, string]> = [
      ['S', OWN, 'owner'], ['S', A, 'member'], ['S', B, 'member'],
      ['T', OWN, 'owner'], ['T', A, 'member'],
    ];
    for (const [space, identity, role] of memberships) {
      const member = ids[`member:${space}:${identity}`] = await newId(c);
      await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'member', 0, $1)`, [member, ids[space]]);
      await c.query(
        `insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, $4, $3)`,
        [member, ids[space], identity, role],
      );
    }
    ids.TB = await newId(c);
    await c.query(`insert into public.entities(id, space_id, kind, position, created_by) values ($1, $2, 'member', 0, $3)`, [
      ids.TB, ids.S, ids['member:S:' + B],
    ]);
  });
  ids.KEY_S = (await anthropicKey('S', B)).id;
}, 300_000);

afterEach(async () => {
  for (const identity of [A, B]) await db.rpc(nodeAdmin(), 'set_account_disabled', [accounts[identity], false]);
  for (const id of live.splice(0)) await setSessionStatus(id, 'exited');
});

afterAll(async () => {
  await db?.end();
  await database?.destroy();
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  resetCredentialKeyCache();
});

describe('t6-3 / t6-4 — disabling an account kills what it launched on space credentials, and nothing else', () => {
  it('kills its space sessions in every space, its agent-spawned child (A6), and leaves its member-credential session and B’s session alone', async () => {
    const own = await session('S');
    await launchOn(claims(A), own, { anthropic: ids.KEY_S! });
    // A6: an agent A minted spawns a child; the child's launcher is A.
    const child = await session('S');
    await launchOn(agent(A), child, { anthropic: ids.KEY_S! });
    // Another space: account disable is node-wide.
    const inT = await session('T');
    await launchOn(claims(A), inT, { anthropic: (await anthropicKey('T')).id });
    // A's session on member credentials: not a space-credential session.
    const onMember = await session('S');
    await launchOnMember(claims(A), onMember);
    // B's own space session.
    const bs = await session('S');
    await launchOn(claims(B), bs, { anthropic: ids.KEY_S! });
    // A launched it, but it has already ended: not live, not asked.
    const ended = await session('S');
    await launchOn(claims(A), ended, { anthropic: ids.KEY_S! });
    await setSessionStatus(ended, 'exited');

    expect(await launcherOf(child)).toEqual([accounts[A]]);

    const terminals = fakeTerminals();
    const result = await disableService(terminals).disable(A);

    expect(new Set(result.terminatedSessionIds)).toEqual(new Set([own, child, inT]));
    expect(new Set(terminals.asked)).toEqual(new Set([own, child, inT]));
    expect(terminals.asked).not.toContain(onMember);
    expect(terminals.asked).not.toContain(bs);
    expect(terminals.asked).not.toContain(ended);
    expect(result).toMatchObject({ accountId: accounts[A], spaceId: null, notOnThisNodeSessionIds: [], failures: [] });
    // The account really is disabled: the kill ran after the real RPC.
    const [row] = await asOwner(async (c) => (await c.query<{ status: string }>(
      'select status from public.accounts where id = $1', [accounts[A]])).rows);
    expect(row?.status).toBe('disabled');
  });

  it('a session on two space credentials (an anthropic key AND a GitHub token) is one PTY, killed once', async () => {
    const token = await store.create(claims(A), {
      spaceId: ids.S!, provider: 'github', shape: 'token', label: `t ${randomUUID()}`,
      secret: `ghp_${randomUUID().replaceAll('-', '').slice(0, 36)}`, displayLogin: 'space-bot',
    });
    const both = await session('S');
    await launchOn(claims(A), both, { anthropic: ids.KEY_S!, github: token.id });
    expect(await launcherOf(both)).toEqual([accounts[A], accounts[A]]);

    const terminals = fakeTerminals();
    const result = await disableService(terminals).disable(A);
    expect(terminals.asked).toEqual([both]);
    expect(result.terminatedSessionIds).toEqual([both]);
  });

  it('the containment lookup takes one space for the future removal op: only that space', async () => {
    const inS = await session('S');
    await launchOn(claims(A), inS, { anthropic: ids.KEY_S! });
    const inT = await session('T');
    await launchOn(claims(A), inT, { anthropic: (await anthropicKey('T')).id });

    const terminals = fakeTerminals();
    const containment = new SpaceCredentialMemberContainment({ store, agentSessions: terminals });
    // A space admin (here the owner, without the node-admin claim) about their space.
    const result = await containment.killSessionsLaunchedBy(claims(OWN), accounts[A]!, ids.T!);
    expect(result.terminatedSessionIds).toEqual([inT]);
    expect(terminals.asked).toEqual([inT]);
  });
});

describe('t6-5 / C2 / C3 — the launcher is launcher_account_id, as the last resume re-pointed it', () => {
  it("A launches B's teammate: disabling B does not kill it, disabling A does", async () => {
    const s = await session('S');
    await launchOn(claims(A), s, { anthropic: ids.KEY_S! });

    // B owns the persona that created the session. Not B's launch (C2).
    const byB = fakeTerminals();
    expect((await disableService(byB).disable(B)).terminatedSessionIds).not.toContain(s);
    expect(byB.asked).not.toContain(s);

    const byA = fakeTerminals();
    expect((await disableService(byA).disable(A)).terminatedSessionIds).toEqual([s]);
  });

  it('C3: after B resumes it, it is B’s — disabling A leaves it running, disabling B kills it', async () => {
    const s = await session('S');
    await launchOn(claims(A), s, { anthropic: ids.KEY_S! });
    await setSessionStatus(s, 'idle');
    // The resume gate (SC-2): B re-points, then the PTY starts again.
    await store.repointSession(claims(B), s);
    await setSessionStatus(s, 'running');
    expect(await launcherOf(s)).toEqual([accounts[B]]);

    const byA = fakeTerminals();
    const afterA = await disableService(byA).disable(A);
    expect(afterA.terminatedSessionIds).not.toContain(s);
    expect(byA.asked).not.toContain(s);

    const byB = fakeTerminals();
    expect((await disableService(byB).disable(B)).terminatedSessionIds).toEqual([s]);
  });

  it("C3 via an agent: B's agent resumes A's session — the launcher is B, the minting human", async () => {
    const s = await session('S');
    await launchOn(claims(A), s, { anthropic: ids.KEY_S! });
    await setSessionStatus(s, 'idle');
    await store.repointSession(agent(B), s);
    expect(await launcherOf(s)).toEqual([accounts[B]]);

    expect((await disableService(fakeTerminals()).disable(A)).terminatedSessionIds).not.toContain(s);
    expect((await disableService(fakeTerminals()).disable(B)).terminatedSessionIds).toEqual([s]);
  });

  it('S4: a resume that fails AFTER the repoint leaves the launcher on the resumer — disabling the original launcher does not kill it (intended)', async () => {
    const s = await session('S');
    await launchOn(claims(A), s, { anthropic: ids.KEY_S! });
    await setSessionStatus(s, 'idle');
    // B's resume: the repoint commits, then the PTY spawn (or the M7
    // re-check) fails. Nothing rolls the repoint back; the session stays idle.
    await store.repointSession(claims(B), s);
    expect(await launcherOf(s)).toEqual([accounts[B]]);

    const byA = fakeTerminals();
    expect((await disableService(byA).disable(A)).terminatedSessionIds).not.toContain(s);
    expect(byA.asked).not.toContain(s);
    // The resumer is the last account that authorised a PTY on it.
    const byB = fakeTerminals();
    expect((await disableService(byB).disable(B)).terminatedSessionIds).toEqual([s]);
  });
});

describe('#681 C — single node: what the PTY host answers is reported, never rounded up', () => {
  it("'not_found' is NOT counted as terminated; 'error' is a failure; the rest still run", async () => {
    const gone = await session('S');
    await launchOn(claims(A), gone, { anthropic: ids.KEY_S! });
    const stuck = await session('S');
    await launchOn(claims(A), stuck, { anthropic: ids.KEY_S! });
    const fine = await session('S');
    await launchOn(claims(A), fine, { anthropic: ids.KEY_S! });

    const terminals = fakeTerminals({ [gone]: 'not_found', [stuck]: 'error' });
    const result = await disableService(terminals).disable(A);
    expect(new Set(terminals.asked)).toEqual(new Set([gone, stuck, fine]));
    expect(result.terminatedSessionIds).toEqual([fine]);
    expect(result.notOnThisNodeSessionIds).toEqual([gone]);
    expect(result.failures).toEqual([{ sessionId: stuck, reason: 'the PTY host could not kill this agent session' }]);
  });

  it('a lookup the database refuses is a failure in the result, and nothing is killed', async () => {
    const s = await session('S');
    await launchOn(claims(A), s, { anthropic: ids.KEY_S! });
    const terminals = fakeTerminals();
    const containment = new SpaceCredentialMemberContainment({ store, agentSessions: terminals });
    // I2: human-only in SQL — an agent token, even a node admin's, is refused.
    const refused = await containment.killSessionsLaunchedBy({ ...agent(OWN), nodeAdmin: true } as DbClaims, accounts[A]!);
    expect(refused.failures).toHaveLength(1);
    expect(refused.failures[0]!.reason).toMatch(/^lookup_failed: /);
    // A plain member asking about someone else is refused too.
    const notAdmin = await containment.killSessionsLaunchedBy(claims(B), accounts[A]!);
    expect(notAdmin.failures[0]!.reason).toMatch(/^lookup_failed: /);
    expect(terminals.asked).toEqual([]);
  });
});

describe('t6-2 / I5 — the picker reads the GitHub token’s account, never its secret', () => {
  it("list carries the probed login as displayLogin, parses as the contract's view, and holds no secret", async () => {
    const secret = `ghp_${randomUUID().replaceAll('-', '').slice(0, 36)}`;
    const catalog = new SpaceCredentialCatalogService({
      db,
      store,
      probe: async ({ provider }) => ({ ok: true, displayLogin: provider === 'github' ? 'octo-space-bot' : null }),
      terminals: { terminate: () => 'killed', hasLiveTerminal: () => false },
      agentSessions: { containCredentialSession: async () => ({ outcome: 'killed', recorded: true }) },
      env: {},
    });
    const created = await catalog.create(claims(A), ids.S!, { provider: 'github', shape: 'token', label: 'CI bot', secret });
    expect(created.displayLogin).toBe('octo-space-bot');

    const view = await catalog.list(claims(B), ids.S!);
    expect(() => CredentialsSpaceListViewSchema.parse(view)).not.toThrow();
    const row = view.credentials.find((c) => c.id === created.id);
    expect(row).toMatchObject({ provider: 'github', shape: 'token', label: 'CI bot', displayLogin: 'octo-space-bot' });
    expect(JSON.stringify(view)).not.toContain(secret);

    // And the containment result for a session on it names ids only.
    const s = await session('S');
    await launchOn(claims(A), s, { github: created.id });
    const result = await disableService(fakeTerminals()).disable(A);
    expect(result.terminatedSessionIds).toEqual([s]);
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});
