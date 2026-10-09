import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { TaskCancellationObservations } from '../../../contract/src/task-cancellation-observations.js';
import type { Db, DbClaims, Querier } from '../../src/db/types.js';
import type { RequestContext } from '../../src/http/types.js';
import {
  loadTaskCancellationObservations,
  taskCancellationObservations,
} from '../../src/facade/task-cancellation-observations.js';
import { createW1ScratchDatabase, migrationFiles, MIGRATIONS_DIR, REPO_ROOT, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });
const VIEWER = 'cancellation-viewer';
const OTHER = 'cancellation-outsider';
let db: W1ScratchDatabase;
let spaceId: string;
let foreignSpaceId: string;
let memberId: string;
let legacy: string;
let repeated: string;
let reopened: string;
let hidden: string;
let deleted: string;
let foreign: string;
let open: string;
let observed: string;
let writerXid: string;
let writeClock: string;
let regression: { olderStart: string; cancelClock: string; updatedAt: string };
let sawMigrationWaiting = false;
const CI_APPLICATION = `task-cancellation-ci-${process.pid}`;

/** The same per-file psql command used by the CI migration apply loop. */
function ciMigration(file: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env['TM8_PSQL'] ?? 'psql',
      [db.url, '-v', 'ON_ERROR_STOP=1', '-1', '-q', '-f', file],
      { env: { ...process.env, PGAPPNAME: CI_APPLICATION }, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? -1, stderr }));
  });
}

function querier(client: PoolClient): Querier {
  return {
    query: async <R>(sql: string, params: readonly unknown[] = []) =>
      (await client.query(sql, [...params])).rows as R[],
    rpc: async <R>(name: string, params: readonly unknown[] = []) =>
      (await client.query(`select * from public.${name}(${params.map((_, i) => `$${i + 1}`).join(',')})`, [...params])).rows as R,
  };
}

async function owner<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return db.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

