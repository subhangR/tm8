/**
 * 304 (Game v1 P0e) against a real Postgres, through the REAL claim binding
 * (`PgDb.rpc` → BIND_CLAIMS_SQL), because the fix IS a claim.
 *
 * ## The defect this file exists for
 *
 * The tracking jobs run as the node's owner. Every tracking door was filtered
 * to the caller's member spaces, and the owner belongs only to its own spaces,
 * so a pull request linked in any other space was never polled: on prod, six
 * spaces' PRs had `fetched_at` null and read `open` after they merged. The
 * first describe block is that exact shape: a worker identity that is NOT a
 * member of the space whose PR it must poll.
 *
 * ## The boundary the fix must keep (owner rulings, 6 Oct)
 *
 *   * only the in-process jobs' `backgroundJob` claim opens the doors — a node
 *     admin over HTTP (nodeAdmin: true, no backgroundJob) still gets 42501, and
 *     so does a forged job name or a space-pinned session;
 *   * only the tracking doors open — a general entity read does not;
 *   * tracking writes facts only and never moves a task ("no link between PR
 *     and task completion"): the pr_merged gate stays a check on a manual move.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { PgDb } from '../../src/db/client.js';
import type { DbClaims } from '../../src/db/types.js';
import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

interface Fixture {
  workerIdentity: string;
  ownerIdentity: string;
  homeSpace: string;
  space: string;
  workerMember: string;
  ownerMember: string;
  agent: string;
}

let database: W1ScratchDatabase;
let db: PgDb;
let f: Fixture;

const worker = (): DbClaims => ({
  identityId: f.workerIdentity,
  nodeAdmin: true,
  requestId: 'p0e-test-worker',
  backgroundJob: 'tracking.forge-watcher',
});
/** What `http/identity-resolver.ts` builds for the node's owner over HTTP. */
const httpNodeAdmin = (): DbClaims => ({
  identityId: f.workerIdentity,
  nodeAdmin: true,
  requestId: 'p0e-test-http',
  authKind: 'cli',
});
const spaceOwner = (): DbClaims => ({ identityId: f.ownerIdentity, requestId: 'p0e-test-owner', authKind: 'cli' });

async function asOwner<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return (await client.query(sql, params)).rows as T[];
  });
}

let prNumber = 100;

/** A task in `f.space` tracking one fresh PR. Returns both ids. */
async function trackedTask(opts: {
  workStatus?: string;
  gate?: 'none' | 'pr_merged';
} = {}): Promise<{ taskId: string; prId: string; number: number }> {
  prNumber += 1;
  const [ids] = await asOwner<{ taskId: string; prId: string }>(
    `select internal.new_id()::text "taskId", internal.new_id()::text "prId"`);
  const { taskId, prId } = ids!;
  await asOwner(
    `insert into public.entities(id,space_id,kind,position,created_by) values
       ($1,$3,'task',10,$4),($2,$3,'pull_request',20,$4)`,
    [taskId, prId, f.space, f.ownerMember]);
  await asOwner(
    `insert into public.tasks(entity_id,title,work_status,priority) values($1,'P0e task','open','medium')`,
    [taskId]);
  await asOwner(
    `insert into public.pull_requests(entity_id,space_id,url,repo,number)
     values($1,$2,'https://github.com/acme/forge/pull/'||$3::text,'acme/forge',$3::int)`,
    [prId, f.space, prNumber]);
  // The agent linked it, as `tm8 task link-pr` records.
  await asOwner(
    `insert into public.edges(space_id,src_id,dst_id,type,created_by) values($1,$2,$3,'tracks',$4)`,
    [f.space, taskId, prId, f.agent]);
  if (opts.gate) await asOwner(`update public.tasks set completion_gate=$2 where entity_id=$1`, [taskId, opts.gate]);
  if (opts.workStatus) await asOwner(`update public.tasks set work_status=$2 where entity_id=$1`, [taskId, opts.workStatus]);
  return { taskId, prId, number: prNumber };
}

async function taskState(taskId: string): Promise<{ work_status: string; category: string | null }> {
  const [row] = await asOwner<{ work_status: string; category: string | null }>(
    `select t.work_status, e.status_category category
       from public.tasks t join public.entities e on e.id=t.entity_id where t.entity_id=$1`, [taskId]);
  return row!;
}

