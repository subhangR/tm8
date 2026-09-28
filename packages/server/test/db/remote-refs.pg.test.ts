/**
 * W7b — remote_ref, the watcher, spawn in B (migration 274, task 01a0d9fd).
 * The DB half: record_remote_ref's audit requirement, the watcher's
 * signed_in-only polling and the cached-status gate (a1, a4), the spawn
 * budget per token row including the race (a5), the switch (a6), T33's
 * project and parent scope, the link-kind admission at the credential read
 * and the mint (T23 explicit-share half, lead ruling A), the minted child's
 * provenance (ruling B), and the no-token cell. The invoke-level cells are in
 * cross-space-token.pg.test.ts.
 *
 * Fixture, in space-links.pg.test.ts's two-space style: spaces A (home) and
 * B (target). H owns A and B; H3 is a member of both. G is H's agent in A.
 * PB is H's teammate in B.
 *
 * Every refusal is paired with a positive. No token is printed or logged.
 */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createDb } from '../../src/db/client.js';
import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import { claimsFor } from '../../src/facade/context.js';
import { createSessionIdentityResolver, identityFromSession } from '../../src/http/identity-resolver.js';
import { resolveBearerIdentity } from '../../src/identity/pg-auth.js';
import type { RequestContext } from '../../src/http/types.js';
import { formatToken, generateSecret, hashToken } from '../../src/identity/crypto.js';
import type { LoopbackOwner } from '../../src/identity/loopback.js';
import { DbSpaceLinkStore, type SpaceLink } from '../../src/credentials/space-link-store.js';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

interface Fixture {
  spaceA: string; spaceB: string;
  identityH: string; identityH3: string;
  accountH: string; accountH3: string;
  memberHA: string; memberHB: string; memberH3A: string; memberH3B: string;
  personaA: string; workSessionA: string; personaB: string;
  projectA: string; projectB: string; projectShared: string;
}

let database: W1ScratchDatabase;
let db: Db;
let fixture: Fixture;
let store: DbSpaceLinkStore;

const NOT_THE_OWNER: LoopbackOwner = {
  identityId: 'remote-refs-not-the-owner',
  accountId: randomUUID(),
  username: 'nobody',
} as unknown as LoopbackOwner;

function asIdentity<T>(identityId: string, fn: (q: Querier) => Promise<T>, extra: Partial<DbClaims> = {}): Promise<T> {
  return db.tx({ identityId, authKind: 'browser', requestId: `remote-refs-${randomUUID()}`, ...extra } as DbClaims, fn);
}

async function mintBrowser(accountId: string, identityId: string): Promise<string> {
  const secret = generateSecret();
  const row = await asIdentity(identityId, (q) =>
    q.rpc<{ id: string }>('issue_auth_session', [
      accountId, hashToken(secret), 'browser',
      new Date(Date.now() + 3_600_000).toISOString(), null, 'remote-refs browser',
    ]));
  return formatToken(row.id, secret);
}

async function mintAgentG(): Promise<string> {
  const secret = generateSecret();
  const row = await asIdentity(fixture.identityH, (q) =>
    q.rpc<{ id: string }>('issue_agent_auth_session', [
      fixture.workSessionA, fixture.personaA, hashToken(secret),
      new Date(Date.now() + 3_600_000).toISOString(), 'remote-refs agent G',
    ]));
  return formatToken(row.id, secret);
}

async function claimsForToken(token: string): Promise<DbClaims> {
  // A link token is bound in-process, as DbSpaceLinkStore.use and #884's
  // invoke do (256 layer (i) refuses it on every wire).
  const session = await resolveBearerIdentity(db, token);
  const resolve = createSessionIdentityResolver({ db, owner: async () => NOT_THE_OWNER, spaceSessions: 'agents' });
  const identity = String(session.kind) === 'link'
    ? identityFromSession(session, token, 'agents')
    : await resolve({ authorization: `Bearer ${token}` }, { remoteAddress: '203.0.113.9', disableAutoOwner: true });
  const ctx = { identity, requestId: `remote-refs-${randomUUID()}` } as unknown as RequestContext;
  return claimsFor(NOT_THE_OWNER, ctx);
}

async function outcome(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'ok';
  } catch (err) {
    const code = (err as { details?: { sqlstate?: string } }).details?.sqlstate
      ?? (err as { cause?: { code?: string } }).cause?.code
      ?? (err as { code?: string }).code;
    return String(code);
  }
}

async function asOwner<T>(fn: (c: { query: W1ScratchDatabase['query'] }) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn({ query: (async (sql: string, params?: unknown[]) => (await client.query(sql, params)).rows) as W1ScratchDatabase['query'] });
  });
}

/** Ends a session in B the way the execution transition does (R29's single writer). */
async function endSession(workSessionId: string): Promise<void> {
  await asOwner(async (c) => {
    await c.query(`select set_config('tm8.work_session_transition', 'on', true)`);
    await c.query(`update public.work_sessions set status = 'exited' where entity_id = $1`, [workSessionId]);
  });
}