async function viewer<T>(claims: DbClaims, fn: (q: Querier) => Promise<T>): Promise<T> {
  return db.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id',$1,true), set_config('tm8.actor_id','',true),
              set_config('tm8.node_admin','false',true), set_config('tm8.session_space_id',$2,true)`,
      [claims.identityId ?? '', claims.sessionSpaceId ?? ''],
    );
    return fn(querier(client));
  });
}

async function newTask(client: PoolClient, targetSpace: string, actor: string, status = 'cancelled', visibility = 'space', suppliedStamp: string | null = null): Promise<string> {
  const id = (await client.query<{ id: string }>('select internal.new_id() id')).rows[0]!.id;
  await client.query(
    `insert into public.entities(id,space_id,kind,position,created_by,visibility) values ($1,$2,'task',0,$3,$4)`,
    [id, targetSpace, actor, visibility],
  );
  const hasClock = (await client.query<{ found: boolean }>(
    `select exists(select 1 from information_schema.columns where table_schema='public'
      and table_name='tasks' and column_name='status_changed_at') found`,
  )).rows[0]!.found;
  if (hasClock) {
    await client.query(`insert into public.tasks(entity_id,title,work_status,status_changed_at)
      values ($1,'Secret task title',$2,$3)`, [id, status, suppliedStamp]);
  } else {
    await client.query(`insert into public.tasks(entity_id,title,work_status) values ($1,'Secret task title',$2)`, [id, status]);
  }
  return id;
}

async function facts(ids: string[], targetSpace = spaceId): Promise<TaskCancellationObservations> {
  return viewer({ identityId: VIEWER }, (q) => loadTaskCancellationObservations(q, targetSpace, ids));
}

function handler() {
  return taskCancellationObservations({
    db: { tx: viewer } as unknown as Db,
    config: {} as never,
    owner: async () => ({ identityId: VIEWER, accountId: 'unused', isNodeAdmin: false }),
  });
}

function ctx(body: unknown, identityId = VIEWER, targetSpace = spaceId): RequestContext {
  return {
    params: { spaceId: targetSpace }, body, query: new URLSearchParams(), requestId: 'cancellation-pg',
    identity: { kind: 'bearer', identityId, nodeAdmin: false },
  } as RequestContext;
}

beforeAll(async () => {
  db = await createW1ScratchDatabase('cancel_observation');
  db.apply(migrationFiles().filter((file) => file < '316_'));
  await owner(async (client) => {
    const ids = (await client.query<{ space: string; foreign_space: string; member: string; foreign_member: string }>(
      'select internal.new_id() space,internal.new_id() foreign_space,internal.new_id() member,internal.new_id() foreign_member',
    )).rows[0]!;
    spaceId = ids.space; foreignSpaceId = ids.foreign_space; memberId = ids.member;
    await client.query(`insert into public.user_profiles(identity_id,display_name) values ($1,'Viewer'),($2,'Other')`, [VIEWER, OTHER]);
    await client.query(`insert into public.spaces(id,name,created_by_identity) values ($1,'Cancel',$3),($2,'Foreign',$3)`, [spaceId, foreignSpaceId, VIEWER]);
    for (const [sid, mid] of [[spaceId, memberId], [foreignSpaceId, ids.foreign_member]]) {
      await client.query(`insert into public.entities(id,space_id,kind,position,created_by) values ($1,$2,'member',0,$1)`, [mid, sid]);
      await client.query(`insert into public.members(entity_id,space_id,identity_id,role,display_name) values ($1,$2,$3,'owner','Viewer')`, [mid, sid, VIEWER]);
    }
    legacy = await newTask(client, spaceId, memberId, 'open');
    repeated = await newTask(client, spaceId, memberId);
    reopened = await newTask(client, spaceId, memberId);
    hidden = await newTask(client, spaceId, memberId, 'cancelled', 'restricted');
    deleted = await newTask(client, spaceId, memberId);
    foreign = await newTask(client, foreignSpaceId, ids.foreign_member);
    open = await newTask(client, spaceId, memberId, 'open');
  });

  // Actual counterexample to deriving cancellation time from generic clocks:
  // an older transaction writes AFTER the later cancellation and regresses now().
  const older = await db.pool.connect();
  try {
    await older.query('begin');
    await older.query('set local role tm8_graph_owner');
    const olderStart = (await older.query<{ stamp: Date }>('select now() stamp')).rows[0]!.stamp.toISOString();
    await db.query('select pg_sleep(0.02)');
    const cancelClock = await owner(async (client) => {
      await client.query(`update public.tasks set work_status='cancelled',updated_at=now() where entity_id=$1`, [legacy]);
      return (await client.query<{ stamp: Date }>('select clock_timestamp() stamp')).rows[0]!.stamp.toISOString();
    });
    await older.query(`update public.tasks set title='older writer committed later',updated_at=now() where entity_id=$1`, [legacy]);
    await older.query('commit');
    const updatedAt = (await db.query<{ stamp: Date }>('select updated_at stamp from public.tasks where entity_id=$1', [legacy]))[0]!.stamp.toISOString();
    regression = { olderStart, cancelClock, updatedAt };
  } finally { await older.query('rollback'); older.release(); }
  db.apply(migrationFiles().filter((file) => file.startsWith('316_')));

  // Start the migration while an older task writer is uncommitted. Observe the
  // lock wait itself; a timer without pg_locks evidence would prove nothing.
  const writer = await db.pool.connect();
  try {
    await writer.query('begin');
    await writer.query('set local role tm8_graph_owner');
    await writer.query(`update public.tasks set title='pending writer' where entity_id=$1`, [legacy]);
    const write = (await writer.query<{ xid: string; stamp: Date }>('select txid_current()::text xid,clock_timestamp() stamp')).rows[0]!;
    writerXid = write.xid; writeClock = write.stamp.toISOString();
    expect(readFileSync(join(REPO_ROOT, 'tools/ci/migrations-check.sh'), 'utf8'))
      .toContain('psql "$SCRATCH_URL" -v ON_ERROR_STOP=1 -1 -q -f "$path"');
    const pending = ciMigration(join(MIGRATIONS_DIR, '317_task_cancellation_observations.sql'));
    // Attach immediately so a migration error cannot become an unhandled rejection.
    const completion = pending.then((result) => ({ result, error: undefined }), (error: unknown) => ({ result: undefined, error }));
    for (let tries = 0; tries < 100; tries += 1) {
      const locks = await db.query<{ waiting: boolean }>(
        `select exists(select 1 from pg_locks l join pg_stat_activity a on a.pid=l.pid
          where a.datname=$1 and a.application_name=$2 and l.relation='public.tasks'::regclass
            and l.mode='ShareRowExclusiveLock' and not l.granted) waiting`, [db.name, CI_APPLICATION],
      );
      if (locks[0]!.waiting) { sawMigrationWaiting = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await writer.query('commit');
    const completed = await completion;
    if (completed.error) throw completed.error;
    if (!completed.result || completed.result.code !== 0) throw new Error(completed.result?.stderr ?? 'psql migration did not complete');
  } finally {
    await writer.query('rollback'); writer.release();
  }
  observed = (await facts([legacy])).facts[0]!.statusChangedNotAfter;
});

afterAll(async () => { if (db) await db.destroy(); });

describe('317 cancellation observation proof on real PostgreSQL', () => {
  it('the CI psql transaction rolls back writes after the 317 task lock when a later statement fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tm8-cancellation-rollback-'));
    const file = join(dir, '001_intentional_failure.sql');
    try {
      const migration = readFileSync(join(MIGRATIONS_DIR, '317_task_cancellation_observations.sql'), 'utf8');
      const lockPrefix = migration.slice(0, migration.indexOf('create table internal.task_cancellation_observations'));
      expect(lockPrefix).toContain('lock table public.tasks in share row exclusive mode;');
      writeFileSync(file, `${lockPrefix}
        create table public.cancellation_rollback_probe(value integer);
        insert into public.cancellation_rollback_probe values(1);
        select 1 / 0;`);
      const result = await ciMigration(file);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('division by zero');
      expect((await db.query<{ table: string | null }>(
        `select to_regclass('public.cancellation_rollback_probe')::text as table`,
      ))[0]!.table).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('reproduces reverse transaction-start ordering and records a separate post-lock bound', async () => {
    expect(regression.updatedAt).toBe(regression.olderStart);
    expect(Date.parse(regression.updatedAt)).toBeLessThan(Date.parse(regression.cancelClock));
    expect(sawMigrationWaiting).toBe(true);
    expect(Date.parse(observed)).toBeGreaterThanOrEqual(Date.parse(writeClock));
    // Private verification cluster enables commit timestamps, so measure the
    // actual writer commit too. CI defaults may leave tracking disabled.
    if ((await db.query<{ enabled: string }>('show track_commit_timestamp'))[0]!.enabled === 'on') {
      const commit = (await db.query<{ stamp: Date }>('select pg_xact_commit_timestamp($1::xid) stamp', [writerXid]))[0]!.stamp;
      expect(Date.parse(observed)).toBeGreaterThanOrEqual(commit.getTime());
    }
    const row = (await db.query<{ exact: Date | null }>('select status_changed_at exact from public.tasks where entity_id=$1', [legacy]))[0]!;
    expect(row.exact).toBeNull();
    expect(Date.parse(observed)).toBeGreaterThan(Date.parse(regression.cancelClock));
  });

  it('preserves the observation on same-value re-cancel and generic edits', async () => {
    const before = await facts([repeated]);
    await owner(async (client) => {
      await client.query(`update public.tasks set work_status='cancelled',title='changed' where entity_id=$1`, [repeated]);
    });
    expect(await facts([repeated])).toEqual(before);
    expect(before.facts).toHaveLength(1);
    expect((await db.query<{ stamp: Date | null }>('select status_changed_at stamp from public.tasks where entity_id=$1', [repeated]))[0]!.stamp).toBeNull();
  });

  it('uses the exact insertion clock for created-cancelled and preserves it on re-cancel', async () => {
    let id = ''; let before = 0; let after = 0;
    await owner(async (client) => {
      // Transaction starts earlier than the INSERT; now() would fail the bound.
      await client.query('select pg_sleep(0.02)');
      before = (await client.query<{ stamp: Date }>('select clock_timestamp() stamp')).rows[0]!.stamp.getTime();
      id = await newTask(client, spaceId, memberId);
      after = (await client.query<{ stamp: Date }>('select clock_timestamp() stamp')).rows[0]!.stamp.getTime();
    });
    const exact = (await db.query<{ stamp: Date }>('select status_changed_at stamp from public.tasks where entity_id=$1', [id]))[0]!.stamp;
    expect(exact.getTime()).toBeGreaterThanOrEqual(before);
    expect(exact.getTime()).toBeLessThanOrEqual(after);
    await owner((client) => client.query(`update public.tasks set work_status='cancelled' where entity_id=$1`, [id]));
    expect((await db.query<{ stamp: Date }>('select status_changed_at stamp from public.tasks where entity_id=$1', [id]))[0]!.stamp).toEqual(exact);
    expect((await facts([id])).facts).toEqual([]);
  });

  it('reopen removes legacy evidence and re-cancel has a later exact timestamp', async () => {
    expect((await facts([reopened])).facts).toHaveLength(1);
    await owner((client) => client.query(`update public.tasks set work_status='open' where entity_id=$1`, [reopened]));
    const initial = (await db.query<{ stamp: Date }>('select status_changed_at stamp from public.tasks where entity_id=$1', [reopened]))[0]!.stamp;
    expect((await facts([reopened])).facts).toEqual([]);
    await owner((client) => client.query(`update public.tasks set work_status='cancelled' where entity_id=$1`, [reopened]));
    const final = (await db.query<{ stamp: Date }>('select status_changed_at stamp from public.tasks where entity_id=$1', [reopened]))[0]!.stamp;
    expect(final.getTime()).toBeGreaterThanOrEqual(initial.getTime());
    expect((await facts([reopened])).facts).toEqual([]);
    // An explicit NULL afterwards cannot revive the earlier legacy bound.
    await owner((client) => client.query('update public.tasks set status_changed_at=null where entity_id=$1', [reopened]));
    expect((await facts([reopened])).facts).toEqual([]);
  });

  it('post-observation cancellations are exact and not captured', async () => {
    await owner((client) => client.query(`update public.tasks set work_status='cancelled' where entity_id=$1`, [open]));
    const stamp = (await db.query<{ stamp: Date }>('select status_changed_at stamp from public.tasks where entity_id=$1', [open]))[0]!.stamp;
    expect(stamp.getTime()).toBeGreaterThanOrEqual(Date.parse(observed));
    expect((await facts([open])).facts).toEqual([]);
  });

  it('guarded later imports preserve NULL and historical exact values without a global bound', async () => {
    let unknown = ''; let historical = '';
    await owner(async (client) => {
      await client.query(`set local tm8.bulk_load='on'`);
      unknown = await newTask(client, spaceId, memberId);
      historical = await newTask(client, spaceId, memberId, 'cancelled', 'space', '2000-01-01T00:00:00Z');
    });
    expect((await db.query<{ stamp: Date | null }>('select status_changed_at stamp from public.tasks where entity_id=$1', [unknown]))[0]!.stamp).toBeNull();
    expect((await facts([unknown, historical])).facts).toEqual([]);
    expect((await db.query<{ stamp: Date }>('select status_changed_at stamp from public.tasks where entity_id=$1', [historical]))[0]!.stamp.toISOString()).toBe('2000-01-01T00:00:00.000Z');
    await owner((client) => client.query(`update public.tasks set work_status='cancelled' where entity_id=$1`, [unknown]));
    expect((await db.query<{ stamp: Date | null }>('select status_changed_at stamp from public.tasks where entity_id=$1', [unknown]))[0]!.stamp).toBeNull();
  });

  it('ignores fabricated INSERT/transition stamps and denies the bulk guard to authenticated application paths', async () => {
    let ordinary = ''; let authenticated = '';
    await owner(async (client) => {
      ordinary = await newTask(client, spaceId, memberId, 'open', 'space', '1900-01-01T00:00:00Z');
      await client.query(`set local tm8.bulk_load='on'`);
      await client.query(`select set_config('tm8.identity_id',$1,true)`, [VIEWER]);
      authenticated = await newTask(client, spaceId, memberId, 'cancelled', 'space', '1900-01-01T00:00:00Z');
    });
    for (const id of [ordinary, authenticated]) {
      const stamp = (await db.query<{ stamp: Date }>('select status_changed_at stamp from public.tasks where entity_id=$1', [id]))[0]!.stamp;
      expect(stamp.getTime()).toBeGreaterThanOrEqual(Date.parse(observed));
    }
    await owner((client) => client.query(`update public.tasks set work_status='cancelled',status_changed_at='1900-01-01T00:00:00Z' where entity_id=$1`, [ordinary]));
    const final = (await db.query<{ stamp: Date }>('select status_changed_at stamp from public.tasks where entity_id=$1', [ordinary]))[0]!.stamp;
    expect(final.getTime()).toBeGreaterThanOrEqual(Date.parse(observed));
  });

  it('an app role without identity cannot use bulk mode through an owner SECURITY DEFINER insert', async () => {
    await owner((client) => client.query(`
      create function internal.test_cancellation_insert()
      returns uuid language plpgsql security definer set search_path=public,internal,pg_temp as $fn$
      declare id uuid := internal.new_id(); begin
        insert into public.entities(id,space_id,kind,position,created_by)
          values(id,'${spaceId}','task',0,'${memberId}');
        insert into public.tasks(entity_id,title,work_status,status_changed_at)
          values(id,'bulk guard probe','cancelled','1900-01-01T00:00:00Z');
        return id;
      end $fn$;
      grant execute on function internal.test_cancellation_insert() to tm8_app;
    `));
    const id = await db.transaction(async (client) => {
      await client.query('set local role tm8_app');
      await client.query(`set local tm8.bulk_load='on'`);
      await client.query(`select set_config('tm8.identity_id','',true)`);
      return (await client.query<{ id: string }>('select internal.test_cancellation_insert() id')).rows[0]!.id;
    });
    const stamp = (await db.query<{ stamp: Date }>('select status_changed_at stamp from public.tasks where entity_id=$1', [id]))[0]!.stamp;
    expect(stamp.getTime()).toBeGreaterThanOrEqual(Date.parse(observed));
    await owner((client) => client.query('drop function internal.test_cancellation_insert()'));
  });

  it('reapplies entity RLS and space scope, and exposes no titles or reasons for missing ids', async () => {
    await owner((client) => client.query('update public.entities set deleted_at=clock_timestamp() where id=$1', [deleted]));
    const response = await facts([legacy, repeated, hidden, deleted, foreign, legacy]);
    expect(response.spaceId).toBe(spaceId);
    expect(response.complete).toBe(true);
    expect(response.facts.map((fact) => fact.taskId).sort()).toEqual([legacy, repeated].sort());
    expect((await facts([foreign], foreignSpaceId)).facts).toHaveLength(1);
    expect(JSON.stringify(response)).not.toContain('Secret');
    expect(await viewer({ identityId: OTHER }, (q) => loadTaskCancellationObservations(q, spaceId, [legacy]))).toMatchObject({ complete: true, facts: [] });
    const directlyReadable = await viewer({ identityId: VIEWER }, (q) => q.query<{ task_id: string }>('select task_id from internal.task_cancellation_observations where task_id=$1', [hidden]));
    expect(directlyReadable).toEqual([]);
    expect((await viewer({ identityId: VIEWER, sessionSpaceId: foreignSpaceId }, (q) => loadTaskCancellationObservations(q, spaceId, [legacy]))).facts).toEqual([]);
  });

  it('route binds the authenticated viewer, rejects outsiders/anonymous/spoofed identities and oversized lists', async () => {
    expect(await handler()(ctx({ taskIds: [legacy] }))).toEqual(await facts([legacy]));
    await expect(handler()(ctx({ taskIds: [legacy] }, OTHER))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(handler()({ ...ctx({ taskIds: [legacy] }), identity: { kind: 'anonymous' } })).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(handler()(ctx({ taskIds: [legacy], viewerIdentityId: VIEWER }, OTHER))).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(handler()(ctx({ taskIds: Array(501).fill(legacy) }))).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(viewer({ identityId: VIEWER }, (q) => loadTaskCancellationObservations(q, spaceId, Array(501).fill(legacy)))).rejects.toMatchObject({ code: 'invalid_input' });
    expect((await handler()(ctx({ taskIds: [] })) as TaskCancellationObservations).facts).toEqual([]);
    expect((await facts(Array(500).fill(legacy))).facts).toHaveLength(1);
  });

  it('app cannot edit observation metadata and deleting a task cascades its fact', async () => {
    await expect(viewer({ identityId: VIEWER }, (q) => q.query('delete from internal.task_cancellation_observations where task_id=$1', [legacy]))).rejects.toMatchObject({ code: '42501' });
    await owner((client) => client.query('delete from public.tasks where entity_id=$1', [deleted]));
    expect(await db.query('select * from internal.task_cancellation_observations where task_id=$1', [deleted])).toEqual([]);
  });
});
