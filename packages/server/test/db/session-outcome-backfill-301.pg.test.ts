/**
 * 301's BACKFILL against a real Postgres (Spec D1 §8, refined in §13.10).
 *
 * The chain is applied up to 300, history is written the way the pre-301
 * product left it — every ending, every tick, every never-ended claim — and
 * then 301 is applied on top. Each `it` reads one rule back:
 *
 *   completed  an ended stop/clean exit whose session posted on its anchor in
 *              its last 30 minutes and whose claimed tasks are all done or in
 *              review; and a LIVE session an operator had ticked to Done
 *   stopped    every other stop/clean exit; any open ending older than 7 days
 *   open       a recent crash (it keeps its needs-attention place)
 *
 * plus: `completed` -> `exited_clean`, containment endings -> credential_revoked,
 * every historical claim ends with `backfill` (at the session's exit, or at the
 * migration), and every session is re-filed by the §3.2 category table.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });

const D1 = '302_session_outcome_and_claims.sql';

let database: W1ScratchDatabase;
const ids: Record<string, string> = {};
let spaceId = '';
let memberId = '';
let teammateId = '';

type Q = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

async function asOwner<T>(fn: (q: Q) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(async (sql, params = []) => (await client.query(sql, params)).rows as Record<string, unknown>[]);
  });
}

/** A pre-301 session row exactly as history left it: status and ending inserted, never transitioned. */
async function historicSession(
  q: Q,
  key: string,
  row: { status: string; endedKind?: string | null; endedReason?: string | null; exitedAgo?: string | null },
): Promise<string> {
  const id = (await q(
    `insert into public.entities(space_id,kind,parent_id,position,created_by,created_at)
     values($1,'work_session',null,0,$2, now() - interval '30 days') returning id`,
    [spaceId, memberId],
  ))[0]!.id as string;
  await q(
    `insert into public.work_sessions(entity_id,title,status,ended_kind,ended_reason,exited_at)
     values($1,$2,$3,$4,$5, case when $6::text is null then null else now() - $6::interval end)`,
    [id, key, row.status, row.endedKind ?? null, row.endedReason ?? null, row.exitedAgo ?? null],
  );
  await q(`insert into public.edges(space_id,src_id,dst_id,type,created_by) values($1,$2,$3,'relates_to',$4)`, [
    spaceId, id, teammateId, memberId,
  ]);
  ids[key] = id;
  return id;
}

async function task(q: Q, key: string, workStatus: string): Promise<string> {
  const id = (await q(
    `insert into public.entities(space_id,kind,parent_id,position,created_by) values($1,'task',null,0,$2) returning id`,
    [spaceId, memberId],
  ))[0]!.id as string;
  await q(`insert into public.tasks(entity_id,title,work_status) values($1,$2,$3)`, [id, key, workStatus]);
  ids[key] = id;
  return id;
}

async function claim(q: Q, session: string, taskId: string): Promise<void> {
  await q(
    `insert into public.edges(space_id,src_id,dst_id,type,props,created_by)
     values($1,$2,$3,'working_on','{"status":"working"}'::jsonb,$4)`,
    [spaceId, session, taskId, memberId],
  );
}

async function message(q: Q, anchor: string, ago: string): Promise<void> {
  const id = (await q(
    `insert into public.entities(space_id,kind,parent_id,position,created_by) values($1,'message',null,0,$2) returning id`,
    [spaceId, teammateId],
  ))[0]!.id as string;
  await q(
    `insert into public.messages(entity_id,anchor_id,author_id,body,created_at) values($1,$2,$3,'Close-out.', now() - $4::interval)`,
    [id, anchor, teammateId, ago],
  );
}

