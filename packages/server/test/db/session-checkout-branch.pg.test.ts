/**
 * 107 — the session lane fact, proved against a REAL PostgreSQL.
 *
 * What only Postgres can prove here: `security definer` + the membership
 * gate, the version-bump-only-on-change contract (an UPDATE on one table
 * observed as a version change on another), and the NULL-collapse of
 * whitespace — all plpgsql semantics a FakeDb has none of.
 *
 * The claims, matching the migration header one for one:
 *   · a member records a branch; the row updates and `entities.version`
 *     moves by exactly one, `activity_at` by exactly zero;
 *   · re-recording the SAME branch answers false and moves nothing — the
 *     opportunistic refresh must be a no-op to every consumer;
 *   · empty/whitespace collapses to NULL (a detached HEAD prints an empty
 *     line, and an empty-string "branch" would render a claim about nothing);
 *   · a non-member is refused with 42501, same gate as every session door.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

interface Fixture {
  memberIdentity: string;
  strangerIdentity: string;
  space: string;
  member: string;
  session: string;
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
              set_config('tm8.request_id', 'req-107-pg', true),
              set_config('tm8.auth_kind', 'browser', true)`,
      [identity],
    );
    return fn(client);
  });
}

async function entityFacts(): Promise<{ version: number; activityAt: string; branch: string | null }> {
  const [row] = await database.query<{ version: number; activity_at: string; checkout_branch: string | null }>(
    `select e.version, e.activity_at::text as activity_at, ws.checkout_branch
       from public.entities e join public.work_sessions ws on ws.entity_id = e.id
      where e.id = $1`,
    [fixture.session],
  );
  return { version: Number(row!.version), activityAt: row!.activity_at, branch: row!.checkout_branch };
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('lane_107');
  database.apply(migrationFiles());
  fixture = await database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    const ids = (
      await client.query<Omit<Fixture, never>>(
        `select 'lane-member'::text "memberIdentity", 'lane-stranger'::text "strangerIdentity",
                internal.new_id()::text "space", internal.new_id()::text "member",
                internal.new_id()::text "session"`,
      )
    ).rows[0]!;
    await client.query(
      `insert into public.user_profiles(identity_id, display_name)
       values ($1, 'Member'), ($2, 'Stranger')`,
      [ids.memberIdentity, ids.strangerIdentity],
    );
    await client.query(
      `insert into public.accounts(identity_id, username, display_name, is_node_admin, is_owner)
       values ($1, 'lane-member', 'Member', false, true),
              ($2, 'lane-stranger', 'Stranger', false, false)`,
      [ids.memberIdentity, ids.strangerIdentity],
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity) values ($1, 'Lane', $2)`,
      [ids.space, ids.memberIdentity],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, position, created_by)
       values ($2, $1, 'member', 0, $2), ($3, $1, 'work_session', 1, $2)`,
      [ids.space, ids.member, ids.session],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name)
       values ($1, $2, $3, 'owner', 'Member')`,
      [ids.member, ids.space, ids.memberIdentity],
    );
    await client.query(
      `insert into public.work_sessions(entity_id, title, status, workdir_mode)
       values ($1, 'Lane session', 'running', 'project')`,
      [ids.session],
    );
    return ids;
  });
}, 300_000);

afterAll(async () => {
  await database?.destroy();
});

describe('107 — schema and function shape', () => {
  it('adds checkout_branch as a NULLABLE column with no default — NULL is the honest zero', async () => {
    const [column] = await database.query<{ is_nullable: string; column_default: string | null }>(
      `select is_nullable, column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'work_sessions'
          and column_name = 'checkout_branch'`,
    );
    expect(column).toBeDefined();
    expect(column!.is_nullable).toBe('YES');
    expect(column!.column_default).toBeNull();
  });

  it('execution_record_checkout_branch is security definer, granted to tm8_app', async () => {
    const [fn] = await database.query<{ prosecdef: boolean }>(
      `select p.prosecdef from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'execution_record_checkout_branch'`,
    );
    expect(fn).toBeDefined();
    expect(fn!.prosecdef).toBe(true);
  });
});

describe('107 — the recording contract', () => {
  it('records a branch: row updated, version +1, activity_at untouched', async () => {
    const before = await entityFacts();
    const changed = await asApp(fixture.memberIdentity, async (client) =>
      (await client.query<{ changed: boolean }>(
        `select public.execution_record_checkout_branch($1, 'feat/session-lane-facts') as changed`,
        [fixture.session],
      )).rows[0]!.changed,
    );
    const after = await entityFacts();
    expect(changed).toBe(true);
    expect(after.branch).toBe('feat/session-lane-facts');
    expect(after.version).toBe(before.version + 1);
    // A passive fact refresh is not activity — it must not reorder lists.
    expect(after.activityAt).toBe(before.activityAt);
  });

  it('re-recording the SAME branch answers false and bumps nothing', async () => {
    const before = await entityFacts();
    const changed = await asApp(fixture.memberIdentity, async (client) =>
      (await client.query<{ changed: boolean }>(
        `select public.execution_record_checkout_branch($1, 'feat/session-lane-facts') as changed`,
        [fixture.session],
      )).rows[0]!.changed,
    );
    const after = await entityFacts();
    expect(changed).toBe(false);
    expect(after.version).toBe(before.version);
  });

  it('collapses whitespace to NULL — a detached HEAD is not a branch named ""', async () => {
    const before = await entityFacts();
    const changed = await asApp(fixture.memberIdentity, async (client) =>
      (await client.query<{ changed: boolean }>(
        `select public.execution_record_checkout_branch($1, '   ') as changed`,
        [fixture.session],
      )).rows[0]!.changed,
    );
    const after = await entityFacts();
    // A real branch was stored above, so clearing it IS a change.
    expect(changed).toBe(true);
    expect(after.branch).toBeNull();
    expect(after.version).toBe(before.version + 1);
  });

  it('refuses a non-member with 42501 — the same gate as every session door', async () => {
    let caught: unknown;
    try {
      await asApp(fixture.strangerIdentity, async (client) =>
        client.query(
          `select public.execution_record_checkout_branch($1, 'feat/steal')`,
          [fixture.session],
        ),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught, 'expected a refusal, the statement succeeded').toBeDefined();
    expect(sqlstate(caught)).toBe('42501');
  });
});