async function seed(): Promise<Fixture> {
  const f: Fixture = {
    spaceA: randomUUID(), spaceB: randomUUID(),
    identityH: `remote-refs-h-${randomUUID()}`, identityH3: `remote-refs-h3-${randomUUID()}`,
    accountH: randomUUID(), accountH3: randomUUID(),
    memberHA: randomUUID(), memberHB: randomUUID(), memberH3A: randomUUID(), memberH3B: randomUUID(),
    personaA: randomUUID(), workSessionA: randomUUID(), personaB: randomUUID(),
    projectA: randomUUID(), projectB: randomUUID(), projectShared: randomUUID(),
  };
  await asOwner(async (c) => {
    await c.query(`insert into public.user_profiles(identity_id, display_name) values ($1, 'H'), ($2, 'H3')`,
      [f.identityH, f.identityH3]);
    await c.query(`insert into public.accounts(id, identity_id, username) values ($1, $2, 'rr-h'), ($3, $4, 'rr-h3')`,
      [f.accountH, f.identityH, f.accountH3, f.identityH3]);
    await c.query(`insert into public.spaces(id, name, created_by_identity) values ($1, 'Refs A', $3), ($2, 'Refs B', $3)`,
      [f.spaceA, f.spaceB, f.identityH]);
    const members: Array<[string, string, string, string, string]> = [
      [f.memberHA, f.spaceA, f.identityH, 'owner', 'H'],
      [f.memberHB, f.spaceB, f.identityH, 'owner', 'H'],
      [f.memberH3A, f.spaceA, f.identityH3, 'member', 'H3'],
      [f.memberH3B, f.spaceB, f.identityH3, 'member', 'H3'],
    ];
    for (const [id, space, identity, role, name] of members) {
      await c.query(`insert into public.entities(id, space_id, kind, created_by, visibility) values ($1, $2, 'member', $1, 'space')`, [id, space]);
      await c.query(`insert into public.members(entity_id, space_id, identity_id, role, display_name) values ($1, $2, $3, $4, $5)`,
        [id, space, identity, role, name]);
    }
    await c.query(
      `insert into public.entities(id, space_id, kind, created_by, visibility)
       values ($1, $3, 'team_member', $4, 'space'), ($2, $3, 'work_session', $1, 'space'),
              ($5, $6, 'team_member', $7, 'space')`,
      [f.personaA, f.workSessionA, f.spaceA, f.memberHA, f.personaB, f.spaceB, f.memberHB]);
    await c.query(
      `insert into public.team_members(entity_id, owner_member_id, name, role, identity)
       values ($1, $2, 'Refs G', 'worker', 'persona'), ($3, $4, 'Refs PB', 'worker', 'persona')`,
      [f.personaA, f.memberHA, f.personaB, f.memberHB]);
    await c.query(
      `insert into public.work_sessions(entity_id, title, status, share_mode, started_at)
       values ($1, 'Refs G run', 'running', 'none', now())`, [f.workSessionA]);
    await c.query(
      `insert into public.edges(space_id, src_id, dst_id, type, created_by) values ($1, $2, $3, 'participates_in', $2)`,
      [f.spaceA, f.personaA, f.workSessionA]);
    await c.query(
      `insert into public.projects(id, name, working_dir, trust)
       values ($1, 'refs-a', $3, 'trusted'), ($2, 'refs-b', $4, 'trusted'), ($5, 'refs-shared', $6, 'trusted')`,
      [f.projectA, f.projectB, `/tmp/refs-a-${f.projectA}`, `/tmp/refs-b-${f.projectB}`,
       f.projectShared, `/tmp/refs-shared-${f.projectShared}`]);
    await c.query(`insert into public.space_projects(space_id, project_id) values ($1, $2), ($3, $4), ($1, $5)`,
      [f.spaceA, f.projectA, f.spaceB, f.projectB, f.projectShared]);
  });
  // A double link from before 234 (W11-migrate has not split it yet): 234's
  // trigger refuses a new one, so the legacy row is seeded with triggers off.
  await database.transaction(async (client) => {
    await client.query(`set local session_replication_role = replica`);
    await client.query(`insert into public.space_projects(space_id, project_id) values ($1, $2)`, [f.spaceB, f.projectShared]);
  });
  return f;
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('remote_refs');
  database.apply(migrationFiles());
  db = createDb(database.url, { max: 8 });
  fixture = await seed();
  const dataDir = await mkdtemp(join(tmpdir(), 'tm8-remote-refs-'));
  store = new DbSpaceLinkStore({ db, dataDir });
}, 180_000);

afterAll(async () => {
  await db?.end();
  await database?.destroy();
}, 180_000);

const hClaims = async (): Promise<DbClaims> => claimsForToken(await mintBrowser(fixture.accountH, fixture.identityH));
const h3Claims = async (): Promise<DbClaims> => claimsForToken(await mintBrowser(fixture.accountH3, fixture.identityH3));
const adminClaims = (): DbClaims =>
  ({ identityId: fixture.identityH, nodeAdmin: true, requestId: `remote-refs-watch-${randomUUID()}` }) as DbClaims;

/** A link A → B for `claims`' member, logged in. One link entity is shared per (A, B). */
async function linkAB(claims: DbClaims): Promise<SpaceLink> {
  const link = await store.add(claims, { spaceId: fixture.spaceA, targetSpaceId: fixture.spaceB });
  return store.login(claims, link.id);
}

/** A task in B, as the graph owner (the create itself is invoke's, tested in the matrix). */
async function taskInB(title: string): Promise<string> {
  const id = randomUUID();
  await asOwner(async (c) => {
    await c.query(`insert into public.entities(id, space_id, kind, created_by, visibility) values ($1, $2, 'task', $3, 'space')`,
      [id, fixture.spaceB, fixture.memberHB]);
    await c.query(`insert into public.tasks(entity_id, title, work_status, priority) values ($1, $2, 'open', 'medium')`, [id, title]);
  });
  return id;
}

async function completeInB(taskId: string): Promise<void> {
  await asOwner(async (c) => {
    await c.query(`update public.tasks set work_status = 'done' where entity_id = $1`, [taskId]);
  });
}

/** The ok audit row invoke writes after a create in B (258's shape). */
async function auditOk(linkId: string, memberId: string, op: string, remoteId: string, result = 'ok'): Promise<void> {
  await asOwner(async (c) => {
    await c.query(
      `insert into public.cross_space_audit(link_id, link_ref, home_space_id, target_space_id, member_id, op, result, remote_id)
       values ($1, $7, $2, $3, $4, $5, $8, $6)`,
      [linkId, fixture.spaceA, fixture.spaceB, memberId, op, remoteId, linkId, result]);
  });
}

async function refRow(refId: string): Promise<{ remote_status_category: string | null; last_seen_seq: string; watched_at: Date | null }> {
  const [row] = await database.query<{ remote_status_category: string | null; last_seen_seq: string; watched_at: Date | null }>(
    `select remote_status_category, last_seen_seq::text, watched_at from public.remote_refs where entity_id = $1`, [refId]);
  if (!row) throw new Error('no remote ref');
  return row;
}

