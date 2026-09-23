/**
 * 201 — `jev_runs` / `jev_calls`, proved against a REAL PostgreSQL.
 *
 * What only Postgres can prove: the RLS policies, the grants to the role the
 * facade actually runs as (`tm8_app`), the column default that stamps the
 * caller's identity, and the unique constraint that makes a retried
 * `requestId` never double-count a Jev call.
 *
 * The claims, matching the migration header:
 *   · both tables exist with RLS on, and `jev_calls` is unique on
 *     (run_id, request_id, grp, chunk);
 *   · a member writes a run in their space — `requested_by` defaults to them —
 *     and reads that space's runs and calls;
 *   · a non-member reads nothing, and can write nothing into that space or
 *     into that member's run;
 *   · nobody writes a run as someone else, and the app role cannot delete.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

interface Fixture {
  memberIdentity: string;
  strangerIdentity: string;
  space: string;
  otherSpace: string;
  member: string;
  stranger: string;
  subject: string;
  session: string;
  run: string;
  request: string;
}

function sqlstate(error: unknown): string {
  return (error as { code?: string }).code ?? `no-sqlstate: ${String(error)}`;
}

let database: W1ScratchDatabase;
let fixture: Fixture;

async function asApp<T>(
  identity: string,
  fn: (client: import('pg').PoolClient) => Promise<T>,
): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    await client.query(
      `select set_config('tm8.identity_id', $1, true),
              set_config('tm8.actor_id', '', true),
              set_config('tm8.node_admin', 'false', true),
              set_config('tm8.request_id', 'req-201-pg', true),
              set_config('tm8.auth_kind', 'browser', true)`,
      [identity],
    );
    return fn(client);
  });
}

async function refusal(identity: string, sql: string, params: unknown[]): Promise<string> {
  try {
    await asApp(identity, (client) => client.query(sql, params));
  } catch (error) {
    return sqlstate(error);
  }
  return 'succeeded';
}

const INSERT_CALL = `insert into public.jev_calls
  (run_id, request_id, grp, chunk, jev_model, input_tokens, output_tokens, cost_usd, latency_ms, outcome)
  values ($1, $2, $3, $4, 'jev-1.13.0', 1200, 40, 0.0000504, 380, $5)`;

beforeAll(async () => {
  database = await createW1ScratchDatabase('jev_runs_201');
  database.apply(migrationFiles());
  fixture = await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const ids = (
      await client.query<Fixture>(
        `select 'jev-member'::text "memberIdentity", 'jev-stranger'::text "strangerIdentity",
                internal.new_id()::text "space", internal.new_id()::text "otherSpace",
                internal.new_id()::text "member", internal.new_id()::text "stranger",
                internal.new_id()::text "subject", internal.new_id()::text "session",
                gen_random_uuid()::text "run", gen_random_uuid()::text "request"`,
      )
    ).rows[0]!;
    await client.query(
      `insert into public.user_profiles(identity_id, display_name)
       values ($1, 'Member'), ($2, 'Stranger')`,
      [ids.memberIdentity, ids.strangerIdentity],
    );
    await client.query(
      `insert into public.accounts(identity_id, username, display_name, is_node_admin, is_owner)
       values ($1, 'jev-member', 'Member', false, true),
              ($2, 'jev-stranger', 'Stranger', false, false)`,
      [ids.memberIdentity, ids.strangerIdentity],
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity)
       values ($1, 'Jev', $3), ($2, 'Elsewhere', $4)`,
      [ids.space, ids.otherSpace, ids.memberIdentity, ids.strangerIdentity],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, position, created_by)
       values ($2, $1, 'member', 0, $2),
              ($3, $1, 'work_session', 1, $2),
              ($4, $1, 'work_session', 2, $2),
              ($6, $5, 'member', 0, $6)`,
      [ids.space, ids.member, ids.subject, ids.session, ids.otherSpace, ids.stranger],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1, $2, $3, 'owner', 'Member'), ($4, $5, $6, 'owner', 'Stranger')`,
      [ids.member, ids.space, ids.memberIdentity, ids.stranger, ids.otherSpace, ids.strangerIdentity],
    );
    await client.query(
      `insert into public.work_sessions(entity_id, title, status, workdir_mode)
       values ($1, 'Subject session', 'running', 'project'),
              ($2, 'Launched session', 'running', 'project')`,
      [ids.subject, ids.session],
    );
    return ids;
  });
}, 300_000);

afterAll(async () => {
  await database?.destroy();
});

describe('201 — schema', () => {
  it('creates both tables with row level security on', async () => {
    const rows = await database.query<{ relname: string; relrowsecurity: boolean }>(
      `select relname, relrowsecurity from pg_class
        where oid in ('public.jev_runs'::regclass, 'public.jev_calls'::regclass)
        order by relname`,
    );
    expect(rows).toEqual([
      { relname: 'jev_calls', relrowsecurity: true },
      { relname: 'jev_runs', relrowsecurity: true },
    ]);
  });

  it('keys jev_calls uniquely on (run_id, request_id, grp, chunk)', async () => {
    const [constraint] = await database.query<{ columns: string[] }>(
      `select array_agg(a.attname order by k.ord)::text[] as columns
         from pg_constraint c
         cross join lateral unnest(c.conkey) with ordinality as k(attnum, ord)
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
        where c.conrelid = 'public.jev_calls'::regclass and c.contype = 'u'
        group by c.oid`,
    );
    expect(constraint?.columns).toEqual(['run_id', 'request_id', 'grp', 'chunk']);
  });

  it('grants tm8_app exactly what the handler needs, and no delete', async () => {
    const [grants] = await database.query<Record<string, boolean>>(
      `select has_table_privilege('tm8_app', 'public.jev_runs', 'select') runs_select,
              has_table_privilege('tm8_app', 'public.jev_runs', 'insert') runs_insert,
              has_table_privilege('tm8_app', 'public.jev_runs', 'update') runs_update,
              has_table_privilege('tm8_app', 'public.jev_runs', 'delete') runs_delete,
              has_table_privilege('tm8_app', 'public.jev_calls', 'select') calls_select,
              has_table_privilege('tm8_app', 'public.jev_calls', 'insert') calls_insert,
              has_table_privilege('tm8_app', 'public.jev_calls', 'update') calls_update,
              has_table_privilege('tm8_app', 'public.jev_calls', 'delete') calls_delete`,
    );
    expect(grants).toEqual({
      runs_select: true, runs_insert: true, runs_update: true, runs_delete: false,
      calls_select: true, calls_insert: true, calls_update: false, calls_delete: false,
    });
  });
});

describe('201 — a member records and reads the cost of a run', () => {
  it('writes a run, stamping requested_by with the caller', async () => {
    const run = await asApp(fixture.memberIdentity, async (client) => {
      await client.query(
        `insert into public.jev_runs(id, space_id, subject_id) values ($1, $2, $3)`,
        [fixture.run, fixture.space, fixture.subject],
      );
      await client.query(INSERT_CALL, [fixture.run, fixture.request, 'model', 0, 'ok']);
      await client.query(INSERT_CALL, [fixture.run, fixture.request, 'skills', 0, 'ok']);
      // Failures are costed too — one row per HTTP call, whatever it answered.
      await client.query(INSERT_CALL, [fixture.run, fixture.request, 'skills', 1, 'timeout']);
      return (await client.query<{ requested_by: string }>(
        `select requested_by from public.jev_runs where id = $1`, [fixture.run],
      )).rows[0];
    });
    expect(run?.requested_by).toBe(fixture.memberIdentity);
  });

  it('never double-counts a retried request', async () => {
    const duplicate = await refusal(fixture.memberIdentity, INSERT_CALL, [
      fixture.run, fixture.request, 'model', 0, 'ok',
    ]);
    expect(duplicate).toBe('23505');
    const inserted = await asApp(fixture.memberIdentity, async (client) =>
      (await client.query(`${INSERT_CALL} on conflict do nothing`, [
        fixture.run, fixture.request, 'model', 0, 'ok',
      ])).rowCount,
    );
    expect(inserted).toBe(0);
  });

  it('reads its space\'s runs and calls, and sums a run', async () => {
    const seen = await asApp(fixture.memberIdentity, async (client) => ({
      runs: (await client.query(`select id from public.jev_runs`)).rows.map((r) => r.id as string),
      calls: Number((await client.query<{ n: string }>(
        `select count(*) n from public.jev_calls where run_id = $1`, [fixture.run],
      )).rows[0]!.n),
      usd: (await client.query<{ usd: string }>(
        `select sum(cost_usd)::text usd from public.jev_calls where run_id = $1`, [fixture.run],
      )).rows[0]!.usd,
    }));
    expect(seen.runs).toEqual([fixture.run]);
    expect(seen.calls).toBe(3);
    expect(Number(seen.usd)).toBeCloseTo(3 * 0.0000504, 10);
  });

  it('links the launched session to the run', async () => {
    const updated = await asApp(fixture.memberIdentity, async (client) =>
      (await client.query(
        `update public.jev_runs set session_id = $2 where id = $1`, [fixture.run, fixture.session],
      )).rowCount,
    );
    expect(updated).toBe(1);
    const [row] = await database.query<{ session_id: string }>(
      `select session_id from public.jev_runs where id = $1`, [fixture.run],
    );
    expect(row?.session_id).toBe(fixture.session);
  });
});

describe('201 — a non-member sees and writes nothing', () => {
  it('reads no runs and no calls', async () => {
    const seen = await asApp(fixture.strangerIdentity, async (client) => ({
      runs: (await client.query(`select id from public.jev_runs`)).rowCount,
      calls: (await client.query(`select id from public.jev_calls`)).rowCount,
    }));
    expect(seen).toEqual({ runs: 0, calls: 0 });
  });

  it('cannot open a run in a space it is not a member of', async () => {
    expect(await refusal(
      fixture.strangerIdentity,
      `insert into public.jev_runs(id, space_id, subject_id) values (gen_random_uuid(), $1, $2)`,
      [fixture.space, fixture.subject],
    )).toBe('42501');
  });

  it('cannot add a call to someone else\'s run', async () => {
    expect(await refusal(fixture.strangerIdentity, INSERT_CALL, [
      fixture.run, fixture.request, 'teammates', 0, 'ok',
    ])).toBe('42501');
  });

  it('cannot relink someone else\'s run — the update matches nothing', async () => {
    const updated = await asApp(fixture.strangerIdentity, async (client) =>
      (await client.query(`update public.jev_runs set session_id = null where id = $1`, [fixture.run])).rowCount,
    );
    expect(updated).toBe(0);
  });
});

describe('201 — nobody writes as someone else', () => {
  it('refuses a member writing a run with another identity as requested_by', async () => {
    expect(await refusal(
      fixture.memberIdentity,
      `insert into public.jev_runs(id, space_id, subject_id, requested_by)
       values (gen_random_uuid(), $1, $2, $3)`,
      [fixture.space, fixture.subject, fixture.strangerIdentity],
    )).toBe('42501');
  });

  it('refuses handing a run to another requester on update', async () => {
    expect(await refusal(
      fixture.memberIdentity,
      `update public.jev_runs set requested_by = $2 where id = $1`,
      [fixture.run, fixture.strangerIdentity],
    )).toBe('42501');
  });

  it('refuses delete to the app role', async () => {
    expect(await refusal(
      fixture.memberIdentity, `delete from public.jev_calls where run_id = $1`, [fixture.run],
    )).toBe('42501');
  });
});
