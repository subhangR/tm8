/**
 * 218 — RLS membership is resolved once per statement, and admits exactly
 * what the per-row helpers admitted.
 *
 * 218 rewrote every policy that called `internal.is_space_member(X)` to
 * `X = any ((select internal.member_space_ids())::uuid[])`, `entities_select`
 * to the same array plus the carve-out, and every `internal.entity_readable(X)`
 * policy to an `exists (... offset 0)` over `public.entities` that
 * `entities_select` filters.
 * The helper functions themselves are unchanged (rls-predicate-guards covers
 * them); this file covers the POLICIES, which is where 218 moved the logic.
 *
 * Every visibility assertion is a red/green pair: the member sees the row AND
 * the outsider, the stranger and the unset claim do not. A policy that returned
 * false for everything would fail the green half; one that dropped the
 * membership test would fail the red half.
 *
 * The plan-shape case pins the reason 218 exists: the membership lookup must
 * be an InitPlan (once per statement), never a per-row helper call.
 */
import { randomUUID } from 'node:crypto';

import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createW1ScratchDatabase, migrationFiles, type W1ScratchDatabase } from './w1-pg.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const MEMBER_IDENTITY = 'rls218-member';
/** A member of a DIFFERENT space only. */
const OUTSIDER_IDENTITY = 'rls218-outsider';
/** A real identity with no membership at all. */
const STRANGER_IDENTITY = 'rls218-stranger';

interface Fixture {
  spaceId: string;
  otherSpaceId: string;
  memberId: string;
  outsiderMemberId: string;
  openDocId: string;
  restrictedDocId: string;
  deletedDocId: string;
  projectEntityId: string;
}

let database: W1ScratchDatabase;
let fixture: Fixture;

async function asOwner<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_graph_owner');
    return fn(client);
  });
}

/** `identity === null` leaves `tm8.identity_id` UNSET. */
async function asIdentity<T>(
  identity: string | null,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return database.transaction(async (client) => {
    await client.query('set local role tm8_app');
    if (identity !== null) {
      await client.query(`select set_config('tm8.identity_id', $1, true)`, [identity]);
    }
    await client.query(
      `select set_config('tm8.actor_id', '', true),
              set_config('tm8.node_admin', 'false', true),
              set_config('tm8.request_id', 'rls-membership-once-per-statement-pg', true)`,
    );
    return fn(client);
  });
}

async function ids(identity: string | null, sql: string, params: unknown[] = []): Promise<string[]> {
  return asIdentity(identity, async (client) => {
    const rows = await client.query<{ id: string }>(sql, params);
    return rows.rows.map((r) => r.id).sort();
  });
}