interface After {
  outcome: string;
  outcome_source: string | null;
  ended_kind: string | null;
  status_category: string;
}
async function after(key: string): Promise<After> {
  return (await database.query<After>(
    `select ws.outcome, ws.outcome_source, ws.ended_kind, e.status_category
       from public.work_sessions ws join public.entities e on e.id = ws.entity_id where ws.entity_id = $1`,
    [ids[key]],
  ))[0]!;
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('session-outcome-backfill-301');
  const chain = migrationFiles();
  const at = chain.indexOf(D1);
  expect(at, `${D1} is not in the chain`).toBeGreaterThan(0);
  database.apply(chain.slice(0, at));

  await asOwner(async (q) => {
    const f = (await q(`select internal.new_id()::text s, internal.new_id()::text m, internal.new_id()::text t`))[0]!;
    spaceId = f.s as string;
    memberId = f.m as string;
    teammateId = f.t as string;
    await q(`insert into public.user_profiles(identity_id,display_name) values('backfill-301','Owner')`);
    await q(`insert into public.spaces(id,name,created_by_identity) values($1,'Backfill','backfill-301')`, [spaceId]);
    await q(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by) values
       ($1,$3,'member',null,0,$1),($2,$3,'team_member',null,1,$1)`,
      [memberId, teammateId, spaceId],
    );
    await q(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name) values($1,$2,'backfill-301','owner','Owner')`,
      [memberId, spaceId],
    );
    await q(
      `insert into public.team_members(entity_id,owner_member_id,name,role,identity) values($1,$2,'Worker','','persona')`,
      [teammateId, memberId],
    );

    // Finished work, closed by the operator: posted within 30 min, task done.
    const doneTask = await task(q, 't-done', 'done');
    const finished = await historicSession(q, 'finished', { status: 'exited', endedKind: 'stopped_by_operator', exitedAgo: '2 hours' });
    await claim(q, finished, doneTask);
    await message(q, doneTask, '2 hours 10 minutes');

    // Abandoned: stopped with no close-out.
    const workingTask = await task(q, 't-working', 'working');
    const abandoned = await historicSession(q, 'abandoned', { status: 'exited', endedKind: 'stopped_by_operator', exitedAgo: '1 hour' });
    await claim(q, abandoned, workingTask);

    // Closed out, but its task is still working: stopped, not completed.
    const busyTask = await task(q, 't-busy', 'working');
    const unfinished = await historicSession(q, 'unfinished', { status: 'exited', endedKind: 'stopped_by_operator', exitedAgo: '1 hour' });
    await claim(q, unfinished, busyTask);
    await message(q, busyTask, '1 hour 5 minutes');

    // The pre-301 spelling of a clean exit, nothing posted.
    await historicSession(q, 'clean', { status: 'exited', endedKind: 'completed', exitedAgo: '3 hours' });

    // Crashes: recent stays open, old is put away.
    await historicSession(q, 'crash-recent', { status: 'failed', endedKind: 'crashed', exitedAgo: '1 day' });
    await historicSession(q, 'crash-old', { status: 'failed', endedKind: 'crashed', exitedAgo: '10 days' });

    // Credential containment recorded as an operator stop.
    await historicSession(q, 'contained', {
      status: 'exited',
      endedKind: 'stopped_by_operator',
      endedReason: 'Stopped because the credential it was running on was disconnected.',
      exitedAgo: '1 hour',
    });

    // Live, ticked to Done by an operator (156) — and live, unticked.
    const ticked = await historicSession(q, 'ticked', { status: 'running' });
    const doneState = (await q(`select internal.workflow_state_for_category($1,'done') s`, [ticked]))[0]!.s;
    await q(`update public.entities set status_id = $2 where id = $1`, [ticked, doneState]);
    const live = await historicSession(q, 'live', { status: 'running' });
    await claim(q, live, await task(q, 't-live', 'working'));
  });

  database.apply([D1]);
}, 240_000);

afterAll(async () => {
  await database?.destroy();
}, 30_000);

describe('301 backfill — outcomes (spec §8.3, §13.10)', () => {
  it('a stop with a close-out in its last 30 minutes and every task done is completed', async () => {
    expect(await after('finished')).toMatchObject({ outcome: 'completed', outcome_source: 'backfill', status_category: 'done' });
  });

  it('a stop without a close-out is stopped', async () => {
    expect(await after('abandoned')).toMatchObject({ outcome: 'stopped', outcome_source: 'backfill', status_category: 'cancelled' });
  });

  it('a close-out does not complete a session whose claimed task is still working', async () => {
    expect((await after('unfinished')).outcome).toBe('stopped');
  });

  it('`completed` is renamed exited_clean; with nothing posted it is stopped', async () => {
    expect(await after('clean')).toMatchObject({ ended_kind: 'exited_clean', outcome: 'stopped' });
  });

  it('a recent crash stays open and in_progress (it still needs someone)', async () => {
    expect(await after('crash-recent')).toMatchObject({ outcome: 'open', outcome_source: null, status_category: 'in_progress' });
  });

  it('a crash older than 7 days is stopped, so Interrupted is not flooded (§5.3.1 case 5)', async () => {
    expect(await after('crash-old')).toMatchObject({ outcome: 'stopped', outcome_source: 'backfill' });
  });

  it('a containment ending is re-classified credential_revoked and stays open', async () => {
    expect(await after('contained')).toMatchObject({ ended_kind: 'credential_revoked', outcome: 'open', status_category: 'in_progress' });
  });

  it('a live session an operator ticked to Done is completed; an unticked live one is open', async () => {
    expect(await after('ticked')).toMatchObject({ outcome: 'completed', status_category: 'done' });
    expect(await after('live')).toMatchObject({ outcome: 'open', status_category: 'in_progress' });
  });
});

describe('301 backfill — claims and categories', () => {
  it('every historical claim ends with backfill; an ended session’s at its exit, a live one’s at the migration', async () => {
    const rows = await database.query<{ src_id: string; end_reason: string | null; ended_at: string | null; exited_at: string | null }>(
      `select ed.src_id, ed.props->>'endReason' end_reason, ed.props->>'endedAt' ended_at, ws.exited_at::text exited_at
         from public.edges ed join public.work_sessions ws on ws.entity_id = ed.src_id
        where ed.type = 'working_on' and ed.space_id = $1`,
      [spaceId],
    );
    expect(rows.length).toBe(4);
    expect(rows.every((r) => r.end_reason === 'backfill' && r.ended_at !== null)).toBe(true);
    const finished = rows.find((r) => r.src_id === ids['finished'])!;
    expect(new Date(finished.ended_at!).getTime()).toBe(new Date(finished.exited_at!).getTime());
    const live = rows.find((r) => r.src_id === ids['live'])!;
    expect(Date.now() - new Date(live.ended_at!).getTime()).toBeLessThan(10 * 60_000);
  });

  it('every session is filed by the §3.2 table after the backfill', async () => {
    const rows = await database.query<{ n: string }>(
      `select count(*) n from public.entities e join public.work_sessions ws on ws.entity_id = e.id
        where e.status_category is distinct from internal.session_category(ws.outcome, ws.status)`,
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });
});