/** A task in A that hard-depends on `refId`. */
async function waiterInA(refId: string): Promise<string> {
  const id = randomUUID();
  await asOwner(async (c) => {
    await c.query(`insert into public.entities(id, space_id, kind, created_by, visibility) values ($1, $2, 'task', $3, 'space')`,
      [id, fixture.spaceA, fixture.memberHA]);
    await c.query(`insert into public.tasks(entity_id, title, work_status, priority) values ($1, 'waits on B', 'open', 'medium')`, [id]);
    await c.query(`insert into public.edges(space_id, src_id, dst_id, type, created_by) values ($1, $2, $3, 'depends_on', $4)`,
      [fixture.spaceA, id, refId, fixture.memberHA]);
  });
  return id;
}

async function readyInA(claims: DbClaims): Promise<string[]> {
  const rows = await db.tx(claims, (q) => q.query<{ entity_id: string }>(
    'select entity_id::text from public.ready_to_work($1)', [fixture.spaceA]));
  return rows.map((r) => r.entity_id);
}

// ---------------------------------------------------------------------------

describe('W7b record_remote_ref — only for work done through the link', () => {
  let link: SpaceLink;
  beforeAll(async () => { link = await linkAB(await hClaims()); });

  it('refused without the ok audit row; a read op\'s audit row is not a create; positive with a create audit row', async () => {
    const claims = await hClaims();
    const taskB = await taskInB('audited');
    expect(await outcome(() => db.rpc(claims, 'record_remote_ref', [fixture.spaceA, link.id, taskB]))).toBe('42501');
    await auditOk(link.id, fixture.memberHA, 'tasks.get', taskB);
    expect(await outcome(() => db.rpc(claims, 'record_remote_ref', [fixture.spaceA, link.id, taskB]))).toBe('42501');
    // A create that failed in B produced nothing to watch.
    await auditOk(link.id, fixture.memberHA, 'tasks.create', taskB, 'error');
    expect(await outcome(() => db.rpc(claims, 'record_remote_ref', [fixture.spaceA, link.id, taskB]))).toBe('42501');
    await auditOk(link.id, fixture.memberHA, 'tasks.create', taskB);
    const made = await db.rpc<{ id: string; created: boolean }>(claims, 'record_remote_ref', [fixture.spaceA, link.id, taskB]);
    expect(made.created).toBe(true);
    // Idempotent per (token row, remote id).
    const again = await db.rpc<{ id: string; created: boolean }>(claims, 'record_remote_ref', [fixture.spaceA, link.id, taskB]);
    expect(again).toMatchObject({ id: made.id, created: false });
    const [ent] = await database.query<{ space_id: string; kind: string }>(
      'select space_id::text, kind from public.entities where id = $1', [made.id]);
    expect(ent).toEqual({ space_id: fixture.spaceA, kind: 'remote_ref' });
    expect((await refRow(made.id)).remote_status_category).toBe('to_do');
  });

  it('another member\'s audit row does not let H3 record it; H3\'s own row does', async () => {
    const h3 = await h3Claims();
    await linkAB(h3);
    const taskB = await taskInB('h3 audited');
    await auditOk(link.id, fixture.memberHA, 'tasks.create', taskB);
    expect(await outcome(() => db.rpc(h3, 'record_remote_ref', [fixture.spaceA, link.id, taskB]))).toBe('42501');
    await auditOk(link.id, fixture.memberH3A, 'tasks.create', taskB);
    expect(await outcome(() => db.rpc(h3, 'record_remote_ref', [fixture.spaceA, link.id, taskB]))).toBe('ok');
  });

  it('lifecycle is command-owned: the generic delete of a remote_ref is 42501 and leaves it live; positive — the same door deletes a task in A', async () => {
    const claims = await hClaims();
    const taskB = await taskInB('undeletable ref');
    await auditOk(link.id, fixture.memberHA, 'tasks.create', taskB);
    const ref = await db.rpc<{ id: string }>(claims, 'record_remote_ref', [fixture.spaceA, link.id, taskB]);
    expect(await outcome(() => db.rpc(claims, 'delete_entity', [ref.id, null, null]))).toBe('42501');
    const [live] = await database.query<{ deleted: boolean }>('select deleted_at is not null as deleted from public.entities where id = $1', [ref.id]);
    expect(live).toEqual({ deleted: false });
    const taskA = randomUUID();
    await asOwner(async (c) => {
      await c.query(`insert into public.entities(id, space_id, kind, created_by, visibility) values ($1, $2, 'task', $3, 'space')`,
        [taskA, fixture.spaceA, fixture.memberHA]);
      await c.query(`insert into public.tasks(entity_id, title, work_status, priority) values ($1, 'deletable', 'open', 'medium')`, [taskA]);
    });
    expect(await outcome(() => db.rpc(claims, 'delete_entity', [taskA, null, null]))).toBe('ok');
  });

  it('loop guard: the link session itself is refused; H\'s agent G in A is admitted', async () => {
    const taskB = await taskInB('guarded');
    await auditOk(link.id, fixture.memberHA, 'tasks.create', taskB);
    const use = await store.use(await hClaims(), link.id);
    expect(await outcome(async () => db.rpc(await claimsForToken(use.token), 'record_remote_ref',
      [fixture.spaceA, link.id, taskB]))).toBe('42501');
    expect(await outcome(async () => db.rpc(await claimsForToken(await mintAgentG()), 'record_remote_ref',
      [fixture.spaceA, link.id, taskB]))).toBe('ok');
  });
});