async function applyFacts(claims: DbClaims, prId: string, state: string | null, ci: string | null): Promise<void> {
  await db.rpc(claims, 'public.apply_pull_request_facts', [prId, null, state, null, ci, null, null, null]);
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('p0e_tracking');
  database.apply(migrationFiles());
  const [ids] = await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return (await client.query<Fixture>(
      `select 'p0e-worker'::text "workerIdentity", 'p0e-owner'::text "ownerIdentity",
              internal.new_id()::text "homeSpace", internal.new_id()::text "space",
              internal.new_id()::text "workerMember", internal.new_id()::text "ownerMember",
              internal.new_id()::text "agent"`)).rows;
  });
  f = ids!;
  await asOwner(
    `insert into public.user_profiles(identity_id,display_name) values($1,'Node owner'),($2,'Space owner')`,
    [f.workerIdentity, f.ownerIdentity]);
  await asOwner(
    `insert into public.spaces(id,name,created_by_identity) values($1,'Node home',$3),($2,'Other space',$4)`,
    [f.homeSpace, f.space, f.workerIdentity, f.ownerIdentity]);
  await asOwner(
    `insert into public.entities(id,space_id,kind,position,created_by) values
       ($1,$4,'member',0,$1),($2,$5,'member',0,$2),($3,$5,'team_member',1,$2)`,
    [f.workerMember, f.ownerMember, f.agent, f.homeSpace, f.space]);
  // The worker identity is a member of its HOME space only — the prod shape.
  await asOwner(
    `insert into public.members(entity_id,space_id,identity_id,role,display_name) values
       ($1,$3,$5,'owner','Node owner'),($2,$4,$6,'owner','Space owner')`,
    [f.workerMember, f.ownerMember, f.homeSpace, f.space, f.workerIdentity, f.ownerIdentity]);
  await asOwner(
    `insert into public.team_members(entity_id,owner_member_id,name,role,identity)
     values($1,$2,'Agent','worker','test agent')`, [f.agent, f.ownerMember]);
  db = new PgDb({ databaseUrl: database.url, max: 4 });
});

afterAll(async () => {
  await db?.end();
  await database?.destroy();
});