async function seed(): Promise<Fixture> {
  return asOwner(async (client) => {
    const row = (await client.query<{
      space_id: string;
      other_space_id: string;
      member_id: string;
      outsider_member_id: string;
      open_doc_id: string;
      restricted_doc_id: string;
      deleted_doc_id: string;
    }>(
      `select internal.new_id() space_id, internal.new_id() other_space_id,
              internal.new_id() member_id, internal.new_id() outsider_member_id,
              internal.new_id() open_doc_id, internal.new_id() restricted_doc_id,
              internal.new_id() deleted_doc_id`,
    )).rows[0]!;

    await client.query(
      `insert into public.user_profiles(identity_id, display_name)
       values ($1, '218 member'), ($2, '218 outsider'), ($3, '218 stranger')`,
      [MEMBER_IDENTITY, OUTSIDER_IDENTITY, STRANGER_IDENTITY],
    );
    await client.query(
      `insert into public.spaces(id, name, created_by_identity)
       values ($1, 'RLS 218', $3), ($2, 'RLS 218 elsewhere', $4)`,
      [row.space_id, row.other_space_id, MEMBER_IDENTITY, OUTSIDER_IDENTITY],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, position, created_by) values
       ($1, $3, 'member', 0, $1), ($2, $4, 'member', 0, $2)`,
      [row.member_id, row.outsider_member_id, row.space_id, row.other_space_id],
    );
    await client.query(
      `insert into public.members(entity_id, space_id, identity_id, role, display_name) values
       ($1, $3, $5, 'owner', '218 member'), ($2, $4, $6, 'owner', '218 outsider')`,
      [
        row.member_id,
        row.outsider_member_id,
        row.space_id,
        row.other_space_id,
        MEMBER_IDENTITY,
        OUTSIDER_IDENTITY,
      ],
    );
    await client.query(
      `insert into public.entities(id, space_id, kind, position, visibility, created_by) values
       ($1, $4, 'doc', 10, 'space',      $5),
       ($2, $4, 'doc', 11, 'restricted', $5),
       ($3, $4, 'doc', 12, 'space',      $5)`,
      [row.open_doc_id, row.restricted_doc_id, row.deleted_doc_id, row.space_id, row.member_id],
    );
    await client.query(
      `insert into public.documents(entity_id, title, body, format) values
       ($1, 'open', '', 'markdown'), ($2, 'restricted', '', 'markdown'),
       ($3, 'deleted', '', 'markdown')`,
      [row.open_doc_id, row.restricted_doc_id, row.deleted_doc_id],
    );
    await client.query(`update public.entities set deleted_at = now() where id = $1`, [
      row.deleted_doc_id,
    ]);

    // Linking a project mints a `restricted` projection visible ONLY through
    // the carve-out that 218 kept behind `internal.entity_row_visible`.
    const projectId = (await client.query<{ id: string }>('select internal.new_id() id')).rows[0]!.id;
    await client.query(
      `insert into public.projects(id, name, working_dir) values ($1, 'rls218-project', $2)`,
      [projectId, `/tmp/rls218-${randomUUID()}`],
    );
    await client.query(`insert into public.space_projects(space_id, project_id) values ($1, $2)`, [
      row.space_id,
      projectId,
    ]);
    const projectEntityId = (await client.query<{ project_entity_id: string }>(
      `select project_entity_id from public.project_links where space_id = $1 and project_id = $2`,
      [row.space_id, projectId],
    )).rows[0]!.project_entity_id;

    return {
      spaceId: row.space_id,
      otherSpaceId: row.other_space_id,
      memberId: row.member_id,
      outsiderMemberId: row.outsider_member_id,
      openDocId: row.open_doc_id,
      restrictedDocId: row.restricted_doc_id,
      deletedDocId: row.deleted_doc_id,
      projectEntityId,
    };
  });
}

beforeAll(async () => {
  database = await createW1ScratchDatabase('rls_membership_218');
  database.apply(migrationFiles());
  fixture = await seed();
});

afterAll(async () => {
  await database?.destroy();
});

describe('member_space_ids — the array every rewritten policy reads', () => {
  it('is the caller\'s own spaces, and empty (never NULL) for a stranger or an unset claim', async () => {
    const spaces = async (identity: string | null) =>
      asIdentity(identity, async (client) =>
        (await client.query<{ s: string[] }>('select internal.member_space_ids() s')).rows[0]!.s,
      );
    expect(await spaces(MEMBER_IDENTITY)).toEqual([fixture.spaceId]);
    expect(await spaces(OUTSIDER_IDENTITY)).toEqual([fixture.otherSpaceId]);
    expect(await spaces(STRANGER_IDENTITY)).toEqual([]);
    expect(await spaces(null)).toEqual([]);
  });
});

describe('members_select (was is_space_member per row)', () => {
  const sql = 'select entity_id::text id from public.members where space_id = any($1::uuid[])';

  it('shows each identity exactly its own space\'s members', async () => {
    const both = [[fixture.spaceId, fixture.otherSpaceId]];
    expect(await ids(MEMBER_IDENTITY, sql, both)).toEqual([fixture.memberId]);
    expect(await ids(OUTSIDER_IDENTITY, sql, both)).toEqual([fixture.outsiderMemberId]);
    expect(await ids(STRANGER_IDENTITY, sql, both)).toEqual([]);
    expect(await ids(null, sql, both)).toEqual([]);
  });
});

describe('entities_select (membership array + carve-out)', () => {
  const sql = 'select id::text id from public.entities where space_id = $1';

  it('admits space-visible rows, the tombstone and the carved-out project to the member only', async () => {
    const visible = await ids(MEMBER_IDENTITY, sql, [fixture.spaceId]);
    expect(visible).toContain(fixture.openDocId);
    expect(visible).toContain(fixture.deletedDocId); // 070: no tombstone filter here
    expect(visible).toContain(fixture.memberId);
    expect(visible).toContain(fixture.projectEntityId); // the carve-out
    expect(visible).not.toContain(fixture.restrictedDocId); // restricted, not a project
    for (const outsider of [OUTSIDER_IDENTITY, STRANGER_IDENTITY, null]) {
      expect(await ids(outsider, sql, [fixture.spaceId])).toEqual([]);
    }
  });
});

describe('entity_readable policies (now an exists over entities_select)', () => {
  const sql = 'select entity_id::text id from public.documents where entity_id = any($1::uuid[])';

  it('admits the live space-visible doc, never the tombstone or the restricted doc', async () => {
    const all = [[fixture.openDocId, fixture.restrictedDocId, fixture.deletedDocId]];
    expect(await ids(MEMBER_IDENTITY, sql, all)).toEqual([fixture.openDocId]);
    expect(await ids(OUTSIDER_IDENTITY, sql, all)).toEqual([]);
    expect(await ids(STRANGER_IDENTITY, sql, all)).toEqual([]);
    expect(await ids(null, sql, all)).toEqual([]);
  });
});

describe('the reason 218 exists', () => {
  it('no policy calls a per-row membership helper any more', async () => {
    const rows = await database.query<{ line: string }>(
      `select tablename || '.' || policyname line from pg_policies
        where coalesce(qual, '') || coalesce(with_check, '') ~ '(is_space_member|entity_readable)\\('`,
    );
    expect(rows.map((r) => r.line)).toEqual([]);
    // Green half: the rewritten shape is actually present.
    const [members] = await database.query<{ qual: string }>(
      `select qual from pg_policies where tablename = 'members' and policyname = 'members_select'`,
    );
    expect(members!.qual).toContain('member_space_ids()');
  });

  it('resolves membership as an InitPlan, not as a per-row function call', async () => {
    const plan = await asIdentity(MEMBER_IDENTITY, async (client) => {
      const rows = await client.query<{ 'QUERY PLAN': string }>(
        'explain (costs off, verbose) select count(*) from public.members',
      );
      return rows.rows.map((r) => r['QUERY PLAN']).join('\n');
    });
    expect(plan).toMatch(/InitPlan/);
    expect(plan).toContain('member_space_ids()');
    expect(plan).not.toContain('is_space_member');
  });
});