describe('W7b watcher — a1 opens the gate, a4 stops when the link leaves signed_in', () => {
  let link: SpaceLink;
  beforeAll(async () => { link = await linkAB(await hClaims()); });

  async function refTo(title: string): Promise<{ taskB: string; refId: string }> {
    const taskB = await taskInB(title);
    await auditOk(link.id, fixture.memberHA, 'tasks.create', taskB);
    const made = await db.rpc<{ id: string }>(await hClaims(), 'record_remote_ref', [fixture.spaceA, link.id, taskB]);
    return { taskB, refId: made.id };
  }

  it('the watcher door is node-admin only (paired: node admin polls)', async () => {
    expect(await outcome(async () => db.rpc(await hClaims(), 'poll_remote_refs', [50]))).toBe('42501');
    expect(await outcome(() => db.rpc(adminClaims(), 'poll_remote_refs', [50]))).toBe('ok');
  });

  it('a1: a task in A gated on a B task opens when B completes it', async () => {
    const { taskB, refId } = await refTo('a1');
    const waiter = await waiterInA(refId);
    const h = await hClaims();
    expect(await readyInA(h)).not.toContain(waiter);

    await completeInB(taskB);
    const [b] = await database.query<{ status_category: string }>(
      'select status_category from public.entities where id = $1', [taskB]);
    expect(b?.status_category).toBe('done');
    // Not yet polled: the gate reads the cache, which still says to_do.
    expect(await readyInA(h)).not.toContain(waiter);

    await db.rpc(adminClaims(), 'poll_remote_refs', [1000]);
    expect((await refRow(refId)).remote_status_category).toBe('done');
    expect(await readyInA(h)).toContain(waiter);
    // Announced like any resolution (003's unblocked activity).
    const [act] = await database.query<{ n: number }>(
      `select count(*)::int n from public.activity where entity_id = $1 and verb = 'unblocked'`, [waiter]);
    expect(act?.n).toBe(1);
  });

  it('the gate is the cache: moving the ref\'s own status by hand does not open it', async () => {
    const { refId } = await refTo('hand-moved');
    const waiter = await waiterInA(refId);
    await asOwner(async (c) => {
      await c.query(
        `update public.entities set status_id = internal.find_workflow_state_for_category(
           internal.workflow_for_entity(space_id, kind, null), 'done') where id = $1`, [refId]);
    });
    const [env] = await database.query<{ status_category: string }>(
      'select status_category from public.entities where id = $1', [refId]);
    expect(env?.status_category).toBe('done');
    expect(await readyInA(await hClaims())).not.toContain(waiter);
  });

  it('writes as the system actor: the version the watcher makes names no claim holder', async () => {
    const { taskB, refId } = await refTo('actor');
    await completeInB(taskB);
    await db.rpc(adminClaims(), 'poll_remote_refs', [1000]);
    const rows = await database.query<{ changed_by: string | null }>(
      `select changed_by::text from public.entity_versions where entity_id = $1 order by version desc limit 1`, [refId]);
    // snapshot_entity_version falls back to the entity's creator when no actor
    // is bound; it is never the admin whose claims ran the tick.
    expect(rows[0]?.changed_by).toBe(fixture.memberHA);
    const [ev] = await database.query<{ n: number }>(
      `select count(*)::int n from public.activity a where a.entity_id = $1 and a.actor_id is not null and a.verb <> 'created'`, [refId]);
    expect(ev?.n).toBe(0);
  });

  it('a4: signed out, nothing on the row is read; signed in again, the ref catches up', async () => {
    const h3 = await h3Claims();
    const h3Link = await linkAB(h3);
    const taskB = await taskInB('a4');
    await auditOk(h3Link.id, fixture.memberH3A, 'tasks.create', taskB);
    const { id: refId } = await db.rpc<{ id: string }>(h3, 'record_remote_ref', [fixture.spaceA, h3Link.id, taskB]);
    await store.logout(h3, h3Link.id);
    // Signed out, no new ref either (paired: the same call after relogin, below).
    const later = await taskInB('a4 later');
    await auditOk(h3Link.id, fixture.memberH3A, 'tasks.create', later);
    expect(await outcome(async () => db.rpc(await h3Claims(), 'record_remote_ref', [fixture.spaceA, h3Link.id, later]))).toBe('42501');

    await completeInB(taskB);
    const before = await refRow(refId);
    await db.rpc(adminClaims(), 'poll_remote_refs', [1000]);
    const after = await refRow(refId);
    expect(after).toEqual(before);
    expect(after.remote_status_category).toBe('to_do');

    await store.login(await h3Claims(), h3Link.id, { relogin: true });
    await db.rpc(adminClaims(), 'poll_remote_refs', [1000]);
    expect((await refRow(refId)).remote_status_category).toBe('done');
    expect(await outcome(async () => db.rpc(await h3Claims(), 'record_remote_ref', [fixture.spaceA, h3Link.id, later]))).toBe('ok');
  });

  it('only referenced ids: an unreferenced B event moves no cursor', async () => {
    const { refId } = await refTo('quiet');
    await db.rpc(adminClaims(), 'poll_remote_refs', [1000]);
    const before = await refRow(refId);
    await completeInB(await taskInB('unreferenced'));
    await db.rpc(adminClaims(), 'poll_remote_refs', [1000]);
    expect((await refRow(refId)).last_seen_seq).toBe(before.last_seen_seq);
  });

  it('only the target space: an event in A naming the remote id moves no cursor (paired: B\'s own event does)', async () => {
    const { taskB, refId } = await refTo('other space');
    await db.rpc(adminClaims(), 'poll_remote_refs', [1000]);
    const before = await refRow(refId);
    const foreign = randomUUID();
    await asOwner(async (c) => {
      await c.query(
        `insert into public.workspace_events(id, space_id, seq, event_type, payload)
         values ($1, $2, $3, 'activity.created', jsonb_build_object('entity_id', $4::text))`,
        [foreign, fixture.spaceA, Number(before.last_seen_seq) + 1_000_000, taskB]);
    });
    try {
      await db.rpc(adminClaims(), 'poll_remote_refs', [1000]);
      expect((await refRow(refId)).last_seen_seq).toBe(before.last_seen_seq);
    } finally {
      await asOwner(async (c) => { await c.query('delete from public.workspace_events where id = $1', [foreign]); });
    }
    await completeInB(taskB);
    await db.rpc(adminClaims(), 'poll_remote_refs', [1000]);
    expect(Number((await refRow(refId)).last_seen_seq)).toBeGreaterThan(Number(before.last_seen_seq));
  });
});