describe('304 §1: the tracking worker reaches every space, and nothing else does', () => {
  it('lists, applies and records a PR in a space the worker identity is not a member of', async () => {
    const { prId } = await trackedTask({ workStatus: 'working' });

    const listed = await db.rpc<{ targets: Array<{ prEntityId: string; spaceId: string }> }>(
      worker(), 'public.observer_watch_targets', [100, 0]);
    expect(listed.targets.map((t) => t.prEntityId)).toContain(prId);

    await db.rpc(worker(), 'public.record_tracking_poll', [prId, null]);
    await applyFacts(worker(), prId, 'merged', null);
    const [row] = await asOwner<{ state: string; last_polled_at: Date | null }>(
      `select state, last_polled_at from public.pull_requests where entity_id=$1`, [prId]);
    expect(row!.state).toBe('merged');
    expect(row!.last_polled_at).not.toBeNull();
  });

  it('claims the space\'s queued `tm8 tracking refresh` request, which nothing could before', async () => {
    const { prId } = await trackedTask();
    await db.rpc(spaceOwner(), 'public.queue_tracking_refresh', [[prId], null, null]);
    const claimed = await db.rpc<{ claimed: Array<{ requestId: string; spaceId: string; targets: Array<{ entityId: string }> }> }>(
      { ...worker(), backgroundJob: 'tracking.observer' }, 'public.claim_tracking_refresh', [10, 600, 5]);
    const mine = claimed.claimed.find((r) => r.spaceId === f.space);
    expect(mine?.targets.map((t) => t.entityId)).toEqual([prId]);
    await db.rpc({ ...worker(), backgroundJob: 'tracking.observer' }, 'public.complete_tracking_refresh',
      [mine!.requestId, null, 'completed']);
  });

  it('a node admin over HTTP still gets 42501 on another space\'s tracking rows', async () => {
    const { prId } = await trackedTask({ workStatus: 'working' });
    await expect(applyFacts(httpNodeAdmin(), prId, 'merged', null)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(db.rpc(httpNodeAdmin(), 'public.record_tracking_poll', [prId, null]))
      .rejects.toMatchObject({ code: 'forbidden' });
    await expect(db.rpc(httpNodeAdmin(), 'public.provider_etag_lookup', [f.space, ['k']]))
      .rejects.toMatchObject({ code: 'forbidden' });
    const listed = await db.rpc<{ targets: Array<{ prEntityId: string }> }>(
      httpNodeAdmin(), 'public.observer_watch_targets', [100, 0]);
    expect(listed.targets.map((t) => t.prEntityId)).not.toContain(prId);
    await expect(db.rpc(httpNodeAdmin(), 'public.read_space_tracking_token', [f.space]))
      .rejects.toMatchObject({ code: 'forbidden' });
  });

  it('a forged job name binds as nothing, and a space-pinned session never binds the claim', async () => {
    const { prId } = await trackedTask({ workStatus: 'working' });
    const forged = { ...httpNodeAdmin(), backgroundJob: 'tracking.anything' } as unknown as DbClaims;
    await expect(applyFacts(forged, prId, 'merged', null)).rejects.toMatchObject({ code: 'forbidden' });
    const pinned: DbClaims = { ...worker(), sessionSpaceId: f.homeSpace };
    await expect(applyFacts(pinned, prId, 'merged', null)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('opens the tracking doors only: a general entity read is still member-scoped', async () => {
    const { taskId } = await trackedTask();
    const seen = await db.tx(worker(), (q) =>
      q.query<{ id: string }>(`select id::text from public.entities where id=$1`, [taskId]));
    expect(seen).toEqual([]);
  });

  it('the token door answers the worker only, and only with the space default token', async () => {
    expect(await db.rpc(worker(), 'public.read_space_tracking_token', [f.space])).toBeNull();
    await expect(db.rpc(spaceOwner(), 'public.read_space_tracking_token', [f.space]))
      .rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('owner ruling: tracking never moves a task', () => {
  it('a merged, green PR leaves its pr_merged-gated in_review task where it is', async () => {
    const { taskId, prId } = await trackedTask({ workStatus: 'in_review', gate: 'pr_merged' });
    await applyFacts(worker(), prId, 'merged', 'passing');
    expect((await taskState(taskId)).work_status).toBe('in_review');
    const edges = await asOwner(`select 1 from public.edges where src_id=$1 and type='completed_by'`, [taskId]);
    expect(edges).toEqual([]);
  });
});

describe('304 §2/§6: freshness is visible', () => {
  it('raises attention on a gated in_review task whose PR has gone stale, and a clean poll clears it', async () => {
    const { taskId, prId } = await trackedTask({ workStatus: 'in_review', gate: 'pr_merged' });
    await asOwner(`update public.pull_requests set created_at=now()-interval '3 hours' where entity_id=$1`, [prId]);

    const swept = await db.rpc<{ raised: number }>(worker(), 'public.tracking_sweep_staleness', [3600]);
    expect(swept.raised).toBeGreaterThanOrEqual(1);
    const key = `tracking_stale:${prId}`;
    const open = await asOwner<{ status: string }>(
      `select status from public.attention_requests where entity_id=$1 and signal_key=$2`, [taskId, key]);
    expect(open.map((r) => r.status)).toEqual(['open']);

    await db.rpc(worker(), 'public.record_tracking_poll', [prId, null]);
    const after = await asOwner<{ status: string }>(
      `select status from public.attention_requests where entity_id=$1 and signal_key=$2`, [taskId, key]);
    expect(after.map((r) => r.status)).toEqual(['cleared']);

    await expect(db.rpc(spaceOwner(), 'public.tracking_sweep_staleness', [3600]))
      .rejects.toMatchObject({ code: 'forbidden' });
  });

  it('tracking_health reports never-polled rows and the missing credential, per space', async () => {
    await trackedTask();
    const health = await db.rpc<{ spaces: Array<Record<string, unknown>> }>(
      spaceOwner(), 'public.tracking_health', [3600]);
    const mine = health.spaces.find((s) => s.spaceId === f.space);
    expect(mine).toMatchObject({ githubCredential: false });
    expect(Number(mine!.neverPolled)).toBeGreaterThan(0);
    // A member sees their own spaces only; the worker sees every space.
    const workerView = await db.rpc<{ spaces: Array<Record<string, unknown>> }>(worker(), 'public.tracking_health', [3600]);
    expect(workerView.spaces.map((s) => s.spaceId)).toContain(f.space);
    const httpView = await db.rpc<{ spaces: Array<Record<string, unknown>> }>(httpNodeAdmin(), 'public.tracking_health', [3600]);
    expect(httpView.spaces.map((s) => s.spaceId)).not.toContain(f.space);
  });

  it('the watch list puts never-polled first and backs a cold, polled row off for an hour', async () => {
    const { prId } = await trackedTask();
    await asOwner(
      `update public.pull_requests set created_at=now()-interval '30 days', last_polled_at=now()-interval '20 minutes'
        where entity_id=$1`, [prId]);
    const listed = await db.rpc<{ targets: Array<{ prEntityId: string; lastPolledAt: string | null }> }>(
      worker(), 'public.observer_watch_targets', [500, 0]);
    expect(listed.targets.map((t) => t.prEntityId)).not.toContain(prId);
    const firstPolled = listed.targets.findIndex((t) => t.lastPolledAt !== null);
    const lastNever = listed.targets.map((t) => t.lastPolledAt).lastIndexOf(null);
    if (firstPolled !== -1) expect(lastNever).toBeLessThan(firstPolled);
  });
});
