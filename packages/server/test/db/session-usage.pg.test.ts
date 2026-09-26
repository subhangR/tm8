/**
 * 185 against a real Postgres: THE USAGE INSTRUMENT IS A SEPARATE WRITER, AND
 * A SURVIVOR.
 *
 * ## What only a real database can check
 *
 * Three things 185 promises are triggers and grants, not TypeScript:
 *
 *   1. `record_work_session_usage` writes the three usage columns WITHOUT
 *      going through `work_session_transition` — 001's status guard is
 *      `before update of status` only, so a non-status write must pass it.
 *      If someone later widens that guard to every column, this goes red
 *      before the exit hook starts failing silently in production.
 *   2. The write bumps `entities.version`, which is how the summary state
 *      and the event feed learn a fact changed (107's rule).
 *   3. A RESPAWN clears the ending facts (171's clear_ending_on_respawn) and
 *      must NOT clear usage: the conversation's spend so far is still true
 *      after the session comes back, because the native transcript is
 *      write-once (062:9) and accumulates.
 *
 * ## The privilege pin
 *
 * 062, 107 and 171 all carry the same `revoke all ... from public; grant
 * execute ... to tm8_app` pair, and the class of defect it guards against is
 * a function that PUBLIC — including tm8_delivery_worker — can execute. The
 * pin is `has_function_privilege`, from both sides.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

interface Fixture {
  identityId: string;
  outsiderId: string;
  spaceId: string;
  memberId: string;
}

let database: W1ScratchDatabase;
let fixture: Fixture;

let unique = 0;
function cmid(label: string): string {
  unique += 1;
  return `session-usage-185-${label}-${unique}`;
}

type Q = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

async function asOwner<T>(fn: (q: Q) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(async (sql, params = []) => (await client.query(sql, params)).rows as Record<string, unknown>[]);
  });
}

async function asApp<T>(identityId: string, fn: (q: Q) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id',$1,true),set_config('tm8.actor_id','',true),
              set_config('tm8.node_admin','false',true),set_config('tm8.request_id','req-185',true)`,
      [identityId],
    );
    return fn(async (sql, params = []) => (await client.query(sql, params)).rows as Record<string, unknown>[]);
  });
}

async function seed(db: W1ScratchDatabase): Promise<Fixture> {
  return db.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const f = (
      await client.query<Fixture>(
        `select 'session-usage-185-owner'::text "identityId",
                'session-usage-185-outsider'::text "outsiderId",
                internal.new_id()::text "spaceId",
                internal.new_id()::text "memberId"`,
      )
    ).rows[0]!;
    await client.query(
      `insert into public.user_profiles(identity_id,display_name) values($1,'Session owner'),($2,'Outsider')`,
      [f.identityId, f.outsiderId],
    );
    await client.query(
      `insert into public.spaces(id,name,created_by_identity) values($1,'Sessions',$2)`,
      [f.spaceId, f.identityId],
    );
    await client.query(
      `insert into public.entities(id,space_id,kind,parent_id,position,created_by)
       values($1,$2,'member',null,0,$1)`,
      [f.memberId, f.spaceId],
    );
    await client.query(
      `insert into public.members(entity_id,space_id,identity_id,role,display_name)
       values($1,$2,$3,'owner','Session owner')`,
      [f.memberId, f.spaceId, f.identityId],
    );
    return f;
  });
}

/** 155's own fixture shape: envelope, then the detail row born `spawning`. */
async function createSession(title = 'A run'): Promise<string> {
  const rows = await asOwner(async (q) => {
    const created = await q(
      `insert into public.entities(space_id,kind,parent_id,position,created_by)
       values($1,'work_session',null,0,$2) returning id`,
      [fixture.spaceId, fixture.memberId],
    );
    const id = created[0]!.id as string;
    await q(`insert into public.work_sessions(entity_id,title,status, workdir_mode) values($1,$2,'spawning', 'scratch')`, [id, title]);
    return created;
  });
  return rows[0]!.id as string;
}

async function transition(sessionId: string, status: string, endedKind: string | null = null): Promise<void> {
  await asApp(fixture.identityId, (q) =>
    q(`select public.work_session_transition($1,$2,null,null,null,$3,$4,$5)`,
      [sessionId, status, cmid(status), endedKind, endedKind ? 'Finished on its own.' : null]),
  );
}

const USAGE = {
  schemaVersion: 1,
  agentTool: 'claude-code',
  transcript: { messages: 104, turns: 90, totals: { cacheReadTokens: 30_060_576 }, compactions: 1 },
  harness: { costSource: 'claude_cost_state', costUsd: 141.59 },
};

async function readRow(sessionId: string): Promise<Record<string, unknown>> {
  const rows = await asOwner((q) =>
    q(
      `select ws.usage, ws.usage_source, ws.usage_recorded_at, ws.ended_kind, ws.status, e.version
         from public.work_sessions ws join public.entities e on e.id = ws.entity_id
        where ws.entity_id = $1`,
      [sessionId],
    ),
  );
  return rows[0]!;
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('session-usage-185');
  database.apply(migrationFiles());
  fixture = await seed(database);
});

afterAll(async () => {
  await database?.destroy();
});