describe('W7b spawn budget — a5 per token row, atomic; a6 the switch; T33 scope', () => {
  let link: SpaceLink;
  beforeAll(async () => { link = await linkAB(await hClaims()); });

  const reserve = async (claims: DbClaims, projectId: string | null = null, parent: string | null = null) =>
    db.rpc<{ reservationId: string }>(claims, 'reserve_space_link_spawn', [fixture.spaceA, link.id, projectId, parent]);

  it('a5: the 4th live spawn on a budget-3 row is refused; releasing one admits the next', async () => {
    const h = await hClaims();
    const held: string[] = [];
    for (let i = 0; i < 3; i += 1) held.push((await reserve(h)).reservationId);
    expect(await outcome(() => reserve(h))).toBe('42501');
    expect(await db.rpc<boolean>(h, 'release_space_link_spawn', [fixture.spaceA, link.id, held[0]])).toBe(true);
    const next = await reserve(h);
    expect(await outcome(() => reserve(h))).toBe('42501');
    for (const id of [...held.slice(1), next.reservationId]) {
      await db.rpc(h, 'release_space_link_spawn', [fixture.spaceA, link.id, id]);
    }
  });

  it('an expired unbound reservation is not live (the one named TTL)', async () => {
    const h = await hClaims();
    const ids = [(await reserve(h)).reservationId, (await reserve(h)).reservationId, (await reserve(h)).reservationId];
    expect(await outcome(() => reserve(h))).toBe('42501');
    await asOwner(async (c) => {
      await c.query(`update public.space_link_spawns set reserved_at = now() - internal.space_link_spawn_reservation_ttl() - interval '1 second' where id = $1`, [ids[0]]);
    });
    const fresh = await reserve(h);
    for (const id of [ids[1], ids[2], fresh.reservationId]) await db.rpc(h, 'release_space_link_spawn', [fixture.spaceA, link.id, id]);
    const [ttl] = await database.query<{ ttl: string }>(`select internal.space_link_spawn_reservation_ttl()::text ttl`);
    expect(ttl?.ttl).toBe('00:10:00');
  });

  it('race: 8 concurrent reserves on a fresh budget-3 row admit exactly 3', async () => {
    const h3 = await h3Claims();
    const h3Link = await linkAB(h3);
    const results = await Promise.all(Array.from({ length: 8 }, async () => outcome(async () =>
      db.rpc(await h3Claims(), 'reserve_space_link_spawn', [fixture.spaceA, h3Link.id, null, null]))));
    expect(results.filter((r) => r === 'ok')).toHaveLength(3);
    expect(results.filter((r) => r === '42501')).toHaveLength(5);
    const [n] = await database.query<{ n: number }>(
      `select count(*)::int n from public.space_link_spawns s join public.space_link_tokens t on t.id = s.token_row_id
        where t.link_id = $1 and t.member_id = $2`, [h3Link.id, fixture.memberH3A]);
    expect(n?.n).toBe(3);
  });

  it('a6 (SQL half): defaults admit; setSpawn off refuses; on again admits', async () => {
    const h = await hClaims();
    const first = await reserve(h);
    await db.rpc(h, 'release_space_link_spawn', [fixture.spaceA, link.id, first.reservationId]);
    await store.setSpawn(h, { linkId: link.id, allowSpawn: false });
    expect(await outcome(() => reserve(h))).toBe('42501');
    await store.setSpawn(h, { linkId: link.id, allowSpawn: true });
    const again = await reserve(h);
    await db.rpc(h, 'release_space_link_spawn', [fixture.spaceA, link.id, again.reservationId]);
  });

  it('a signed-out row reserves nothing (paired: signed in)', async () => {
    const h = await hClaims();
    await store.logout(h, link.id);
    expect(await outcome(() => reserve(h))).toBe('42501');
    link = await store.login(await hClaims(), link.id, { relogin: true });
    const ok = await reserve(await hClaims());
    await db.rpc(await hClaims(), 'release_space_link_spawn', [fixture.spaceA, link.id, ok.reservationId]);
  });

  it('T33: A\'s project and a shared one are refused, B\'s is admitted; a parent session in A is refused, one in B is admitted', async () => {
    const h = await hClaims();
    expect(await outcome(() => reserve(h, fixture.projectA))).toBe('42501');
    // A folder granted to neither space.
    expect(await outcome(() => reserve(h, randomUUID()))).toBe('42501');
    const okProject = await reserve(h, fixture.projectB);
    // DEFAULT: a legacy folder granted to both A and B is refused (fail-closed).
    expect(await outcome(() => reserve(h, fixture.projectShared))).toBe('42501');
    expect(await outcome(() => reserve(h, null, fixture.workSessionA))).toBe('42501');
    const parentB = randomUUID();
    await asOwner(async (c) => {
      await c.query(`insert into public.entities(id, space_id, kind, created_by, visibility) values ($1, $2, 'work_session', $3, 'space')`,
        [parentB, fixture.spaceB, fixture.personaB]);
      await c.query(`insert into public.work_sessions(entity_id, title, status, share_mode, started_at) values ($1, 'B parent', 'running', 'none', now())`, [parentB]);
    });
    const okParent = await reserve(h, null, parentB);
    for (const r of [okProject, okParent]) await db.rpc(h, 'release_space_link_spawn', [fixture.spaceA, link.id, r.reservationId]);
  });
});

describe('W7b link-kind admission — the mint and the credential read, only against a reservation', () => {
  let link: SpaceLink;
  let publicCredential: string;
  let privateCredential: string;
  let secondPublic: string;

  const newSessionInB = async (): Promise<string> => {
    const id = randomUUID();
    await asOwner(async (c) => {
      await c.query(`insert into public.entities(id, space_id, kind, created_by, visibility) values ($1, $2, 'work_session', $3, 'space')`,
        [id, fixture.spaceB, fixture.memberHB]);
      await c.query(`insert into public.work_sessions(entity_id, title, status, share_mode, started_at) values ($1, 'spawned in B', 'spawning', 'none', now())`, [id]);
      await c.query(`insert into public.edges(space_id, src_id, dst_id, type, created_by) values ($1, $2, $3, 'relates_to', $4)`,
        [fixture.spaceB, id, fixture.personaB, fixture.memberHB]);
    });
    return id;
  };
  const linkClaims = async (): Promise<DbClaims> => claimsForToken((await store.use(await hClaims(), link.id)).token);
  const mint = async (claims: DbClaims, workSessionId: string): Promise<{ id: string; via_link_id: string | null; token: string }> => {
    const secret = generateSecret();
    const row = await db.rpc<{ id: string; via_link_id: string | null }>(claims, 'issue_work_session_agent_session', [
      workSessionId, fixture.personaB, hashToken(secret), new Date(Date.now() + 3_600_000).toISOString(), 'w7b child',
    ]);
    return { ...row, token: formatToken(row.id, secret) };
  };
  const createCredential = async (label: string): Promise<string> => {
    const id = randomUUID();
    await asIdentity(fixture.identityH, (q) => q.rpc('create_space_credential', [
      id, fixture.spaceB, 'anthropic', 'api_key', label, 'Fk0x', Buffer.alloc(17, 7), Buffer.alloc(12, 3),
    ]));
    return id;
  };

  beforeAll(async () => {
    link = await linkAB(await hClaims());
    publicCredential = await createCredential('w7b space-owned');
    secondPublic = await createCredential('w7b second public');
    privateCredential = await createCredential('w7b private of H');
    await asOwner(async (c) => {
      await c.query(`update public.space_credentials set is_default = false where space_id = $1`, [fixture.spaceB]);
      await c.query(`update public.space_credentials set is_default = true where id = $1`, [publicCredential]);
      await c.query(`update public.space_credentials set owner_account_id = $2 where id = $1`, [privateCredential, fixture.accountH]);
    });
    await asIdentity(fixture.identityH, (q) => q.rpc('set_space_credential_visibility', [privateCredential, 'private']));
  });

  it('mint: refused without a reservation; admitted with one, bound to the session, stamped via_link', async () => {
    const ws = await newSessionInB();
    expect(await outcome(async () => mint(await linkClaims(), ws))).toBe('42501');
    const r = await db.rpc<{ reservationId: string }>(await hClaims(), 'reserve_space_link_spawn', [fixture.spaceA, link.id, null, null]);
    const ws2 = await newSessionInB();
    const child = await mint(await linkClaims(), ws2);
    expect(child.via_link_id).toBe(link.id);
    const [bound] = await database.query<{ work_session_id: string }>(
      'select work_session_id::text from public.space_link_spawns where id = $1', [r.reservationId]);
    expect(bound?.work_session_id).toBe(ws2);
    // A re-mint for the bound session needs no second reservation.
    expect(await outcome(async () => mint(await linkClaims(), ws2))).toBe('ok');
    // ws was created before the reservation: never spent on it (a resume).
    const r2 = await db.rpc<{ reservationId: string }>(await hClaims(), 'reserve_space_link_spawn', [fixture.spaceA, link.id, null, null]);
    expect(await outcome(async () => mint(await linkClaims(), ws))).toBe('42501');
    await db.rpc(await hClaims(), 'release_space_link_spawn', [fixture.spaceA, link.id, r2.reservationId]);
    await endSession(ws2);
  });

  it('ruling B: the minted child is link-bound — it can reserve nothing; H\'s agent G can', async () => {
    const r = await db.rpc<{ reservationId: string }>(await hClaims(), 'reserve_space_link_spawn', [fixture.spaceA, link.id, null, null]);
    const ws = await newSessionInB();
    const child = await mint(await linkClaims(), ws);
    const childClaims = await claimsForToken(child.token);
    expect(await outcome(() => db.rpc(childClaims, 'reserve_space_link_spawn', [fixture.spaceA, link.id, null, null]))).toBe('42501');
    expect(await outcome(() => db.rpc(childClaims, 'record_remote_ref', [fixture.spaceA, link.id, ws]))).toBe('42501');
    const g = await claimsForToken(await mintAgentG());
    const byG = await db.rpc<{ reservationId: string }>(g, 'reserve_space_link_spawn', [fixture.spaceA, link.id, null, null]);
    await db.rpc(g, 'release_space_link_spawn', [fixture.spaceA, link.id, byG.reservationId]);
    void r;
    await endSession(ws);
  });

  it('the mint refuses after the switch goes off, even with a reservation (paired: on)', async () => {
    const h = await hClaims();
    await db.rpc(h, 'reserve_space_link_spawn', [fixture.spaceA, link.id, null, null]);
    const claims = await linkClaims();
    await store.setSpawn(h, { linkId: link.id, allowSpawn: false });
    const ws = await newSessionInB();
    expect(await outcome(() => mint(claims, ws))).toBe('42501');
    await store.setSpawn(h, { linkId: link.id, allowSpawn: true });
    expect(await outcome(() => mint(claims, ws))).toBe('ok');
    await endSession(ws);
  });

  it('a bound session holds its budget slot until it exits', async () => {
    await asOwner(async (c) => { await c.query(`update public.space_link_spawns set released_at = now() where released_at is null`); });
    const reserveOne = async () => db.rpc<{ reservationId: string }>(await hClaims(), 'reserve_space_link_spawn', [fixture.spaceA, link.id, null, null]);
    await reserveOne();
    const ws = await newSessionInB();
    await mint(await linkClaims(), ws);
    await reserveOne();
    await reserveOne();
    // One bound (spawning) + two unbound = 3 of 3.
    expect(await outcome(reserveOne)).toBe('42501');
    await endSession(ws);
    expect(await outcome(reserveOne)).toBe('ok');
    await asOwner(async (c) => { await c.query(`update public.space_link_spawns set released_at = now() where released_at is null`); });
  });

  it('issue_agent_auth_session stays closed to a link session', async () => {
    const secret = generateSecret();
    expect(await outcome(async () => db.rpc(await linkClaims(), 'issue_agent_auth_session', [
      fixture.workSessionA, fixture.personaA, hashToken(secret), new Date(Date.now() + 3_600_000).toISOString(), 'no',
    ]))).toBe('42501');
  });

  it('admit_space_link_spawn: only a link session, only against a live reservation, only B\'s folders (paired positives)', async () => {
    await asOwner(async (c) => { await c.query(`update public.space_link_spawns set released_at = now() where released_at is null`); });
    const admit = async (claims: DbClaims, projectId: string | null = null) =>
      outcome(() => db.rpc(claims, 'admit_space_link_spawn', [fixture.spaceB, projectId, null]));
    expect(await admit(await linkClaims())).toBe('42501');
    const r = await db.rpc<{ reservationId: string }>(await hClaims(), 'reserve_space_link_spawn', [fixture.spaceA, link.id, null, null]);
    expect(await admit(await linkClaims())).toBe('ok');
    expect(await admit(await linkClaims(), fixture.projectB)).toBe('ok');
    expect(await admit(await linkClaims(), fixture.projectShared)).toBe('42501');
    expect(await admit(await linkClaims(), fixture.projectA)).toBe('42501');
    // Not a link session: H's own claims, and the link-bound child (it carries
    // the via_link claim), are refused though the reservation is live.
    expect(await admit(await hClaims())).toBe('42501');
    const ws = await newSessionInB();
    const child = await mint(await linkClaims(), ws);
    const r2 = await db.rpc<{ reservationId: string }>(await hClaims(), 'reserve_space_link_spawn', [fixture.spaceA, link.id, null, null]);
    expect(await admit(await claimsForToken(child.token))).toBe('42501');
    expect(await admit(await linkClaims())).toBe('ok');
    await db.rpc(await hClaims(), 'release_space_link_spawn', [fixture.spaceA, link.id, r2.reservationId]);
    void r;
    await endSession(ws);
    await asOwner(async (c) => { await c.query(`update public.space_link_spawns set released_at = now() where released_at is null`); });
  });

  describe('W9 R-2 — a reserved-spawn session starts nothing; the budget holds across descendants', () => {
    /** sqlstate:reason — the reason proves which guard refused. */
    const verdict = async (run: () => Promise<unknown>): Promise<string> => {
      try {
        await run();
        return 'ok';
      } catch (err) {
        const details = (err as { details?: { sqlstate?: string; reason?: string } }).details;
        return `${details?.sqlstate ?? String((err as { code?: string }).code)}:${details?.reason ?? ''}`;
      }
    };
    const participates = async (ws: string): Promise<void> => {
      await asOwner(async (c) => {
        await c.query(`insert into public.edges(space_id, src_id, dst_id, type, created_by) values ($1, $2, $3, 'participates_in', $4)
                          on conflict (src_id, dst_id, type) do nothing`,
          [fixture.spaceB, fixture.personaB, ws, fixture.memberHB]);
      });
    };
    const agentMint = (claims: DbClaims, ws: string) => db.rpc(claims, 'issue_agent_auth_session', [
      ws, fixture.personaB, hashToken(generateSecret()), new Date(Date.now() + 3_600_000).toISOString(), 'w7b grandchild',
    ]);
    const shell = (claims: DbClaims) => db.rpc(claims, 'start_shell_session', [
      fixture.spaceB, null, 'w7b r-2', null, null, false, 64, null, null,
    ]);
    const releaseAll = () => asOwner(async (c) => {
      await c.query(`update public.space_link_spawns set released_at = now() where released_at is null`);
    });
    const reserve = async () => db.rpc<{ reservationId: string }>(await hClaims(), 'reserve_space_link_spawn', [fixture.spaceA, link.id, null, null]);
    const sessionsFor = async (ws: string): Promise<number> => Number((await database.query<{ n: string }>(
      'select count(*)::text as n from public.auth_sessions where work_session_id = $1', [ws]))[0]?.n);

    it('the child mints no grandchild on either agent mint; the reservation path\'s first spawn mints (paired)', async () => {
      await releaseAll();
      await reserve();
      const ws = await newSessionInB();
      // Paired positive: the link session binding its reservation mints.
      const child = await mint(await linkClaims(), ws);
      expect(child.via_link_id).toBe(link.id);
      const childClaims = await claimsForToken(child.token);
      expect(childClaims).toMatchObject({ authKind: 'agent', viaLinkId: link.id });
      const grandchild = await newSessionInB();
      await participates(grandchild);
      expect(await verdict(() => mint(childClaims, grandchild))).toBe('42501:link_bound_launch');
      expect(await verdict(() => agentMint(childClaims, grandchild))).toBe('42501:link_bound_launch');
      expect(await sessionsFor(grandchild)).toBe(0);
      // Paired: the same two mints for the same session by H's own (unlinked) browser pass.
      expect(await verdict(() => asIdentity(fixture.identityH, (q) => q.rpc('issue_work_session_agent_session', [
        grandchild, fixture.personaB, hashToken(generateSecret()), new Date(Date.now() + 3_600_000).toISOString(), 'h',
      ])))).toBe('ok');
      expect(await verdict(() => asIdentity(fixture.identityH, (q) => q.rpc('issue_agent_auth_session', [
        grandchild, fixture.personaB, hashToken(generateSecret()), new Date(Date.now() + 3_600_000).toISOString(), 'h',
      ])))).toBe('ok');
      await endSession(grandchild);
      await endSession(ws);
      await releaseAll();
    });

    it('the child issues no human session (it is space-pinned); an unpinned browser does (paired)', async () => {
      await reserve();
      const ws = await newSessionInB();
      const childClaims = await claimsForToken((await mint(await linkClaims(), ws)).token);
      const issue = (claims: DbClaims) => db.rpc(claims, 'issue_auth_session', [
        fixture.accountH, hashToken(generateSecret()), 'browser', new Date(Date.now() + 3_600_000).toISOString(), null, 'w7b',
      ]);
      expect(await verdict(() => issue(childClaims))).toMatch(/^42501:/);
      expect(await verdict(() => issue({ identityId: fixture.identityH, authKind: 'browser', requestId: `remote-refs-${randomUUID()}` } as DbClaims))).toBe('ok');
      await endSession(ws);
      await releaseAll();
    });

    it('execution.terminal.start\'s SQL: neither the link session nor the child opens a shell; H in B does (paired)', async () => {
      await reserve();
      const ws = await newSessionInB();
      const childClaims = await claimsForToken((await mint(await linkClaims(), ws)).token);
      expect(await verdict(async () => shell(await linkClaims()))).toBe('42501:link_bound_launch');
      expect(await verdict(() => shell(childClaims))).toBe('42501:link_bound_launch');
      const shells = async () => Number((await database.query<{ n: string }>(
        `select count(*)::text as n from public.work_sessions ws join public.entities e on e.id = ws.entity_id
          where e.space_id = $1 and ws.title = 'w7b r-2'`, [fixture.spaceB]))[0]?.n);
      expect(await shells()).toBe(0);
      expect(await verdict(async () => shell(await hClaims()))).toBe('ok');
      expect(await shells()).toBe(1);
      await endSession(ws);
      await releaseAll();
    });

    it('budget 3 holds across descendants: three children, every grandchild refused, the 4th reserve refused', async () => {
      await releaseAll();
      const children: Array<{ ws: string; claims: DbClaims }> = [];
      for (let i = 0; i < 3; i += 1) {
        await reserve();
        const ws = await newSessionInB();
        children.push({ ws, claims: await claimsForToken((await mint(await linkClaims(), ws)).token) });
      }
      for (const child of children) {
        const grandchild = await newSessionInB();
        expect(await verdict(() => mint(child.claims, grandchild))).toBe('42501:link_bound_launch');
        expect(await sessionsFor(grandchild)).toBe(0);
        await endSession(grandchild);
      }
      expect(await verdict(reserve)).toBe('42501:spawn_budget');
      const [live] = await database.query<{ n: string }>(
        `select count(*)::text as n from public.space_link_spawns where released_at is null and work_session_id is not null`);
      expect(Number(live?.n)).toBe(3);
      await endSession(children[0]!.ws);
      expect(await verdict(reserve)).toBe('ok');
      for (const child of children) await endSession(child.ws);
      await releaseAll();
    });
  });

  it('credential read: refused without a reservation; the default public one with it', async () => {
    await asOwner(async (c) => { await c.query(`update public.space_link_spawns set released_at = now() where released_at is null`); });
    expect(await outcome(async () => db.rpc(await linkClaims(), 'read_space_credential_for_spawn',
      [fixture.spaceB, 'anthropic', null]))).toBe('42501');
    const r = await db.rpc<{ reservationId: string }>(await hClaims(), 'reserve_space_link_spawn', [fixture.spaceA, link.id, null, null]);
    const got = await db.rpc<{ credentialId: string }>(await linkClaims(), 'read_space_credential_for_spawn',
      [fixture.spaceB, 'anthropic', null]);
    expect(got.credentialId).toBe(publicCredential);
    await db.rpc(await hClaims(), 'release_space_link_spawn', [fixture.spaceA, link.id, r.reservationId]);
  });

  it('T23 explicit-share half + ruling A: a pinned private or pinned public credential is refused; the default is admitted', async () => {
    const r = await db.rpc<{ reservationId: string }>(await hClaims(), 'reserve_space_link_spawn', [fixture.spaceA, link.id, null, null]);
    const claims = await linkClaims();
    expect(await outcome(() => db.rpc(claims, 'read_space_credential_for_spawn', [fixture.spaceB, 'anthropic', privateCredential]))).toBe('42501');
    expect(await outcome(() => db.rpc(claims, 'read_space_credential_for_spawn', [fixture.spaceB, 'anthropic', secondPublic]))).toBe('42501');
    expect(await outcome(() => db.rpc(claims, 'read_space_credential_for_spawn', [fixture.spaceB, 'anthropic', null]))).toBe('ok');
    // H's own browser session may use its own private one: the refusal is the link's.
    expect(await outcome(async () => db.rpc(await hClaims(), 'read_space_credential_for_spawn', [fixture.spaceB, 'anthropic', privateCredential]))).toBe('ok');
    await db.rpc(await hClaims(), 'release_space_link_spawn', [fixture.spaceA, link.id, r.reservationId]);
  });

  it('gate 8 holds through the link branch: a server-only (typesafe) provider is refused to a link session holding a live reservation, default or pinned; positive — the same reservation reads the anthropic default', async () => {
    const typesafe = randomUUID();
    await asIdentity(fixture.identityH, (q) => q.rpc('create_space_credential', [
      typesafe, fixture.spaceB, 'typesafe', 'api_key', 'w7b typesafe', 'Tk0x', Buffer.alloc(17, 9), Buffer.alloc(12, 4),
    ]));
    await asOwner(async (c) => { await c.query(`update public.space_credentials set is_default = true where id = $1`, [typesafe]); });
    const r = await db.rpc<{ reservationId: string }>(await hClaims(), 'reserve_space_link_spawn', [fixture.spaceA, link.id, null, null]);
    const claims = await linkClaims();
    await expect(db.rpc(claims, 'read_space_credential_for_spawn', [fixture.spaceB, 'typesafe', null])).rejects.toThrow(/server-only/);
    expect(await outcome(() => db.rpc(claims, 'read_space_credential_for_spawn', [fixture.spaceB, 'typesafe', null]))).toBe('42501');
    expect(await outcome(() => db.rpc(claims, 'read_space_credential_for_spawn', [fixture.spaceB, 'typesafe', typesafe]))).toBe('42501');
    const got = await db.rpc<{ credentialId: string }>(claims, 'read_space_credential_for_spawn', [fixture.spaceB, 'anthropic', null]);
    expect(got.credentialId).toBe(publicCredential);
    await db.rpc(await hClaims(), 'release_space_link_spawn', [fixture.spaceA, link.id, r.reservationId]);
  });
});