describe('185 — record_work_session_usage', () => {
  it('writes the three columns together, stamps the time, and bumps entities.version', async () => {
    const id = await createSession();
    await transition(id, 'running');
    await transition(id, 'exited', 'completed');
    const before = await readRow(id);
    expect(before.usage).toBeNull();
    expect(before.usage_source).toBeNull();
    expect(before.usage_recorded_at).toBeNull();

    const stored = await asApp(fixture.identityId, (q) =>
      q(`select public.record_work_session_usage($1,$2::jsonb,$3) as stored`,
        [id, JSON.stringify(USAGE), 'claude_transcript']),
    );
    expect(stored[0]!.stored).toBe(true);

    const after = await readRow(id);
    expect(after.usage).toEqual(USAGE);
    expect(after.usage_source).toBe('claude_transcript');
    expect(after.usage_recorded_at).not.toBeNull();
    expect(Number(after.version)).toBe(Number(before.version) + 1);
    // The ending it was written after is untouched: this is a different fact.
    expect(after.ended_kind).toBe('completed');
    expect(after.status).toBe('exited');
  });

  it('a later read OVERWRITES — the exit paths re-read a cumulative file', async () => {
    const id = await createSession();
    await transition(id, 'running');
    await transition(id, 'exited', 'completed');
    await asApp(fixture.identityId, (q) =>
      q(`select public.record_work_session_usage($1,$2::jsonb,$3)`,
        [id, JSON.stringify({ ...USAGE, transcript: { messages: 10 } }), 'claude_transcript']),
    );
    await asApp(fixture.identityId, (q) =>
      q(`select public.record_work_session_usage($1,$2::jsonb,$3)`,
        [id, JSON.stringify({ ...USAGE, transcript: { messages: 104 } }), 'claude_transcript']),
    );
    const row = await readRow(id);
    expect((row.usage as { transcript: { messages: number } }).transcript.messages).toBe(104);
  });

  it('survives a respawn while the ending facts are cleared (171 clears endings, not spend)', async () => {
    const id = await createSession();
    await transition(id, 'running');
    await transition(id, 'exited', 'completed');
    await asApp(fixture.identityId, (q) =>
      q(`select public.record_work_session_usage($1,$2::jsonb,$3)`,
        [id, JSON.stringify(USAGE), 'claude_transcript']),
    );
    expect((await readRow(id)).ended_kind).toBe('completed');

    // The single-writer claim is what execution_resume sets before it moves
    // the row back to 'spawning'; setting it here exercises exactly the
    // trigger chain a resume runs, without a persona or a concurrency cap.
    await asOwner(async (q) => {
      await q(`select set_config('tm8.work_session_transition','on',true)`);
      await q(`update public.work_sessions set status = 'spawning' where entity_id = $1`, [id]);
    });

    const row = await readRow(id);
    expect(row.status).toBe('spawning');
    expect(row.ended_kind).toBeNull();
    expect(row.usage).toEqual(USAGE);
    expect(row.usage_source).toBe('claude_transcript');
  });

  it('refuses a source outside the vocabulary and a non-object document with 22023', async () => {
    const id = await createSession();
    await expect(
      asApp(fixture.identityId, (q) =>
        q(`select public.record_work_session_usage($1,$2::jsonb,$3)`, [id, JSON.stringify(USAGE), 'c1_usage_item'])),
    ).rejects.toMatchObject({ code: '22023' });
    await expect(
      asApp(fixture.identityId, (q) =>
        q(`select public.record_work_session_usage($1,$2::jsonb,$3)`, [id, '[1,2]', 'claude_transcript'])),
    ).rejects.toMatchObject({ code: '22023' });
    await expect(
      asApp(fixture.identityId, (q) =>
        q(`select public.record_work_session_usage($1,null,$2)`, [id, 'claude_transcript'])),
    ).rejects.toMatchObject({ code: '22023' });
    expect((await readRow(id)).usage).toBeNull();
  });

  it('refuses a non-member with 42501 and a missing session as not found', async () => {
    const id = await createSession();
    await expect(
      asApp(fixture.outsiderId, (q) =>
        q(`select public.record_work_session_usage($1,$2::jsonb,$3)`, [id, JSON.stringify(USAGE), 'claude_transcript'])),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asApp(fixture.identityId, (q) =>
        q(`select public.record_work_session_usage(internal.new_id(),$1::jsonb,$2)`,
          [JSON.stringify(USAGE), 'claude_transcript'])),
    ).rejects.toThrow();
  });

  it('the columns hold together: a document with no source, or a source with no document, is refused', async () => {
    const id = await createSession();
    await expect(
      asOwner((q) => q(`update public.work_sessions set usage = '{}'::jsonb where entity_id = $1`, [id])),
    ).rejects.toMatchObject({ code: '23514' });
    await expect(
      asOwner((q) => q(`update public.work_sessions set usage_source = 'codex_rollout' where entity_id = $1`, [id])),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('is executable by tm8_app and by nobody else — the 062/107/171 grant pair', async () => {
    const rows = await asOwner((q) =>
      q(`select has_function_privilege('tm8_app', 'public.record_work_session_usage(uuid,jsonb,text)', 'execute') as app,
                has_function_privilege('tm8_delivery_worker', 'public.record_work_session_usage(uuid,jsonb,text)', 'execute') as delivery,
                has_function_privilege('public', 'public.record_work_session_usage(uuid,jsonb,text)', 'execute') as anyone`),
    );
    expect(rows[0]).toEqual({ app: true, delivery: false, anyone: false });
  });

  it('does NOT widen work_session_transition — the 8-arg signature is still the only one', async () => {
    const rows = await asOwner((q) =>
      q(`select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = 'work_session_transition'`),
    );
    expect(rows[0]!.n).toBe(1);
  });
});