describe('W7b no token in entity content, entity_versions, the ledger, audit or the new tables', () => {
  it('the plaintext link tokens appear nowhere the graph keeps', async () => {
    const h = await hClaims();
    const link = await linkAB(h);
    const token = (await store.use(h, link.id)).token;
    const secret = token.slice(token.lastIndexOf('.') + 1);
    expect(secret.length).toBeGreaterThan(16);
    const [hits] = await database.query<{ n: number }>(
      `select (
         (select count(*) from public.entity_versions where strpos(snapshot::text, $1) > 0)
       + (select count(*) from public.command_ledger where strpos(to_jsonb(command_ledger)::text, $1) > 0)
       + (select count(*) from public.cross_space_audit where strpos(to_jsonb(cross_space_audit)::text, $1) > 0)
       + (select count(*) from public.remote_refs where strpos(to_jsonb(remote_refs)::text, $1) > 0)
       + (select count(*) from public.space_link_spawns where strpos(to_jsonb(space_link_spawns)::text, $1) > 0)
       + (select count(*) from public.activity where strpos(summary::text, $1) > 0)
       + (select count(*) from public.workspace_events where strpos(payload::text, $1) > 0)
       + (select count(*) from public.entities e where strpos(coalesce(internal.entity_content(e.id)::text, ''), $1) > 0)
       )::int n`, [secret]);
    expect(hits?.n).toBe(0);
    // Paired positive: the probe finds a value that IS there.
    const [probe] = await database.query<{ n: number }>(
      `select count(*)::int n from public.entity_versions where strpos(snapshot::text, $1) > 0`, [link.id]);
    expect(probe?.n).toBeGreaterThan(0);
  });
});
